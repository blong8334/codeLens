// `codelens review`: an enriched diff rendered as a pull-request summary — the overall risk, what to
// read first, broken contracts, invariants at risk, which entry points reach the change, and which
// external systems it touches. Markdown for PR comments; the same facts as JSON for other tools.
import type { CodeGraph, FnNode, Invariant } from './types.ts';

export type RiskLevel = 'low' | 'medium' | 'high';
export const riskLevel = (score: number): RiskLevel => (score >= 0.65 ? 'high' : score >= 0.35 ? 'medium' : 'low');

export interface ReviewReport {
  risk: { score: number; level: RiskLevel };
  summary: string;
  changes: {
    id: string;
    name: string;
    file: string;
    line: number;
    status: FnNode['status'];
    blastRadius: number;
    breaking: boolean;
    contract?: { before?: string; after?: string; description: string };
    invariants: Invariant[];
    callers: number;
    reachedFrom: string[];
    effects: string[];
    link?: string;
  }[];
  entryPoints: { name: string; kind: string; file: string; reaches: string[] }[];
  effects: { label: string; changes: string[] }[];
  danglingCalls: number;
  stats: CodeGraph['meta']['stats'];
}

const MAX_ROWS = 15;
const MAX_ENTRIES = 10;

export function reviewReport(graph: CodeGraph): ReviewReport {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const callersOf = new Map<string, string[]>();
  for (const e of graph.edges) (callersOf.get(e.target) ?? callersOf.set(e.target, []).get(e.target)!).push(e.source);
  const order = graph.enrichment?.reviewOrder ?? graph.nodes.filter((n) => n.status !== 'unchanged').map((n) => n.id);
  const changed = order.map((id) => byId.get(id)!).filter(Boolean);

  // Which non-test entry points reach each change, walking callers upstream.
  const reachedFrom = new Map<string, FnNode[]>();
  for (const fn of changed) {
    const seen = new Set<string>([fn.id]);
    const stack = [fn.id];
    const entries: FnNode[] = [];
    while (stack.length) {
      for (const c of callersOf.get(stack.pop()!) ?? []) {
        if (seen.has(c)) continue;
        seen.add(c);
        stack.push(c);
        const n = byId.get(c)!;
        if (n.entry && n.entry.kind !== 'test') entries.push(n);
      }
    }
    if (fn.entry && fn.entry.kind !== 'test') entries.unshift(fn);
    reachedFrom.set(fn.id, entries);
  }
  const entryMap = new Map<string, { fn: FnNode; reaches: Set<string> }>();
  for (const fn of changed) for (const e of reachedFrom.get(fn.id)!) (entryMap.get(e.id) ?? entryMap.set(e.id, { fn: e, reaches: new Set() }).get(e.id)!).reaches.add(fn.qualifiedName);

  // External systems touched by a change or by anything it calls.
  const calleesOf = new Map<string, string[]>();
  for (const e of graph.edges) (calleesOf.get(e.source) ?? calleesOf.set(e.source, []).get(e.source)!).push(e.target);
  const effectsOf = (id: string) => {
    const out = new Set<string>();
    const seen = new Set([id]);
    const stack = [id];
    while (stack.length) {
      const n = byId.get(stack.pop()!)!;
      for (const s of n.effects) out.add(s);
      for (const c of calleesOf.get(n.id) ?? []) if (!seen.has(c)) (seen.add(c), stack.push(c));
    }
    return [...out];
  };
  const sinkLabel = new Map(graph.sinks.map((s) => [s.id, s.label]));
  const effectChanges = new Map<string, Set<string>>();
  const rows = changed.map((fn) => {
    const e = fn.enrichment;
    const effects = effectsOf(fn.id);
    for (const s of effects) (effectChanges.get(s) ?? effectChanges.set(s, new Set()).get(s)!).add(fn.qualifiedName);
    return {
      id: fn.id,
      name: fn.qualifiedName === '(top level)' ? `${fn.file.split('/').pop()} (top level)` : fn.qualifiedName,
      file: fn.file,
      line: fn.range.startLine,
      status: fn.status,
      blastRadius: e?.blastRadius ?? 0,
      breaking: !!e?.contract.breaking,
      contract: e && e.contract.kinds.some((k) => k !== 'none') ? { before: e.contract.before, after: e.contract.after, description: e.contract.description } : undefined,
      invariants: (e?.invariants ?? []).filter((i) => i.status !== 'preserved'),
      callers: fn.transitiveCallers,
      reachedFrom: reachedFrom.get(fn.id)!.map((n) => entryName(n)),
      effects: effects.map((s) => sinkLabel.get(s) ?? s),
      link: lineLink(graph, fn),
    };
  });
  const score = graph.enrichment?.overallRisk ?? Math.max(0, ...rows.map((r) => r.blastRadius));
  return {
    risk: { score, level: riskLevel(score) },
    summary: graph.enrichment?.summary ?? `${rows.length} functions changed.`,
    changes: rows,
    entryPoints: [...entryMap.values()]
      .sort((a, b) => b.reaches.size - a.reaches.size)
      .map(({ fn, reaches }) => ({ name: entryName(fn), kind: fn.entry!.kind, file: fn.file, reaches: [...reaches] })),
    effects: [...effectChanges].map(([s, fns]) => ({ label: sinkLabel.get(s) ?? s, changes: [...fns] })),
    danglingCalls: graph.edges.filter((e) => e.dangling).length,
    stats: graph.meta.stats,
  };
}

const entryName = (fn: FnNode) => (fn.qualifiedName === '(top level)' ? fn.file : fn.qualifiedName);

function lineLink(graph: CodeGraph, fn: FnNode): string | undefined {
  const r = graph.meta.remote;
  if (!r || fn.status === 'deleted') return undefined;
  const path = fn.file.split('/').map(encodeURIComponent).join('/');
  const { startLine: s, endLine: e } = fn.range;
  if (r.host === 'gitlab') return `${r.web}/-/blob/${r.commit}/${path}#L${s}-${e}`;
  if (r.host === 'bitbucket') return `${r.web}/src/${r.commit}/${path}#lines-${s}:${e}`;
  return `${r.web}/blob/${r.commit}/${path}#L${s}-L${e}`;
}

const ICON: Record<RiskLevel, string> = { high: '🔴', medium: '🟠', low: '🟢' };
/** Marks the comment so CI can find and update it instead of posting a new one. */
export const COMMENT_MARKER = '<!-- codelens-review -->';
const md = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

export function reviewMarkdown(report: ReviewReport, opts: { viewHint?: string } = {}): string {
  const { risk, changes } = report;
  const out: string[] = [COMMENT_MARKER];
  out.push(`## ${ICON[risk.level]} CodeLens: ${risk.level} risk (${risk.score.toFixed(2)})`);
  out.push('');
  out.push(report.summary);
  out.push('');
  if (!changes.length) {
    out.push('_No function-level changes in supported languages._');
    return out.join('\n');
  }
  const facts = [
    `**${changes.length}** function${changes.length === 1 ? '' : 's'} changed`,
    `**${report.stats.impactedFunctions}** caller${report.stats.impactedFunctions === 1 ? '' : 's'} affected`,
    report.entryPoints.length ? `**${report.entryPoints.length}** entry point${report.entryPoints.length === 1 ? '' : 's'} reach the change` : '',
    report.danglingCalls ? `⚠️ **${report.danglingCalls}** call${report.danglingCalls === 1 ? '' : 's'} to deleted functions` : '',
  ].filter(Boolean);
  out.push(facts.join(' · '));
  out.push('');

  out.push('### Review in this order');
  out.push('');
  out.push('| # | Function | Change | Blast radius | Callers | Notes |');
  out.push('|---|---|---|---|---|---|');
  changes.slice(0, MAX_ROWS).forEach((c, i) => {
    const name = c.link ? `[\`${md(c.name)}\`](${c.link})` : `\`${md(c.name)}\``;
    const notes = [c.breaking ? '**breaking**' : '', c.invariants.length ? `${c.invariants.length} invariant${c.invariants.length > 1 ? 's' : ''} at risk` : '', c.effects.length ? `→ ${c.effects.join(', ')}` : '']
      .filter(Boolean)
      .join(' · ');
    out.push(`| ${i + 1} | ${name}<br><sub>${md(c.file)}:${c.line}</sub> | ${c.status} | ${ICON[riskLevel(c.blastRadius)]} ${c.blastRadius.toFixed(2)} | ${c.callers} | ${md(notes)} |`);
  });
  if (changes.length > MAX_ROWS) out.push(`\n_…and ${changes.length - MAX_ROWS} more._`);
  out.push('');

  const contracts = changes.filter((c) => c.breaking && c.contract);
  if (contracts.length) {
    out.push('### Breaking contract changes');
    out.push('');
    for (const c of contracts) {
      out.push(`- **\`${c.name}\`**: ${c.contract!.description}`);
      if (c.contract!.before && c.contract!.after && c.contract!.before !== c.contract!.after) {
        out.push('  ```diff');
        out.push(`  - ${c.contract!.before}`);
        out.push(`  + ${c.contract!.after}`);
        out.push('  ```');
      }
    }
    out.push('');
  }

  const risky = changes.flatMap((c) => c.invariants.map((inv) => ({ c, inv })));
  if (risky.length) {
    out.push('<details><summary><b>Invariants at risk</b> (' + risky.length + ')</summary>');
    out.push('');
    for (const { c, inv } of risky) out.push(`- ${inv.status === 'broken' ? '❌' : '⚠️'} \`${c.name}\`: ${inv.statement}`);
    out.push('');
    out.push('</details>');
    out.push('');
  }

  if (report.entryPoints.length) {
    out.push('<details><summary><b>Entry points that reach this change</b> (' + report.entryPoints.length + ')</summary>');
    out.push('');
    for (const e of report.entryPoints.slice(0, MAX_ENTRIES)) out.push(`- ${e.kind} \`${e.name}\` → ${e.reaches.map((r) => `\`${r}\``).join(', ')}`);
    if (report.entryPoints.length > MAX_ENTRIES) out.push(`- …and ${report.entryPoints.length - MAX_ENTRIES} more`);
    out.push('');
    out.push('</details>');
    out.push('');
  }

  if (report.effects.length) {
    out.push('<details><summary><b>External systems touched</b> (' + report.effects.length + ')</summary>');
    out.push('');
    for (const e of report.effects) out.push(`- **${e.label}**, via ${e.changes.map((c) => `\`${c}\``).join(', ')}`);
    out.push('');
    out.push('</details>');
    out.push('');
  }

  out.push(`<sub>Generated by CodeLens${opts.viewHint ? ` · ${opts.viewHint}` : ''}</sub>`);
  return out.join('\n');
}
