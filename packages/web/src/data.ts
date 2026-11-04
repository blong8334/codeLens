import type { CallEdge, CodeGraph, FnNode, Group, Hotspot, Invariant, PrThread, Sink } from '../../cli/src/types.ts';

export type { CallEdge, CodeGraph, FnNode, Group, Hotspot, Invariant, Sink };

/** History entry for the zoomed-out overview map (no focus function). */
export const OVERVIEW = '__overview__';

export type Layer = 1 | 2 | 3;

export const LAYERS: { id: Layer; name: string; hint: string }[] = [
  { id: 1, name: 'Impact map', hint: 'Who depends on this change, and what does it depend on?' },
  { id: 2, name: 'Invariants', hint: 'What could now fail, and who relies on it?' },
  { id: 3, name: 'Diffs', hint: 'The exact lines, in review order.' },
];

/** Level of detail for everything that is not the focus: function → file → module → system. */
export type Lod = 0 | 1 | 2 | 3;
export const LODS: { id: Lod; name: string }[] = [
  { id: 0, name: 'Function' },
  { id: 1, name: 'File' },
  { id: 2, name: 'Module' },
  { id: 3, name: 'System' },
];
export const GROUP_KIND_FOR_LOD = [null, 'file', 'module', 'system'] as const;

export type Selection =
  | { kind: 'fn'; id: string }
  | { kind: 'group'; id: string }
  | { kind: 'sink'; id: string }
  | { kind: 'invariant'; fnId: string; index: number }
  | null;

export interface Index {
  graph: CodeGraph;
  fns: Map<string, FnNode>;
  groups: Map<string, Group>;
  sinks: Map<string, Sink>;
  childGroups: Map<string, Group[]>;
  callers: Map<string, CallEdge[]>;
  callees: Map<string, CallEdge[]>;
  /** Highest blast radius among a group's changed functions. */
  groupRisk: Map<string, number>;
  reviewOrder: string[];
  reviewRank: Map<string, number>;
  explore: boolean;
  /** Steppable entry points: everything but tests, unless tests are all there is. */
  tour: string[];
  hotspots: Map<string, Hotspot>;
  /** Pull request review threads by the function they are on. */
  threadsByFn: Map<string, PrThread[]>;
}

export function buildIndex(graph: CodeGraph): Index {
  const fns = new Map(graph.nodes.map((n) => [n.id, n]));
  const groups = new Map(graph.groups.map((g) => [g.id, g]));
  const callers = new Map<string, CallEdge[]>();
  const callees = new Map<string, CallEdge[]>();
  for (const e of graph.edges) {
    push(callers, e.target, e);
    push(callees, e.source, e);
  }
  const childGroups = new Map<string, Group[]>();
  for (const g of graph.groups) if (g.parent) push(childGroups, g.parent, g);
  const groupRisk = new Map<string, number>();
  for (const g of graph.groups) {
    groupRisk.set(g.id, Math.max(0, ...g.fnIds.map((id) => fns.get(id)?.enrichment?.blastRadius ?? 0)));
  }
  const reviewOrder = graph.enrichment?.reviewOrder ?? graph.nodes.filter(isChanged).map((n) => n.id);
  return {
    graph,
    fns,
    groups,
    sinks: new Map(graph.sinks.map((s) => [s.id, s])),
    childGroups,
    callers,
    callees,
    groupRisk,
    reviewOrder,
    reviewRank: new Map(reviewOrder.map((id, i) => [id, i])),
    explore: graph.meta.mode === 'explore',
    tour: tourOf(graph, fns),
    hotspots: new Map((graph.explore?.hotspots ?? []).map((h) => [h.id, h])),
    threadsByFn: threadsByFn(graph),
  };
}

function threadsByFn(graph: CodeGraph): Map<string, PrThread[]> {
  const out = new Map<string, PrThread[]>();
  for (const t of graph.meta.pr?.discussion?.threads ?? []) if (t.fnId) push(out, t.fnId, t);
  return out;
}

function tourOf(graph: CodeGraph, fns: Map<string, FnNode>): string[] {
  const entries = graph.explore?.entries ?? [];
  const nonTest = entries.filter((id) => fns.get(id)?.entry?.kind !== 'test');
  return nonTest.length ? nonTest : entries;
}

/** The overview's starting level: the coarsest one that still has several parts. */
export function defaultOverviewLod(graph: CodeGraph): Lod {
  const inside = new Set(graph.nodes.filter((n) => !n.outside).map((n) => n.id));
  const count = (k: Group['kind']) => graph.groups.filter((g) => g.kind === k && g.fnIds.some((id) => inside.has(id))).length;
  if (count('system') >= 3) return 3;
  if (count('module') >= 2) return 2;
  return 1;
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/** How to show a function's name: top-level code is named after its file. */
export function displayName(fn: FnNode): string {
  return fn.qualifiedName === '(top level)' ? `${fn.file.slice(fn.file.lastIndexOf('/') + 1)} · top level` : fn.qualifiedName;
}

export const isChanged = (n: FnNode) => n.status !== 'unchanged';
export const isBreaking = (n: FnNode | undefined) => !!n?.enrichment?.contract.breaking;

export function riskLevel(score: number): 'low' | 'medium' | 'high' {
  return score >= 0.65 ? 'high' : score >= 0.35 ? 'medium' : 'low';
}

export function splitPath(path: string): { dir: string; base: string } {
  const i = path.lastIndexOf('/');
  return i === -1 ? { dir: '', base: path } : { dir: path.slice(0, i + 1), base: path.slice(i + 1) };
}

export const ENTRY_LABEL: Record<string, string> = {
  route: 'route',
  cli: 'CLI',
  job: 'job',
  test: 'test',
  main: 'main',
  'public-api': 'public API',
  config: 'entry',
};

/** Render `backticked` identifiers in prose as <code>. */
export function inlineCode(text: string): (string | { code: string })[] {
  // Longer runs first, so `` a `b` c `` (code containing backticks) stays one span.
  return text.split(/(``\s?[\s\S]+?\s?``|`[^`]+`)/g).map((part) => {
    const m = part.match(/^(`+)\s?([\s\S]*?)\s?\1$/);
    return m && part.length > 1 ? { code: m[2] } : part;
  });
}
