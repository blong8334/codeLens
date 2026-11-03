import dagre from '@dagrejs/dagre';
import type { Edge, Node } from '@xyflow/react';

/** Run a left-to-right dagre layout. Each node must carry `width`/`height`. */
export function layout<N extends Node>(nodes: N[], edges: Edge[], opts: { ranksep?: number; nodesep?: number } = {}): N[] {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'LR', ranksep: opts.ranksep ?? 90, nodesep: opts.nodesep ?? 28, marginx: 20, marginy: 20 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of nodes) g.setNode(n.id, { width: n.width ?? 200, height: n.height ?? 60 });
  for (const e of edges) if (g.hasNode(e.source) && g.hasNode(e.target)) g.setEdge(e.source, e.target);
  dagre.layout(g);
  return nodes.map((n) => {
    const p = g.node(n.id);
    return { ...n, position: { x: p.x - (n.width ?? 200) / 2, y: p.y - (n.height ?? 60) / 2 } };
  });
}
