import { MarkerType, type Edge, type Node } from '@xyflow/react';
import { GROUP_KIND_FOR_LOD, isTest, type FnNode, type Index, type Lod, type Selection } from './data.ts';
import { SIZE, type MapItem } from './impact.ts';
import { layout } from './layout.ts';

/**
 * The overview: the whole graph folded to one level (systems, modules or files), laid out left
 * to right in call direction, with external effects as their own nodes. Opening a group swaps
 * it for its children, so you can drill into one area while the rest stays zoomed out.
 */
export interface OverviewView {
  nodes: Node[];
  edges: Edge[];
  /** `parts` drawn (excluding effects) out of `total` at the requested level; `folded` of them hidden. */
  stats: { parts: number; total: number; folded: number; edges: number };
}

export interface OverviewOptions {
  showTests?: boolean;
  /** Most cards to draw (effects excluded); 0 = no limit. */
  budget?: number;
  /** Groups the viewer opened from a "+N more" card: everything inside them is always drawn. */
  opened?: Set<string>;
}

const LEVEL = { file: 1, module: 2, system: 3 } as const;
const ROOT = '(everything)';

const MAX_EDGE_WIDTH = 6;

export function buildOverview(ix: Index, lod: Lod, expanded: Set<string>, selection: Selection, opts: OverviewOptions = {}): OverviewView {
  const { showTests = true, budget = 0, opened = new Set<string>() } = opts;
  const level = Math.max(1, lod);
  let items = new Map<string, MapItem>();
  const itemOf = new Map<string, string>();

  const shown = showTests ? ix.graph.nodes : ix.graph.nodes.filter((fn) => !isTest(fn));
  for (const fn of shown) {
    let l = level;
    let gid = groupAt(fn, l);
    while (gid && expanded.has(gid) && l > 0) {
      l--;
      gid = groupAt(fn, l);
    }
    const id = gid ?? fn.id;
    let item = items.get(id);
    if (!item) {
      item = gid
        ? { id, kind: 'group', col: 0, fnIds: [], group: ix.groups.get(gid)!, score: 0 }
        : { id, kind: 'fn', col: 0, fnIds: [], fn, score: 0 };
      items.set(id, item);
    }
    item.fnIds.push(fn.id);
    itemOf.set(fn.id, id);
  }

  // Over budget: fold the least important parts into "+N more" cards inside their parent.
  const total = items.size;
  let folded = 0;
  if (budget > 0 && items.size > budget) {
    const result = foldToBudget(ix, items, budget, opened, selection);
    items = result.items;
    folded = result.folded;
    for (const it of items.values()) for (const id of it.fnIds) itemOf.set(id, it.id);
  }
  const parts = items.size;

  // Calls between items, aggregated.
  const agg = new Map<string, { source: string; target: string; count: number; low: boolean; effect?: boolean }>();
  for (const e of ix.graph.edges) {
    const s = itemOf.get(e.source);
    const t = itemOf.get(e.target);
    if (!s || !t || s === t) continue;
    const key = `${s}=>${t}`;
    const a = agg.get(key) ?? { source: s, target: t, count: 0, low: true };
    a.count += e.count;
    a.low &&= e.confidence === 'low';
    agg.set(key, a);
  }
  // External effects.
  for (const fn of shown) {
    for (const sinkId of fn.effects) {
      const sink = ix.sinks.get(sinkId);
      if (!sink) continue;
      const id = `sink|${sinkId}`;
      let item = items.get(id);
      if (!item) {
        item = { id, kind: 'sink', col: 0, fnIds: [], sink, score: 0 };
        items.set(id, item);
      }
      item.fnIds.push(fn.id);
      const from = itemOf.get(fn.id)!;
      const key = `${from}=>${id}`;
      const a = agg.get(key) ?? { source: from, target: id, count: 0, low: false, effect: true };
      a.count++;
      agg.set(key, a);
    }
  }

  const fid = new Map([...items.keys()].map((id, i) => [id, `o${i}`]));
  const heightOf = (it: MapItem) => (it.kind === 'fn' ? SIZE.fn.h : it.kind === 'sink' ? SIZE.sink.h : SIZE.group.h);
  const raw: Node[] = [...items.values()].map((it) => ({
    id: fid.get(it.id)!,
    type: it.kind === 'group' ? 'cluster' : it.kind,
    position: { x: 0, y: 0 },
    width: SIZE.colWidth,
    height: heightOf(it),
    data: {
      item: it,
      ix,
      selected: isSelected(it, selection),
      expanded: false,
      dimmed: it.fnIds.every((id) => ix.fns.get(id)?.outside),
    },
  }));
  const maxCount = Math.max(1, ...[...agg.values()].map((a) => a.count));
  const edges: Edge[] = [...agg.values()].map((a) => ({
    id: `${fid.get(a.source)}-${fid.get(a.target)}`,
    source: fid.get(a.source)!,
    target: fid.get(a.target)!,
    label: a.count > 1 ? `${a.count}` : undefined,
    className: `edge-${a.effect ? 'effect' : 'ok'} ${a.low ? 'edge-low' : ''}`,
    style: { strokeWidth: 1 + (MAX_EDGE_WIDTH - 1) * Math.sqrt(a.count / maxCount) },
    markerEnd: { type: MarkerType.ArrowClosed, width: 12, height: 12 },
  }));
  return { nodes: arrange(raw, edges), edges, stats: { parts, total, folded, edges: edges.length } };
}

/**
 * Keep the `budget` most important cards. The rest fold into one card per parent group, so the
 * map still says where hidden code lives and how it connects. The parent level is the finest one
 * that leaves most of the budget for real cards.
 */
function foldToBudget(ix: Index, items: Map<string, MapItem>, budget: number, opened: Set<string>, selection: Selection) {
  const levelOf = (it: MapItem) => (it.kind === 'fn' ? 0 : LEVEL[it.group!.kind]);
  const first = (it: MapItem) => ix.fns.get(it.fnIds[0])!;
  const ancestor = (it: MapItem, l: number) => (l >= 4 ? ROOT : first(it).groups[GROUP_KIND_FOR_LOD[l]!]);
  const pinned = (it: MapItem) => opened.has(ROOT) || [1, 2, 3].some((l) => l > levelOf(it) && opened.has(ancestor(it, l)));

  const ranked = [...items.values()].map((it) => ({ it, s: importance(ix, it, selection) })).sort((a, b) => b.s - a.s);
  const always = ranked.filter((x) => pinned(x.it)).map((x) => x.it);
  const candidates = ranked.filter((x) => !pinned(x.it)).map((x) => x.it);
  const room = Math.max(1, budget - always.length);
  if (candidates.length <= room) return { items, folded: 0 };

  const maxLevel = Math.max(...candidates.map(levelOf));
  let keep = 0;
  let groups = new Map<string, MapItem[]>();
  for (let l = maxLevel + 1; l <= 4; l++) {
    // Each folded parent costs a card too: shrink the kept count until both fit.
    keep = room;
    for (let i = 0; i < 6; i++) {
      groups = groupBy(candidates.slice(keep), (it) => ancestor(it, l));
      const next = Math.max(0, room - groups.size);
      if (next === keep) break;
      keep = next;
    }
    if (l === 4 || keep >= room * 0.6) break;
  }
  const out = new Map<string, MapItem>();
  for (const it of [...always, ...candidates.slice(0, keep)]) out.set(it.id, it);
  let folded = 0;
  for (const [key, members] of groups) {
    // Folding a single card saves nothing: show it as itself.
    if (members.length === 1) {
      out.set(members[0].id, members[0]);
      continue;
    }
    folded += members.length;
    out.set(`rest|${key}`, {
      id: `rest|${key}`,
      kind: 'bundle',
      col: 0,
      fnIds: members.flatMap((m) => m.fnIds),
      hidden: members,
      group: key === ROOT ? undefined : ix.groups.get(key),
      score: -1,
    });
  }
  return { items: out, folded };
}

/**
 * Connected parts flow left to right (dagre); parts with no calls either way are packed into a
 * grid beside them instead of one tall column that would shrink the whole map to fit.
 */
function arrange(nodes: Node[], edges: Edge[]): Node[] {
  const linked = new Set(edges.flatMap((e) => [e.source, e.target]));
  const flow = layout(nodes.filter((n) => linked.has(n.id)), edges, { ranksep: 110, nodesep: 22 });
  const loose = nodes.filter((n) => !linked.has(n.id));
  if (!loose.length) return flow;
  const box = flow.reduce(
    (b, n) => ({ x0: Math.min(b.x0, n.position.x), y0: Math.min(b.y0, n.position.y), x1: Math.max(b.x1, n.position.x + (n.width ?? 0)), y1: Math.max(b.y1, n.position.y + (n.height ?? 0)) }),
    { x0: 0, y0: 0, x1: 0, y1: 0 },
  );
  const gap = 22;
  const cellW = SIZE.colWidth + gap;
  const cellH = Math.max(...loose.map((n) => n.height ?? 0)) + gap;
  // Aim for a roughly 16:10 overall picture: beside a tall flow, below a wide one.
  const below = flow.length > 0 && box.x1 - box.x0 > (box.y1 - box.y0) * 1.6;
  const cols = below
    ? Math.max(1, Math.floor((box.x1 - box.x0 + gap) / cellW))
    : Math.max(1, Math.ceil(Math.sqrt((loose.length * cellH * 1.6) / cellW)));
  const x0 = flow.length ? (below ? box.x0 : box.x1 + 90) : 0;
  const y0 = flow.length ? (below ? box.y1 + 70 : box.y0) : 0;
  return [...flow, ...loose.map((n, i) => ({ ...n, position: { x: x0 + (i % cols) * cellW, y: y0 + Math.floor(i / cols) * cellH } }))];
}

function groupBy<T>(list: T[], key: (t: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const t of list) {
    const k = key(t);
    (out.get(k) ?? out.set(k, []).get(k)!).push(t);
  }
  return out;
}

/** What earns a card: the selection, entry points, hotspots, recent change, size and connectivity. */
function importance(ix: Index, it: MapItem, selection: Selection): number {
  let s = 0;
  const sel = selection?.kind === 'group' ? ix.groups.get(selection.id) : undefined;
  if (it.group && it.group.id === sel?.id) s += 1000;
  if (selection?.kind === 'fn' && it.fnIds.includes(selection.id)) s += 1000;
  if (sel && it.fnIds.some((id) => sel.fnIds.includes(id))) s += 50;
  let degree = 0;
  let outside = 0;
  for (const id of it.fnIds) {
    const fn = ix.fns.get(id)!;
    if (fn.entry && fn.entry.kind !== 'test') s += 3;
    if (ix.hotspots.has(id)) s += 4;
    if (fn.since) s += 2;
    if (fn.status !== 'unchanged') s += 5;
    if (fn.outside) outside++;
    degree += (ix.callers.get(id)?.length ?? 0) + (ix.callees.get(id)?.length ?? 0);
  }
  s += Math.log2(1 + it.fnIds.length) * 3 + Math.log2(1 + degree) * 2;
  if (outside === it.fnIds.length) s -= 20;
  return s;
}

function groupAt(fn: FnNode, level: number): string | null {
  const kind = GROUP_KIND_FOR_LOD[level];
  return kind ? fn.groups[kind] : null;
}

function isSelected(it: MapItem, sel: Selection): boolean {
  if (!sel) return false;
  if (sel.kind === 'fn') return it.fn?.id === sel.id;
  if (sel.kind === 'group') return it.group?.id === sel.id;
  if (sel.kind === 'sink') return it.sink?.id === sel.id;
  return false;
}
