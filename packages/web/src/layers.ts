import { MarkerType, type Edge, type Node } from '@xyflow/react';
import type { Index, Selection } from './data.ts';
import { SIZE } from './impact.ts';
import { layout } from './layout.ts';
import type { InvariantFlowNode } from './nodes.tsx';

const arrow = { type: MarkerType.ArrowClosed, width: 16, height: 16 };

/** Invariants layer: each changed function with its invariants, and the callers relying on them. */
export function invariantLayer(ix: Index, sel: Selection, focusFn?: string): { nodes: Node[]; edges: Edge[] } {
  let targets = ix.graph.nodes.filter((n) => n.enrichment && n.enrichment.invariants.length > 0);
  if (focusFn && targets.some((n) => n.id === focusFn)) targets = targets.filter((n) => n.id === focusFn);

  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const seen = new Set<string>();
  const addFn = (id: string, dimmed: boolean) => {
    if (seen.has(id)) return;
    seen.add(id);
    nodes.push({
      id,
      type: 'fn',
      position: { x: 0, y: 0 },
      width: SIZE.colWidth,
      height: SIZE.fn.h,
      data: { fn: ix.fns.get(id)!, selected: sel?.kind === 'fn' && sel.id === id, dimmed },
    });
  };

  for (const fn of targets) {
    addFn(fn.id, false);
    // Callers on the left: they are who relies on these invariants.
    for (const e of ix.callers.get(fn.id) ?? []) {
      addFn(e.source, true);
      edges.push({ id: `dep:${e.id}`, source: e.source, target: fn.id, className: 'edge-quiet', markerEnd: arrow, label: 'relies on' });
    }
    fn.enrichment!.invariants.forEach((inv, i) => {
      const id = `inv:${fn.id}:${i}`;
      nodes.push({
        id,
        type: 'invariant',
        position: { x: 0, y: 0 },
        width: 270,
        height: 48 + Math.ceil(inv.statement.length / 32) * 18,
        data: { invariant: inv, selected: sel?.kind === 'invariant' && sel.fnId === fn.id && sel.index === i },
      } satisfies InvariantFlowNode);
      edges.push({
        id: `e:${id}`,
        source: fn.id,
        target: id,
        className: `edge-inv-${inv.status}`,
        animated: inv.status !== 'preserved',
        markerEnd: arrow,
      });
    });
  }
  return { nodes: layout(nodes, edges, { ranksep: 70, nodesep: 18 }), edges };
}
