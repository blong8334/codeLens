import type { Store } from './store/index.ts';
import type {
  CodeGraph,
  ContractChange,
  ContractChangeKind,
  FnNode,
  Invariant,
  NodeEnrichment,
  Signature,
} from './types.ts';
import { createHash } from 'node:crypto';
import { describeGraph, heuristicDescriber, type Describer } from './purpose.ts';

const hashOf = (...parts: string[]) => createHash('sha1').update(parts.join('\0')).digest('hex');

/** Context handed to an enrichment provider for a single changed function. */
export interface NodeContext {
  node: FnNode;
  callers: FnNode[];
  callees: FnNode[];
  /** Distinct files among all transitive callers. */
  modulesReached: number;
  /** Transitive callers the change does not touch: the code that can break without being reviewed. */
  untouchedCallers: number;
  /** Lines added plus removed in this function. */
  linesChanged: number;
  danglingCallers: number;
  /** Direct callers the change does not touch (a signature change must not have any to be compiler-checked). */
  untouchedDirectCallers: number;
  /** The reviewer's preferences, in their words, when they have any. */
  preferences?: string;
  heuristic: NodeEnrichment;
}

/** Statically typed languages: a call that no longer matches a changed signature fails the build. */
const COMPILED = new Set(['typescript', 'tsx', 'java', 'kotlin', 'scala', 'csharp', 'go', 'rust', 'c', 'cpp', 'swift']);

export interface EnrichmentProvider extends Describer {
  name: string;
  enrichNode(ctx: NodeContext): Promise<NodeEnrichment>;
  summarize(graph: CodeGraph, ranked: FnNode[]): Promise<string>;
}

export async function enrich(
  graph: CodeGraph,
  provider: EnrichmentProvider,
  opts: { concurrency?: number; log?: (msg: string) => void; purposes?: boolean; store?: Store } = {},
): Promise<CodeGraph> {
  const log = opts.log ?? (() => {});
  if ((graph.version as number) !== 2) throw new Error(`graph version ${graph.version} is outdated; re-run \`codelens inspect\``);
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const callersOf = new Map<string, string[]>();
  const calleesOf = new Map<string, string[]>();
  for (const e of graph.edges) {
    (callersOf.get(e.target) ?? callersOf.set(e.target, []).get(e.target)!).push(e.source);
    (calleesOf.get(e.source) ?? calleesOf.set(e.source, []).get(e.source)!).push(e.target);
  }

  const changed = graph.nodes.filter((n) => n.status !== 'unchanged');
  const contexts = changed.map((node): NodeContext => {
    const ancestors = collectAncestors(node.id, callersOf);
    const ctx: NodeContext = {
      node,
      callers: (callersOf.get(node.id) ?? []).map((id) => byId.get(id)!),
      callees: (calleesOf.get(node.id) ?? []).map((id) => byId.get(id)!),
      modulesReached: new Set([...ancestors].map((id) => byId.get(id)!.file)).size,
      untouchedCallers: [...ancestors].filter((id) => byId.get(id)!.status === 'unchanged').length,
      linesChanged: (node.diff ?? '').split('\n').filter((l) => /^[+-]/.test(l)).length,
      danglingCallers: graph.edges.filter((e) => e.target === node.id && e.dangling).length,
      untouchedDirectCallers: (callersOf.get(node.id) ?? []).filter((id) => byId.get(id)!.status === 'unchanged').length,
      preferences: graph.review?.preferences?.text,
      heuristic: undefined!,
    };
    ctx.heuristic = heuristicEnrichment(ctx);
    return ctx;
  });

  // Model analyses are stored by everything they depend on (the code before and after, who calls
  // it, what it calls), so a new push to a pull request only re-analyzes what actually moved.
  const cacheable = !!opts.store && provider.name !== 'heuristic';
  const keyOf = (ctx: NodeContext) =>
    hashOf(
      provider.name,
      'change',
      ctx.node.id,
      ctx.node.status,
      ctx.node.before?.source ?? '',
      ctx.node.source,
      ctx.callers.map((n) => n.id).sort().join(','),
      ctx.callees.map((n) => n.id).sort().join(','),
      String(ctx.untouchedCallers),
      String(ctx.danglingCallers),
      ctx.preferences ?? '',
    );
  const cached = cacheable ? await opts.store!.getDescriptions(contexts.map(keyOf)) : new Map<string, unknown>();
  const fresh: { key: string; kind: 'change'; value: unknown }[] = [];
  let reused = 0;
  await mapLimit(contexts, opts.concurrency ?? 4, async (ctx) => {
    const key = keyOf(ctx);
    const hit = cached.get(key) as NodeEnrichment | undefined;
    if (hit) {
      ctx.node.enrichment = hit;
      reused++;
      return;
    }
    // A move or rename with the body otherwise unchanged needs no model to explain it.
    if (ctx.node.moved?.exact) {
      ctx.node.enrichment = ctx.heuristic;
      return;
    }
    try {
      ctx.node.enrichment = await provider.enrichNode(ctx);
      if (cacheable) fresh.push({ key, kind: 'change', value: ctx.node.enrichment });
    } catch (err) {
      log(`  ! ${provider.name} failed for ${ctx.node.id} (${(err as Error).message}); using heuristics`);
      ctx.node.enrichment = ctx.heuristic;
    }
    log(`  ✓ ${ctx.node.qualifiedName} — blast radius ${ctx.node.enrichment.blastRadius.toFixed(2)}`);
  });
  if (reused) log(`  ${reused} change${reused === 1 ? '' : 's'} unchanged since the last analysis (from the store)`);

  const ranked = [...changed].sort((a, b) => b.enrichment!.blastRadius - a.enrichment!.blastRadius);
  const top = ranked.slice(0, 3).map((n) => n.enrichment!.blastRadius);
  const overallRisk = top.length ? Math.min(1, Math.max(...top) * 0.7 + (top.reduce((a, b) => a + b, 0) / top.length) * 0.3) : 0;

  let summary: string;
  const summaryKey = hashOf(provider.name, 'summary', ...ranked.map((n) => `${n.id}:${n.enrichment!.blastRadius}:${n.enrichment!.summary}`));
  const storedSummary = cacheable ? ((await opts.store!.getDescriptions([summaryKey])).get(summaryKey) as string | undefined) : undefined;
  try {
    summary = storedSummary ?? (await provider.summarize(graph, ranked));
    if (cacheable && !storedSummary) fresh.push({ key: summaryKey, kind: 'change', value: summary });
  } catch (err) {
    log(`  ! summary failed (${(err as Error).message}); using heuristics`);
    summary = await heuristicProvider.summarize(graph, ranked);
  }

  if (fresh.length) await opts.store!.putDescriptions(fresh);
  graph.enrichment = { summary, overallRisk: round(overallRisk), reviewOrder: ranked.map((n) => n.id), provider: provider.name };

  if (opts.purposes !== false) {
    log('Describing what each function does and why…');
    await describeGraph(graph, provider, heuristicProvider, {
      store: opts.store,
      concurrency: opts.concurrency ?? 4,
      log,
    });
  }
  return graph;
}

// ---------------- Heuristics (deterministic, offline) ----------------

export const heuristicProvider: EnrichmentProvider = {
  ...heuristicDescriber,
  name: 'heuristic',
  async enrichNode(ctx) {
    return ctx.heuristic;
  },
  async summarize(graph, ranked) {
    const breaking = ranked.filter((n) => n.enrichment?.contract.breaking);
    const atRisk = ranked.flatMap((n) => n.enrichment?.invariants.filter((i) => i.status !== 'preserved') ?? []);
    const parts = [
      `${graph.meta.stats.changedFunctions} functions changed across ${graph.groups.filter((g) => g.kind === 'file' && g.changed).length} files, reaching ${graph.meta.stats.impactedFunctions} callers.`,
    ];
    if (breaking.length) parts.push(`${breaking.length} contract-breaking change${breaking.length > 1 ? 's' : ''}: ${breaking.map((n) => `\`${n.qualifiedName}\``).join(', ')}.`);
    if (atRisk.length) parts.push(`${atRisk.length} invariant${atRisk.length > 1 ? 's' : ''} at risk or broken.`);
    if (ranked[0]) parts.push(`Start review at \`${ranked[0].qualifiedName}\`.`);
    return parts.join(' ');
  },
};

export function heuristicEnrichment(ctx: NodeContext): NodeEnrichment {
  const { node } = ctx;
  const contract = compareContracts(node);
  const invariants = detectInvariants(node);
  const reasons: string[] = [];

  if (node.moved?.exact) {
    const from = node.moved.from;
    const fromFile = from.slice(0, from.indexOf('#'));
    const what = node.moved.renamed ? `Renames \`${from.slice(from.indexOf('#') + 1)}\` to \`${node.qualifiedName}\`` : `Moves \`${node.qualifiedName}\``;
    return {
      summary: `${what}${fromFile !== node.file ? ` from ${fromFile} to ${node.file}` : ''}; the body is otherwise unchanged.`,
      contract: { breaking: false, kinds: ['none'], description: node.moved.renamed ? 'Renamed; callers in this change use the new name.' : 'Moved; no contract change.' },
      invariants: [],
      blastRadius: ctx.danglingCallers ? 0.3 : 0.03,
      reasons: [node.moved.renamed ? 'rename with no logic change' : 'move with no logic change', ...(ctx.danglingCallers ? [`${ctx.danglingCallers} call site${ctx.danglingCallers > 1 ? 's' : ''} still use the old name`] : [])],
      source: 'heuristic',
    };
  }
  // A signature change in a typed language with every direct caller updated in the same change: the
  // compiler checks that they match, so it is not a risk by itself. (Sync/async is excluded: an
  // un-awaited promise still compiles.)
  if (contract.breaking && COMPILED.has(node.language) && !ctx.untouchedDirectCallers && !ctx.danglingCallers && !contract.kinds.includes('async-changed')) {
    contract.compilerChecked = true;
    contract.breaking = false;
  }
  if (node.moved) reasons.push(`moved from ${node.moved.from.slice(0, node.moved.from.indexOf('#'))}`);

  // Blast radius is about code the change does NOT touch: callers that are themselves part of the
  // change get reviewed anyway, and nothing outside a change can call a function it just added.
  let score = 0.08;
  const reach = 1 - Math.exp(-ctx.untouchedCallers / 6);
  score += 0.35 * reach;
  if (ctx.untouchedCallers) reasons.push(`${ctx.untouchedCallers} caller${ctx.untouchedCallers > 1 ? 's' : ''} outside this change, across ${ctx.modulesReached} file${ctx.modulesReached === 1 ? '' : 's'}`);
  // Bigger changes deserve more attention than one-line helpers (up to +0.1 around 100 lines).
  score += Math.min(0.1, 0.025 * Math.log2(1 + ctx.linesChanged));
  if (ctx.modulesReached > 1) score += Math.min(0.1, 0.03 * ctx.modulesReached);
  // An exported function nothing calls yet is new surface, not existing risk.
  if (node.exported && (node.status !== 'added' || ctx.untouchedCallers)) {
    score += 0.1;
    reasons.push('part of the exported/public surface');
  }
  if (contract.compilerChecked) {
    score += 0.03;
    reasons.push(`signature change (${contract.kinds.join(', ')}), compiler-checked: every caller is updated in this change`);
  } else if (contract.breaking) {
    score += 0.3;
    reasons.push(`breaking contract change (${contract.kinds.join(', ')})`);
  }
  if (ctx.danglingCallers) {
    score += 0.2;
    reasons.push(`${ctx.danglingCallers} call site${ctx.danglingCallers > 1 ? 's' : ''} still reference the deleted function`);
  }
  const broken = invariants.filter((i) => i.status !== 'preserved');
  if (broken.length) {
    score += Math.min(0.2, 0.08 * broken.length);
    reasons.push(`${broken.length} invariant${broken.length > 1 ? 's' : ''} weakened`);
  }

  return {
    summary: describeChange(node, contract),
    contract,
    invariants,
    blastRadius: round(Math.min(1, score)),
    reasons,
    source: 'heuristic',
  };
}

const sigText = (s: Signature) =>
  `${s.async ? 'async ' : ''}(${s.params.map((p) => `${p.name}${p.optional ? '?' : ''}${p.type ? `: ${p.type}` : ''}`).join(', ')})${s.returnType ? `: ${s.returnType}` : ''}`;

export function compareContracts(node: FnNode): ContractChange {
  if (node.status === 'added') {
    return { breaking: false, kinds: ['added'], after: sigText(node.signature), description: 'New function; no existing callers depend on it.' };
  }
  if (node.status === 'deleted') {
    return { breaking: true, kinds: ['removed'], before: sigText(node.signature), description: 'Function removed; any remaining caller will fail.' };
  }
  const before = node.before?.signature;
  const after = node.signature;
  if (!before) return { breaking: false, kinds: ['none'], description: 'No contract change.' };

  const kinds: ContractChangeKind[] = [];
  const notes: string[] = [];
  let breaking = false;

  const beforeParams = new Map(before.params.map((p, i) => [p.name, { ...p, i }]));
  const afterParams = new Map(after.params.map((p, i) => [p.name, { ...p, i }]));
  for (const [name, p] of afterParams) {
    const prev = beforeParams.get(name);
    if (!prev) {
      kinds.push('param-added');
      notes.push(`${p.optional ? 'optional' : 'required'} parameter \`${name}\` added`);
      if (!p.optional) breaking = true;
    } else {
      if ((prev.type ?? '') !== (p.type ?? '')) {
        kinds.push('param-type-changed');
        notes.push(`\`${name}\` type ${prev.type ?? 'untyped'} → ${p.type ?? 'untyped'}`);
        breaking = true;
      }
      if (prev.optional && !p.optional) {
        kinds.push('param-type-changed');
        notes.push(`\`${name}\` is now required`);
        breaking = true;
      }
      if (prev.i !== p.i) {
        notes.push(`\`${name}\` moved from position ${prev.i + 1} to ${p.i + 1}`);
        breaking = true;
      }
    }
  }
  for (const name of beforeParams.keys()) {
    if (!afterParams.has(name)) {
      kinds.push('param-removed');
      notes.push(`parameter \`${name}\` removed`);
      breaking = true;
    }
  }
  if ((before.returnType ?? '') !== (after.returnType ?? '')) {
    kinds.push('return-type-changed');
    notes.push(`return type ${before.returnType ?? 'inferred'} → ${after.returnType ?? 'inferred'}`);
    breaking = true;
  }
  if (before.async !== after.async) {
    kinds.push('async-changed');
    notes.push(after.async ? 'now async (callers must await)' : 'no longer async');
    breaking = true;
  }
  const throwsBefore = new Set(node.before?.throws ?? []);
  const throwsAfter = new Set(node.throws);
  const newThrows = [...throwsAfter].filter((t) => !throwsBefore.has(t));
  if (newThrows.length) {
    kinds.push('throws-changed');
    notes.push(`new failure path: ${code(newThrows[0])}`);
  }
  if (!kinds.length) {
    kinds.push('behavioral');
    notes.push('signature unchanged; body logic modified');
  }
  return {
    breaking,
    kinds: [...new Set(kinds)],
    before: sigText(before),
    after: sigText(after),
    description: capitalize(notes.join('; ')) + '.',
  };
}

function describeChange(node: FnNode, contract: ContractChange): string {
  const where = `\`${node.qualifiedName}\` in ${node.file}`;
  switch (node.status) {
    case 'added':
      return `Adds ${where}.`;
    case 'deleted':
      return `Removes ${where}.`;
    default:
      return `Modifies ${where}${contract.breaking ? ' with a breaking contract change' : ''}: ${contract.description.replace(/\.$/, '')}.`;
  }
}

interface InvariantRule {
  pattern: RegExp;
  statement: (match: string) => string;
  risk: Invariant['risk'];
}

const GUARD_RULES: InvariantRule[] = [
  {
    pattern: /\bif\s*\(\s*!\s*[\w.]+\s*\)|\bif\s*\([^)]*(===?|!==?)\s*(null|undefined)\b|\bif\s+not\s+\w+|\bif\s+[\w.]+\s+is\s+None\b/,
    statement: (m) => `Missing/null input is rejected before use (${code(m.trim())})`,
    risk: 'high',
  },
  {
    pattern: /\b\w*(assert|validate|check|guard|ensure|verify|authorize|authenticate|permission)\w*\s*\(/i,
    statement: (m) => `Validation/authorization runs before side effects (${code(m.replace(/\($/, '').trim())})`,
    risk: 'high',
  },
  {
    pattern: /\bif\s*\([^)]*[<>]=?\s*[\w.]+\)/,
    statement: (m) => `Bounds/limit check holds (${code(m.trim())})`,
    risk: 'medium',
  },
  {
    pattern: /\b(try\s*\{|catch\s*\(|except\b|finally\b)/,
    statement: () => 'Errors are caught and handled locally',
    risk: 'medium',
  },
  {
    pattern: /\b(BEGIN|COMMIT|ROLLBACK|transaction|withLock|lock\(|mutex)\b/i,
    statement: (m) => `Operation is atomic/serialized (${code(m.trim())})`,
    risk: 'high',
  },
  {
    pattern: /\bawait\b/,
    statement: () => 'Async work completes before the function returns',
    risk: 'medium',
  },
];

/** Infer invariants by looking at which protective constructs a change added or removed. */
export function detectInvariants(node: FnNode): Invariant[] {
  const out: Invariant[] = [];
  const diff = node.diff ?? '';
  const removed = diff.split('\n').filter((l) => l.startsWith('-')).map((l) => l.slice(1));
  const added = diff.split('\n').filter((l) => l.startsWith('+')).map((l) => l.slice(1));
  const afterSource = node.after?.source ?? '';

  for (const rule of GUARD_RULES) {
    for (const line of removed) {
      const m = line.match(rule.pattern);
      if (!m) continue;
      // Same guard re-added (e.g. reformatted)? Then it is preserved.
      const stillPresent = added.some((a) => a.includes(m[0])) || afterSource.includes(m[0]);
      out.push({
        statement: rule.statement(m[0]),
        status: stillPresent ? 'preserved' : node.status === 'deleted' ? 'broken' : 'at-risk',
        risk: rule.risk,
        evidence: line.trim(),
      });
    }
  }
  for (const t of node.throws) {
    if (node.status === 'modified' && !node.before?.throws.includes(t)) {
      out.push({ statement: `Callers must handle new failure: ${code(t)}`, status: 'at-risk', risk: 'medium', evidence: t });
    }
  }
  if (node.before && node.signature.async !== node.before.signature.async) {
    out.push({
      statement: node.signature.async ? 'Callers now receive a Promise and must await it' : 'Callers awaiting this function now receive a plain value',
      status: 'at-risk',
      risk: 'high',
    });
  }
  // Dedupe by statement, keeping the worst status.
  const rank = { broken: 2, 'at-risk': 1, preserved: 0 };
  const best = new Map<string, Invariant>();
  for (const inv of out) {
    const prev = best.get(inv.statement);
    if (!prev || rank[inv.status] > rank[prev.status]) best.set(inv.statement, inv);
  }
  return [...best.values()];
}

// ---------------- utils ----------------

function collectAncestors(id: string, callersOf: Map<string, string[]>): Set<string> {
  const seen = new Set<string>();
  const stack = [id];
  while (stack.length) {
    for (const c of callersOf.get(stack.pop()!) ?? []) {
      if (!seen.has(c) && c !== id) {
        seen.add(c);
        stack.push(c);
      }
    }
  }
  return seen;
}

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) await fn(items[i++]);
    }),
  );
}

const round = (n: number) => Math.round(n * 100) / 100;
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Inline Markdown code that survives backticks inside it (`` a `b` c ``). */
export function code(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((r) => r.length));
  const fence = '`'.repeat(longest + 1);
  const pad = longest ? ' ' : '';
  return `${fence}${pad}${text}${pad}${fence}`;
}
