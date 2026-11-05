// The review brief: the page a code review opens on. What the change does and how, its concrete
// risks, what to check, where to start reading, and how it is tested. Written by the model from the
// author's description and the diffs (one request per push, stored by content), or assembled from
// the analysis when no model is configured.
import { createHash } from 'node:crypto';
import type { Describer } from './purpose.ts';
import { reviewReport } from './review.ts';
import type { Store } from './store/index.ts';
import type { CodeGraph, FnNode, ReviewBrief } from './types.ts';
import { isTestFile } from './hierarchy.ts';

export interface BriefInput {
  title?: string;
  description?: string;
  /** Changed functions, keyed c1, c2, … in review order. */
  changes: { key: string; node: FnNode; untouchedCallers: number }[];
  entryPoints: { name: string; kind: string; reaches: string[] }[];
  effects: { label: string; changes: string[] }[];
  testsChanged: string[];
}

export interface BriefOutput {
  overview: string;
  approach: string[];
  risks: { title: string; detail: string; ids: string[] }[];
  watch: string[];
  readingOrder: { id: string; reason: string }[];
  testing: string;
}

const MAX_CHANGES = 30;

export async function buildBrief(graph: CodeGraph, describer: Describer, opts: { store?: Store; log: (m: string) => void }): Promise<ReviewBrief> {
  const input = briefInput(graph);
  const byKey = new Map(input.changes.map((c) => [c.key, c.node.id]));
  const offline = heuristicBrief(graph, input);
  if (!describer.describeBrief || describer.name === 'heuristic' || !input.changes.length) return finish(offline, byKey, 'heuristic');

  const key = createHash('sha1')
    .update(JSON.stringify([describer.name, 'brief', input.title, input.description, input.changes.map((c) => [c.key, c.node.id, c.node.diff ?? c.node.source])]))
    .digest('hex');
  const stored = (await opts.store?.getDescriptions([key]))?.get(key) as BriefOutput | undefined;
  if (stored) return finish(stored, byKey, 'llm');
  opts.log('  writing the review brief');
  try {
    const out = await describer.describeBrief(input);
    await opts.store?.putDescriptions([{ key, kind: 'change', value: out }]);
    return finish(out, byKey, 'llm');
  } catch (err) {
    opts.log(`  ! review brief failed (${(err as Error).message}); assembling it from the analysis`);
    return finish(offline, byKey, 'heuristic');
  }
}

/** Model output names functions by key (c3); the graph uses ids. Unknown keys are dropped. */
function finish(out: BriefOutput, byKey: Map<string, string>, source: ReviewBrief['source']): ReviewBrief {
  const ids = (keys: string[]) => keys.map((k) => byKey.get(k) ?? (k.includes('#') ? k : undefined)).filter((x): x is string => !!x);
  return {
    overview: out.overview,
    approach: out.approach,
    risks: out.risks.map((r) => ({ title: r.title, detail: r.detail, fnIds: ids(r.ids) })),
    watch: out.watch,
    readingOrder: out.readingOrder.flatMap((r) => ids([r.id]).map((id) => ({ id, reason: r.reason }))),
    testing: out.testing,
    source,
  };
}

export function briefInput(graph: CodeGraph): BriefInput {
  const report = reviewReport(graph);
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const order = graph.enrichment?.reviewOrder ?? graph.nodes.filter((n) => n.status !== 'unchanged').map((n) => n.id);
  const changes = order
    .map((id) => byId.get(id)!)
    .filter(Boolean)
    .slice(0, MAX_CHANGES)
    .map((node, i) => ({ key: `c${i + 1}`, node, untouchedCallers: report.changes.find((c) => c.id === node.id)?.callers ?? 0 }));
  return {
    title: graph.meta.pr?.title,
    description: graph.meta.pr?.body,
    changes,
    entryPoints: report.entryPoints.map(({ name, kind, reaches }) => ({ name, kind, reaches })),
    effects: report.effects,
    testsChanged: [...new Set(changes.filter((c) => isTestFile(c.node.file)).map((c) => c.node.file))],
  };
}

const name = (n: FnNode) => (n.qualifiedName === '(top level)' ? `${n.file.split('/').pop()} (top level)` : n.qualifiedName);

/** Offline: the same shape, assembled from contracts, invariants, reach and effects. */
export function heuristicBrief(graph: CodeGraph, input: BriefInput): BriefOutput {
  const code = input.changes.filter((c) => !isTestFile(c.node.file));
  const files = new Set(code.map((c) => c.node.file));
  const added = code.filter((c) => c.node.status === 'added').length;
  const modified = code.filter((c) => c.node.status === 'modified').length;
  const deleted = code.filter((c) => c.node.status === 'deleted').length;
  const overview =
    graph.enrichment?.summary ??
    `${code.length} function${code.length === 1 ? '' : 's'} changed across ${files.size} file${files.size === 1 ? '' : 's'}.`;
  const approach = [
    [added && `${added} added`, modified && `${modified} modified`, deleted && `${deleted} removed`].filter(Boolean).join(', ') + ` across ${[...files].slice(0, 4).join(', ')}${files.size > 4 ? ', …' : ''}.`,
    ...code.slice(0, 3).map((c) => `\`${name(c.node)}\`: ${c.node.enrichment?.summary ?? c.node.status}`),
  ];
  const risks: BriefOutput['risks'] = [];
  for (const c of code) {
    const e = c.node.enrichment;
    if (e?.contract.breaking) risks.push({ title: `Breaking change to \`${name(c.node)}\``, detail: e.contract.description, ids: [c.key] });
  }
  for (const c of code) {
    for (const inv of c.node.enrichment?.invariants ?? []) {
      if (inv.status !== 'preserved') risks.push({ title: `${inv.status === 'broken' ? 'Broken' : 'At-risk'} invariant in \`${name(c.node)}\``, detail: inv.statement, ids: [c.key] });
    }
  }
  const watch: string[] = [];
  const dangling = graph.edges.filter((e) => e.dangling).length;
  if (dangling) watch.push(`${dangling} call${dangling === 1 ? '' : 's'} still point at deleted functions.`);
  for (const e of input.effects.slice(0, 3)) watch.push(`Changes reach ${e.label.toLowerCase()} through ${e.changes.slice(0, 3).map((x) => `\`${x}\``).join(', ')}.`);
  if (input.entryPoints.length) watch.push(`${input.entryPoints.length} entry point${input.entryPoints.length === 1 ? '' : 's'} reach the change, starting with \`${input.entryPoints[0].name}\`.`);
  const readingOrder = code.slice(0, 5).map((c) => ({ id: c.key, reason: c.node.enrichment?.reasons[0] ? `${capitalize(c.node.enrichment.reasons[0])}.` : `${capitalize(c.node.status)} function.` }));
  const testing = input.testsChanged.length
    ? `Tests changed in ${input.testsChanged.join(', ')}.`
    : code.length
      ? 'No test files changed: check that the new behavior is covered.'
      : 'Only tests changed.';
  return { overview, approach, risks: risks.slice(0, 6), watch, readingOrder, testing };
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
