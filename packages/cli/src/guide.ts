// The package guide: the page explore mode opens on. A short "what is this", how it is organized,
// and where to start reading. Written by the LLM from the README and the existing descriptions
// (one request per explore, stored by content) or, offline, assembled from the README and summaries.
import { createHash } from 'node:crypto';
import type { Describer } from './purpose.ts';
import type { Store } from './store.ts';
import type { CodeGraph, FnNode, Group, Guide } from './types.ts';

export interface GuideInput {
  name: string;
  readme?: string;
  parts: { label: string; kind: string; functions: number; summary: string }[];
  /** Candidate starting points, keyed c1, c2, … */
  candidates: { key: string; node: FnNode; role: string; callers: number; callees: number }[];
}

export interface GuideOutput {
  summary: string;
  architecture: string[];
  startHere: { key: string; reason: string }[];
}

const MAX_CANDIDATES = 24;
const ENTRY_RANK = ['main', 'route', 'cli', 'job', 'config', 'public-api'];

export async function buildGuide(
  graph: CodeGraph,
  describer: Describer,
  opts: { store?: Store; log: (m: string) => void },
): Promise<Guide> {
  const input = guideInput(graph);
  const byKey = new Map(input.candidates.map((c) => [c.key, c.node.id]));
  const fallback = heuristicGuide(input);
  if (!describer.describeGuide || describer.name === 'heuristic') return finish(fallback, byKey, input.readme ? 'readme' : 'heuristic');

  const key = createHash('sha1')
    .update([describer.name, 'guide', JSON.stringify({ ...input, candidates: input.candidates.map((c) => [c.key, c.node.id, c.node.purpose?.what, c.role]) })].join('\0'))
    .digest('hex');
  const cached = opts.store?.getDescription<GuideOutput>(key);
  if (cached) return finish(cached, byKey, 'llm');
  opts.log('  writing the package guide');
  try {
    const out = await describer.describeGuide(input);
    opts.store?.putDescription(key, 'group', out);
    return finish(out, byKey, 'llm');
  } catch (err) {
    opts.log(`  ! guide failed (${(err as Error).message}); using the README and summaries`);
    return finish(fallback, byKey, input.readme ? 'readme' : 'heuristic');
  }
}

function finish(out: GuideOutput, byKey: Map<string, string>, source: Guide['source']): Guide {
  return {
    summary: out.summary,
    architecture: out.architecture,
    startHere: out.startHere.flatMap((s) => (byKey.has(s.key) ? [{ id: byKey.get(s.key)!, reason: s.reason }] : [])),
    source,
  };
}

export function guideInput(graph: CodeGraph): GuideInput {
  const fns = new Map(graph.nodes.map((n) => [n.id, n]));
  const inside = (g: Group) => g.fnIds.filter((id) => !fns.get(id)?.outside);
  const testy = (g: Group) => inside(g).filter((id) => fns.get(id)?.entry?.kind === 'test').length > inside(g).length / 2;
  const systems = graph.groups.filter((g) => g.kind === 'system' && inside(g).length && !testy(g));
  const at = (kind: Group['kind']) => graph.groups.filter((g) => g.kind === kind && inside(g).length && !testy(g));
  // The coarsest level with more than one part: systems, else modules, else files.
  const level = systems.length > 1 ? systems : at('module').length > 1 ? at('module') : at('file');
  const parts = level
    .sort((a, b) => inside(b).length - inside(a).length)
    .slice(0, 12)
    .map((g) => ({ label: g.label, kind: g.kind, functions: inside(g).length, summary: g.summary ?? '' }));

  const callers = new Map<string, number>();
  const callees = new Map<string, number>();
  for (const e of graph.edges) {
    callers.set(e.target, (callers.get(e.target) ?? 0) + 1);
    callees.set(e.source, (callees.get(e.source) ?? 0) + 1);
  }
  const ex = graph.explore;
  const entries = (ex?.entries ?? [])
    .map((id) => fns.get(id)!)
    .filter((n) => n && n.entry!.kind !== 'test')
    .sort((a, b) => ENTRY_RANK.indexOf(a.entry!.kind) - ENTRY_RANK.indexOf(b.entry!.kind) || (callees.get(b.id) ?? 0) - (callees.get(a.id) ?? 0));
  const picked = new Map<string, { node: FnNode; role: string }>();
  // Interleave entry points and hotspots so both kinds of starting point are on offer.
  const hot = (ex?.hotspots ?? []).map((h) => fns.get(h.id)!).filter(Boolean);
  for (let i = 0; picked.size < MAX_CANDIDATES && (i < entries.length || i < hot.length); i++) {
    if (entries[i] && !picked.has(entries[i].id)) picked.set(entries[i].id, { node: entries[i], role: `entry point (${entries[i].entry!.kind})` });
    if (hot[i] && !picked.has(hot[i].id)) picked.set(hot[i].id, { node: hot[i], role: 'hotspot' });
  }
  return {
    name: graph.meta.scope ? `${graph.meta.repo.split('/').pop()}/${graph.meta.scope}` : graph.meta.repo.split('/').pop()!,
    readme: ex?.readme?.text,
    parts,
    candidates: [...picked.values()].map((p, i) => ({ key: `c${i + 1}`, ...p, callers: callers.get(p.node.id) ?? 0, callees: callees.get(p.node.id) ?? 0 })),
  };
}

/** Offline: the README's opening paragraph, the parts' summaries, and the strongest starting points. */
export function heuristicGuide(input: GuideInput): GuideOutput {
  const intro = input.readme ? readmeIntro(input.readme) : undefined;
  const fnCount = input.parts.reduce((n, p) => n + p.functions, 0);
  const summary =
    intro ??
    (input.parts.length
      ? `${input.name} has ${fnCount} functions in ${input.parts.length} ${input.parts[0].kind}s. ${input.parts[0].summary}`
      : `${input.name}: no summary available.`);
  const architecture = input.parts.slice(0, 6).map((p) => `${p.label} (${p.functions} functions): ${p.summary || 'no summary yet'}`);
  const entries = input.candidates.filter((c) => c.role.startsWith('entry') && !c.role.includes('public-api'));
  const rest = input.candidates.filter((c) => !entries.includes(c));
  const startHere = [...entries.slice(0, 3), ...rest]
    .slice(0, 5)
    .map((c) => ({ key: c.key, reason: c.node.purpose?.what ?? (c.node.entry ? `Entry point: ${c.node.entry.reason}.` : `Called by ${c.callers} functions.`) }));
  return { summary, architecture, startHere };
}

/** First real paragraph of a README: skips headings, badges, images, HTML and code. */
export function readmeIntro(markdown: string): string | undefined {
  const blocks = markdown
    .replace(/```[\s\S]*?```/g, '')
    .replace(/<[^>]+>/g, ' ')
    .split(/\n\s*\n/)
    .map((b) => b.trim());
  for (const b of blocks) {
    if (!b || /^(#|=|-{3}|\||!\[|\[!\[)/.test(b)) continue;
    const text = b
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/[*_`]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (text.length >= 40 && /[a-z]/.test(text)) return text.length > 600 ? `${text.slice(0, 600).replace(/\s+\S*$/, '')}…` : text;
  }
  return undefined;
}
