// Prompts and output schemas shared by every LLM-backed provider (Claude API, Claude Code).
import * as z from 'zod/v4';
import type { NodeContext } from './enrich.ts';
import type { GroupInput, PurposeInput } from './purpose.ts';
import type { CodeGraph, FnNode, NodeEnrichment } from './types.ts';

export const NodeSchema = z.object({
  summary: z.string().describe('One or two sentences: what changed and why a reviewer should care.'),
  contract: z.object({
    breaking: z.boolean(),
    description: z.string().describe('How the observable contract (inputs, outputs, errors, side effects) shifted.'),
  }),
  invariants: z.array(
    z.object({
      statement: z.string().describe('A property callers or the system rely on, phrased as an assertion.'),
      status: z.enum(['preserved', 'at-risk', 'broken']),
      risk: z.enum(['low', 'medium', 'high']),
      evidence: z.string().describe('The specific line(s) or construct that support the status.'),
    }),
  ),
  blastRadius: z.number().describe('0.0 (isolated, safe) to 1.0 (system-wide breakage likely).'),
  reasons: z.array(z.string()).describe('Short factors that drove the blast radius score.'),
});

export const SYSTEM = `You are a senior reviewer analyzing one function-level change inside a pull request.
You are given the function before and after, its signature, its direct callers and callees, and statistics from a static call graph.
Identify contract shifts (inputs, outputs, thrown errors, side effects, sync/async behavior), the invariants callers depend on and whether this change preserves them, and a calibrated blast radius score.
Ground every claim in the code shown. The static heuristic analysis is included as a starting point; correct it where it is wrong. Keep invariants to the 1-5 that matter most.`;

export const SUMMARY_SYSTEM =
  'You write the opening paragraph of a code review. Be concrete and brief (3-4 sentences). Use backticks for identifiers. No headings or bullet points.';

export function summaryPrompt(graph: CodeGraph, ranked: FnNode[]): string {
  const lines = ranked.map(
    (n) => `- ${n.qualifiedName} (${n.file}, ${n.status}, blast ${n.enrichment!.blastRadius}): ${n.enrichment!.summary}`,
  );
  return `Repository changes (${graph.meta.base} → ${graph.meta.head}), highest blast radius first:\n${lines.join('\n')}\n\nSummarize the overall change, the riskiest areas, and where review should start.`;
}

/** Merge a model's structured answer with the deterministic contract details. */
export function toEnrichment(ctx: NodeContext, out: z.infer<typeof NodeSchema>): NodeEnrichment {
  return {
    summary: out.summary,
    contract: { ...ctx.heuristic.contract, breaking: out.contract.breaking, description: out.contract.description },
    invariants: out.invariants,
    blastRadius: Math.max(0, Math.min(1, Math.round(out.blastRadius * 100) / 100)),
    reasons: out.reasons,
    source: 'llm',
  };
}

export function renderContext(ctx: NodeContext): string {
  const { node, heuristic } = ctx;
  const fence = (s: string) => '```' + node.language + '\n' + s + '\n```';
  const list = (fns: typeof ctx.callers) =>
    fns.length ? fns.map((f) => `- ${f.qualifiedName} (${f.file}) ${f.signature.text}`).join('\n') : '- (none)';
  return [
    `## Function \`${node.qualifiedName}\` in \`${node.file}\` — ${node.status}`,
    node.before ? `### Before\n${fence(node.before.source)}` : '',
    node.after ? `### After\n${fence(node.after.source)}` : '',
    `### Direct callers\n${list(ctx.callers)}`,
    `### Direct callees\n${list(ctx.callees)}`,
    `### Graph statistics\n- transitive callers: ${node.transitiveCallers}\n- files reached: ${ctx.modulesReached}\n- exported: ${node.exported}\n- dangling call sites (deleted target): ${ctx.danglingCallers}`,
    `### Heuristic analysis\n${JSON.stringify({ contract: heuristic.contract, invariants: heuristic.invariants, blastRadius: heuristic.blastRadius, reasons: heuristic.reasons }, null, 2)}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

// ---- purpose ("what / why") for functions ----

export const PurposeSchema = z.object({
  items: z.array(
    z.object({
      id: z.string().describe('The bracketed id of the function, e.g. f3.'),
      what: z.string().describe('What it does: one sentence, at most 20 words, present tense.'),
      why: z.string().describe('Why it exists: its role for its callers or the system, one sentence, at most 20 words.'),
    }),
  ),
});

export const PURPOSE_SYSTEM = `You document code so reviewers can orient quickly in an unfamiliar codebase.
For each function, write "what" (what it does) and "why" (the role it plays for its callers or the wider system).
Each is one plain sentence of at most 20 words. Do not just restate the name; say what a reader could not guess from it.
Base every claim on the code and call context shown. If the purpose is genuinely unclear, say so briefly.
Return one item per function, using its bracketed id.`;

export function purposePrompt(items: PurposeInput[]): string {
  return items
    .map(({ key, node, callers, callees }) =>
      [
        `### [${key}] \`${node.qualifiedName}\` in ${node.file}`,
        `callers: ${callers.join(', ') || '(none found)'}`,
        `callees: ${callees.join(', ') || '(none)'}`,
        node.entry ? `entry point: ${node.entry.kind} (${node.entry.reason})` : '',
        node.effects.length ? `external effects: ${node.effects.map((e) => e.replace('sink:', '')).join(', ')}` : '',
        node.doc ? `doc comment: ${node.doc}` : '',
        '```' + node.language + '\n' + node.source.slice(0, 2500) + '\n```',
      ]
        .filter(Boolean)
        .join('\n'),
    )
    .join('\n\n');
}

// ---- one-line summaries for files, modules, systems ----

export const GroupSchema = z.object({
  items: z.array(
    z.object({
      id: z.string().describe('The bracketed id of the group, e.g. g2.'),
      summary: z.string().describe("The group's responsibility in one sentence of at most 25 words."),
    }),
  ),
});

export const GROUP_SYSTEM = `You summarize parts of a codebase (files, modules, subsystems) for a zoomed-out architecture view.
For each group, write one sentence of at most 25 words describing its responsibility, based on its members' summaries.
Name the domain concepts it owns; avoid listing every member. Return one item per group, using its bracketed id.`;

export function groupPrompt(items: GroupInput[]): string {
  return items
    .map(({ key, group, children }) =>
      [`### [${key}] ${group.kind} "${group.label}"`, ...children.map((c) => `- ${c.label}: ${c.summary}`)].join('\n'),
    )
    .join('\n\n');
}

export const toPurposeMap = (out: z.infer<typeof PurposeSchema>) => new Map(out.items.map((i) => [i.id, { what: i.what, why: i.why }]));
export const toGroupMap = (out: z.infer<typeof GroupSchema>) => new Map(out.items.map((i) => [i.id, i.summary]));
