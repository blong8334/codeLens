import { MarkerType, type Edge, type Node } from '@xyflow/react';
import { GROUP_KIND_FOR_LOD, isBreaking, isChanged, type FnNode, type Group, type Index, type Lod, type Selection, type Sink } from './data.ts';

/**
 * The impact map: one focus function in the middle, upstream callers in columns to the left,
 * downstream callees to the right, external effects at the far right. Detail falls off with
 * distance (fisheye): near hops show one level finer than far hops, and anything beyond the
 * column cap folds into a "+N more" bundle.
 */

export const MAX_HOPS = 4;
export const COLUMN_CAP = 6;

export const SIZE = {
  colWidth: 260,
  colGap: 90,
  rowGap: 16,
  focus: { w: 320, h: 270 },
  fn: { h: 112 },
  group: { h: 116 },
  bundle: { h: 76 },
  sink: { h: 84 },
};

export interface MapItem {
  id: string;
  kind: 'fn' | 'group' | 'bundle' | 'sink';
  /** Signed column: negative = upstream, 0 = focus, positive = downstream. */
  col: number;
  fnIds: string[];
  fn?: FnNode;
  group?: Group;
  sink?: Sink;
  hidden?: MapItem[];
  score: number;
}

export interface MapView {
  nodes: Node[];
  edges: Edge[];
  /** Item each function is drawn inside (fn id → item id), for highlighting from the panel. */
  itemOf: Map<string, string>;
  stats: { upstream: number; downstream: number; hiddenHops: boolean };
}

/** Signed hop distance from the focus: callers negative, callees positive. */
export function hopsFrom(ix: Index, focus: string, maxHops = MAX_HOPS) {
  const hop = new Map<string, number>([[focus, 0]]);
  let deeper = false;
  const walk = (dir: -1 | 1) => {
    let frontier = [focus];
    for (let d = 1; frontier.length; d++) {
      const next: string[] = [];
      for (const id of frontier) {
        const edges = dir < 0 ? ix.callers.get(id) : ix.callees.get(id);
        for (const e of edges ?? []) {
          const other = dir < 0 ? e.source : e.target;
          if (hop.has(other)) continue;
          if (d > maxHops) {
            deeper = true;
            continue;
          }
          hop.set(other, dir * d);
          next.push(other);
        }
      }
      frontier = next;
    }
  };
  walk(-1);
  walk(1);
  return { hop, deeper };
}

export function buildMap(
  ix: Index,
  focus: string,
  lod: Lod,
  expandedGroups: Set<string>,
  expandedCols: Set<number>,
  selection: Selection,
  /** Most cards to draw in total; 0 = no limit at all. */
  budget = 0,
): MapView {
  const { hop, deeper } = hopsFrom(ix, focus);

  // ---- 1. Fold functions into items according to distance and level of detail ----
  const items = new Map<string, MapItem>();
  const itemOfFn = new Map<string, string>();
  for (const [id, h] of hop) {
    const fn = ix.fns.get(id)!;
    let level = id === focus ? 0 : Math.abs(h) <= 1 ? Math.max(0, lod - 1) : lod;
    let gid = groupAt(fn, level);
    while (gid && expandedGroups.has(gid)) {
      level--;
      gid = groupAt(fn, level);
    }
    const itemId = gid ? `${gid}|${Math.sign(h)}` : id;
    let item = items.get(itemId);
    if (!item) {
      item = gid
        ? { id: itemId, kind: 'group', col: h, fnIds: [], group: ix.groups.get(gid)!, score: 0 }
        : { id: itemId, kind: 'fn', col: h, fnIds: [], fn, score: 0 };
      items.set(itemId, item);
    }
    item.fnIds.push(id);
    if (Math.abs(h) < Math.abs(item.col)) item.col = h;
    itemOfFn.set(id, itemId);
  }
  for (const item of items.values()) item.score = importance(ix, item);

  // ---- 2. Columns, capped, overflow into a bundle ----
  const columns = new Map<number, MapItem[]>();
  for (const item of items.values()) (columns.get(item.col) ?? columns.set(item.col, []).get(item.col)!).push(item);
  const itemRemap = new Map<string, string>();
  // Share the card budget between the columns around the focus.
  const sideCols = Math.max(1, columns.size - 1);
  const cap = budget > 0 ? Math.min(COLUMN_CAP, Math.max(2, Math.floor((budget - 1) / sideCols))) : Number.POSITIVE_INFINITY;
  for (const [col, list] of columns) {
    list.sort((a, b) => b.score - a.score || label(a).localeCompare(label(b)));
    if (col !== 0 && list.length > cap && !expandedCols.has(col)) {
      const shown = list.slice(0, cap - 1);
      const hidden = list.slice(cap - 1);
      const bundle: MapItem = { id: `bundle|${col}`, kind: 'bundle', col, fnIds: hidden.flatMap((h) => h.fnIds), hidden, score: -1 };
      for (const h of hidden) itemRemap.set(h.id, bundle.id);
      columns.set(col, [...shown, bundle]);
      items.set(bundle.id, bundle);
    }
  }
  const resolveItem = (fnId: string) => {
    const id = itemOfFn.get(fnId)!;
    return itemRemap.get(id) ?? id;
  };

  // ---- 3. Edges between adjacent hops only (keeps everything flowing left → right) ----
  const colOf = (itemId: string) => items.get(itemId)!.col;
  const edgeAgg = new Map<string, { source: string; target: string; count: number; breaking: boolean; dangling: boolean; low: boolean }>();
  for (const e of ix.graph.edges) {
    const hs = hop.get(e.source);
    const ht = hop.get(e.target);
    if (hs === undefined || ht === undefined || ht !== hs + 1) continue;
    const s = resolveItem(e.source);
    const t = resolveItem(e.target);
    if (s === t || colOf(s) >= colOf(t)) continue;
    const key = `${s}=>${t}`;
    const agg = edgeAgg.get(key) ?? { source: s, target: t, count: 0, breaking: false, dangling: false, low: true };
    agg.count += e.count;
    agg.breaking ||= isBreaking(ix.fns.get(e.target));
    agg.dangling ||= !!e.dangling;
    agg.low &&= e.confidence === 'low';
    edgeAgg.set(key, agg);
  }

  // ---- 4. External effects of the focus and everything downstream ----
  const downCols = [...columns.keys()].filter((c) => c >= 0);
  const sinkCol = Math.max(...downCols) + 1;
  for (const [id, h] of hop) {
    if (h < 0) continue;
    for (const sinkId of ix.fns.get(id)!.effects) {
      const sink = ix.sinks.get(sinkId);
      if (!sink) continue;
      const itemId = `sink|${sinkId}`;
      let item = items.get(itemId);
      if (!item) {
        item = { id: itemId, kind: 'sink', col: sinkCol, fnIds: [], sink, score: 0 };
        items.set(itemId, item);
        (columns.get(sinkCol) ?? columns.set(sinkCol, []).get(sinkCol)!).push(item);
      }
      item.fnIds.push(id);
      const from = resolveItem(id);
      const key = `${from}=>${itemId}`;
      const agg = edgeAgg.get(key) ?? { source: from, target: itemId, count: 0, breaking: false, dangling: false, low: false };
      agg.count++;
      edgeAgg.set(key, agg);
    }
  }

  // ---- 5. Order each column by its neighbors' positions (outward from the focus) ----
  const order = new Map<string, number>();
  const sortedCols = [...columns.keys()].sort((a, b) => a - b);
  const neighbors = new Map<string, string[]>();
  for (const e of edgeAgg.values()) {
    (neighbors.get(e.source) ?? neighbors.set(e.source, []).get(e.source)!).push(e.target);
    (neighbors.get(e.target) ?? neighbors.set(e.target, []).get(e.target)!).push(e.source);
  }
  const place = (col: number, towards: number) => {
    const list = columns.get(col);
    if (!list) return;
    const bary = (it: MapItem) => {
      const ns = (neighbors.get(it.id) ?? []).filter((n) => items.get(n)?.col === towards).map((n) => order.get(n) ?? 0);
      return ns.length ? ns.reduce((a, b) => a + b, 0) / ns.length : Number.POSITIVE_INFINITY;
    };
    // Bundles stay last; everything else follows the column it connects to.
    list.sort((a, b) => (a.kind === 'bundle' ? 1 : 0) - (b.kind === 'bundle' ? 1 : 0) || bary(a) - bary(b) || b.score - a.score);
    list.forEach((it, i) => order.set(it.id, i));
  };
  order.set(focus, 0);
  for (const c of sortedCols.filter((c) => c > 0)) place(c, c - 1 === 0 ? 0 : sortedCols.filter((x) => x < c).at(-1)!);
  for (const c of sortedCols.filter((c) => c < 0).reverse()) place(c, sortedCols.filter((x) => x > c)[0]);

  // ---- 6. Positions ----
  const heightOf = (it: MapItem) =>
    it.id === focus ? SIZE.focus.h : it.kind === 'fn' ? SIZE.fn.h : it.kind === 'group' ? SIZE.group.h : it.kind === 'bundle' ? SIZE.bundle.h : SIZE.sink.h;
  // React Flow ids must be plain: group ids contain `::` and `|`, which break edge attachment.
  const flowId = new Map<string, string>();
  const fid = (itemId: string) => {
    let id = flowId.get(itemId);
    if (!id) {
      id = `n${flowId.size}`;
      flowId.set(itemId, id);
    }
    return id;
  };
  const nodes: Node[] = [];
  let top = 0;
  sortedCols.forEach((col, colIndex) => {
    const list = columns.get(col)!;
    const total = list.reduce((sum, it) => sum + heightOf(it), 0) + SIZE.rowGap * (list.length - 1);
    let y = -total / 2;
    top = Math.min(top, y);
    const x = colIndex * (SIZE.colWidth + SIZE.colGap) + (col > 0 ? SIZE.focus.w - SIZE.colWidth : 0);
    for (const it of list) {
      const h = heightOf(it);
      const w = it.id === focus ? SIZE.focus.w : SIZE.colWidth;
      nodes.push({
        id: fid(it.id),
        type: it.id === focus ? 'focus' : it.kind === 'group' ? 'cluster' : it.kind,
        position: { x, y },
        width: w,
        height: h,
        data: { item: it, ix, selected: isSelected(it, selection), expanded: !!it.group && expandedGroups.has(it.group.id) },
      });
      y += h + SIZE.rowGap;
    }
  });
  // Column headers sit on one shared baseline above the tallest column.
  sortedCols.forEach((col, colIndex) => {
    const x = colIndex * (SIZE.colWidth + SIZE.colGap) + (col > 0 ? SIZE.focus.w - SIZE.colWidth : 0);
    nodes.push({
      id: `header|${col}`,
      type: 'header',
      position: { x, y: top - 44 },
      width: col === 0 ? SIZE.focus.w : SIZE.colWidth,
      height: 30,
      selectable: false,
      draggable: false,
      data: { label: columnLabel(col, sinkCol), count: columns.get(col)!.reduce((n, it) => n + (it.kind === 'sink' ? 0 : it.fnIds.length), 0), col },
    });
  });

  const arrow = { type: MarkerType.ArrowClosed, width: 14, height: 14 };
  const edges: Edge[] = [...edgeAgg.values()].map((e) => {
    const kind = e.dangling ? 'dangling' : e.breaking ? 'breaking' : items.get(e.target)?.kind === 'sink' ? 'effect' : 'ok';
    return {
      id: `${fid(e.source)}-${fid(e.target)}`,
      source: fid(e.source),
      target: fid(e.target),
      animated: kind === 'breaking' || kind === 'dangling',
      // Colour already says "broken"; text is reserved for the rarer dangling case and fan-in counts.
      label: kind === 'dangling' ? 'calls deleted fn' : e.count > 1 ? `${e.count} calls` : undefined,
      className: `edge-${kind} ${e.low ? 'edge-low' : ''}`,
      markerEnd: arrow,
    };
  });

  const fnCount = (pred: (h: number) => boolean) => [...hop.values()].filter(pred).length;
  return {
    nodes,
    edges,
    itemOf: new Map([...itemOfFn.keys()].map((id) => [id, fid(resolveItem(id))])),
    stats: { upstream: fnCount((h) => h < 0), downstream: fnCount((h) => h > 0), hiddenHops: deeper },
  };
}

function groupAt(fn: FnNode, level: number): string | null {
  const kind = GROUP_KIND_FOR_LOD[level];
  return kind ? fn.groups[kind] : null;
}

/** What earns a slot before the column cap: changes, broken contracts, entry points, size. */
function importance(ix: Index, item: MapItem): number {
  let score = 0;
  for (const id of item.fnIds) {
    const fn = ix.fns.get(id)!;
    if (isChanged(fn)) score += 10;
    if (isBreaking(fn)) score += 10;
    if (fn.entry && fn.entry.kind !== 'test') score += 3;
    if (fn.entry?.kind === 'test') score -= 1;
    score += 0.5;
  }
  return score;
}

const label = (it: MapItem) => it.fn?.qualifiedName ?? it.group?.label ?? it.sink?.label ?? it.id;

function isSelected(it: MapItem, sel: Selection): boolean {
  if (!sel) return false;
  if (sel.kind === 'fn') return it.kind === 'fn' && it.fn?.id === sel.id;
  if (sel.kind === 'group') return it.group?.id === sel.id;
  if (sel.kind === 'sink') return it.sink?.id === sel.id;
  return false;
}

function columnLabel(col: number, sinkCol: number): string {
  if (col === 0) return 'Focus';
  if (col === sinkCol && col > 0) return 'External effects';
  if (col === -1) return 'Direct callers';
  if (col === 1) return 'Direct callees';
  return col < 0 ? `${-col} hops upstream` : `${col} hops downstream`;
}
