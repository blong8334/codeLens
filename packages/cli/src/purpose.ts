import { createHash } from 'node:crypto';
import type { GuideInput, GuideOutput } from './guide.ts';
import type { Store } from './store.ts';
import type { CodeGraph, FnNode, Group, Purpose } from './types.ts';

export interface PurposeInput {
  /** Short batch-local id (f1, f2, …) so the model never has to echo long paths. */
  key: string;
  node: FnNode;
  callers: string[];
  callees: string[];
}

export interface GroupInput {
  key: string;
  group: Group;
  children: { label: string; summary: string }[];
}

export interface Describer {
  name: string;
  describeFunctions(items: PurposeInput[]): Promise<Map<string, { what: string; why: string }>>;
  describeGroups(items: GroupInput[]): Promise<Map<string, string>>;
  /** Write the package guide (explore mode's landing page). Optional: offline guides need no model. */
  describeGuide?(input: GuideInput): Promise<GuideOutput>;
}


const FN_BATCH = 10;
const GROUP_BATCH = 12;

/**
 * Give every function a "what / why" purpose and every group a one-line summary.
 * Results are stored by content hash (and model), so re-runs only pay for new or edited code.
 */
export async function describeGraph(
  graph: CodeGraph,
  describer: Describer,
  fallback: Describer,
  opts: { store?: Store; concurrency: number; log: (m: string) => void },
): Promise<{ described: number; cached: number }> {
  const cache = new DescriptionCache(opts.store);
  let described = 0;
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const callers = new Map<string, string[]>();
  const callees = new Map<string, string[]>();
  for (const e of graph.edges) {
    (callers.get(e.target) ?? callers.set(e.target, []).get(e.target)!).push(byId.get(e.source)!.qualifiedName);
    (callees.get(e.source) ?? callees.set(e.source, []).get(e.source)!).push(byId.get(e.target)!.qualifiedName);
  }

  // ---- functions ----
  const fnKey = (n: FnNode) => hash(describer.name, 'fn', n.file, n.qualifiedName, n.source);
  const pending: FnNode[] = [];
  for (const n of graph.nodes) {
    const hit = cache.get<{ what: string; why: string }>(fnKey(n));
    if (hit) n.purpose = { ...hit, source: sourceOf(describer) };
    else pending.push(n);
  }
  // Batch by file so each request carries coherent context.
  pending.sort((a, b) => a.file.localeCompare(b.file) || a.range.startLine - b.range.startLine);
  const fnBatches = chunk(pending, FN_BATCH);
  if (pending.length) opts.log(`  describing ${pending.length} functions in ${fnBatches.length} batch${fnBatches.length > 1 ? 'es' : ''} (${graph.nodes.length - pending.length} cached)`);
  await mapLimit(fnBatches, opts.concurrency, async (batch) => {
    const items = batch.map((node, i) => ({
      key: `f${i + 1}`,
      node,
      callers: (callers.get(node.id) ?? []).slice(0, 8),
      callees: (callees.get(node.id) ?? []).slice(0, 8),
    }));
    let out: Map<string, { what: string; why: string }>;
    let src = describer;
    try {
      out = await describer.describeFunctions(items);
    } catch (err) {
      opts.log(`  ! ${describer.name} failed describing ${batch[0].file} (${(err as Error).message}); using heuristics`);
      src = fallback;
      out = await fallback.describeFunctions(items);
    }
    for (const item of items) {
      let p = out.get(item.key);
      if (!p) {
        src = fallback;
        p = (await fallback.describeFunctions([item])).get(item.key)!;
      }
      item.node.purpose = { ...p, source: sourceOf(src, item.node) };
      // Heuristic text depends on callers, not just source, so only model output is cached.
      if (src === describer && describer.name !== 'heuristic') {
        cache.set(fnKey(item.node), 'fn', p);
        described++;
      }
    }
  });

  // ---- groups, bottom-up: file → module → system ----
  const childrenOf = new Map<string, Group[]>();
  for (const g of graph.groups) if (g.parent) (childrenOf.get(g.parent) ?? childrenOf.set(g.parent, []).get(g.parent)!).push(g);

  for (const kind of ['file', 'module', 'system'] as const) {
    const level = graph.groups.filter((g) => g.kind === kind);
    const inputs: { group: Group; children: { label: string; summary: string }[]; key: string }[] = [];
    for (const group of level) {
      const children =
        kind === 'file'
          ? group.fnIds.map((id) => byId.get(id)!).map((n) => ({ label: n.qualifiedName, summary: n.purpose?.what ?? '' }))
          : (childrenOf.get(group.id) ?? []).map((c) => ({ label: c.label, summary: c.summary ?? '' }));
      // A group with a single child says the same thing as that child: no request needed.
      if (children.length === 1) {
        group.summary = children[0].summary;
        continue;
      }
      const key = hash(describer.name, 'group', kind, group.label, ...children.map((c) => `${c.label}:${c.summary}`));
      const hit = cache.get<string>(key);
      if (hit) group.summary = hit;
      else inputs.push({ group, children: children.slice(0, 20), key });
    }
    const batches = chunk(inputs, GROUP_BATCH);
    if (inputs.length) opts.log(`  summarizing ${inputs.length} ${kind} group${inputs.length > 1 ? 's' : ''}`);
    await mapLimit(batches, opts.concurrency, async (batch) => {
      const items: GroupInput[] = batch.map((b, i) => ({ key: `g${i + 1}`, group: b.group, children: b.children }));
      let out: Map<string, string>;
      let fromFallback = false;
      try {
        out = await describer.describeGroups(items);
      } catch (err) {
        opts.log(`  ! ${describer.name} failed summarizing ${kind}s (${(err as Error).message}); using heuristics`);
        out = await fallback.describeGroups(items);
        fromFallback = true;
      }
      batch.forEach((b, i) => {
        const summary = out.get(items[i].key);
        b.group.summary = summary ?? b.children.map((c) => c.label).slice(0, 3).join(', ');
        if (summary && !fromFallback && describer.name !== 'heuristic') cache.set(b.key, 'group', summary);
      });
    });
  }
  return { described, cached: graph.nodes.length - pending.length };
}

function sourceOf(d: Describer, node?: FnNode): Purpose['source'] {
  if (d.name !== 'heuristic') return 'llm';
  return node?.doc ? 'doc' : 'heuristic';
}

// ---- heuristic describer: docstrings + naming + call context ----

export const heuristicDescriber: Describer = {
  name: 'heuristic',
  async describeFunctions(items) {
    const out = new Map<string, { what: string; why: string }>();
    for (const { key, node, callers } of items) {
      const what = node.doc ? firstSentence(node.doc) : `${humanize(node.name)}${node.signature.params.length ? ` given ${node.signature.params.map((p) => p.name).join(', ')}` : ''}.`;
      const why = node.entry
        ? `Entry point (${node.entry.kind}): ${node.entry.reason}.`
        : callers.length
          ? `Used by ${callers.slice(0, 3).join(', ')}${callers.length > 3 ? ` and ${callers.length - 3} more` : ''}.`
          : 'No callers found in the analyzed graph.';
      out.set(key, { what, why });
    }
    return out;
  },
  async describeGroups(items) {
    return new Map(
      items.map((g) => [
        g.key,
        `${g.children.length} ${g.group.kind === 'file' ? 'functions' : g.group.kind === 'module' ? 'files' : 'modules'}: ${g.children
          .slice(0, 4)
          .map((c) => c.label)
          .join(', ')}${g.children.length > 4 ? ', …' : ''}.`,
      ]),
    );
  },
};

function humanize(name: string): string {
  const words = name
    .replace(/^_+/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .toLowerCase()
    .trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const firstSentence = (s: string) => {
  const m = s.match(/^(.+?[.!?])(\s|$)/);
  return (m ? m[1] : s).slice(0, 200);
};

// ---- utils ----

const hash = (...parts: string[]) => createHash('sha1').update(parts.join('\u0000')).digest('hex');

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}

/** Store-backed when a store is given; otherwise remembers only for this run. */
class DescriptionCache {
  private memory = new Map<string, unknown>();
  constructor(private store?: Store) {}
  get<T>(key: string): T | undefined {
    return (this.memory.get(key) as T | undefined) ?? this.store?.getDescription<T>(key);
  }
  set(key: string, kind: 'fn' | 'group', value: unknown) {
    this.memory.set(key, value);
    this.store?.putDescription(key, kind, value);
  }
}
