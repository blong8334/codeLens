// Ask about the change under review, from inside the review. The model gets the brief, the change
// you are looking at, and your preferences; with Claude Code it can also read the whole codebase as
// it is after the change (a read-only copy in the CodeLens cache), through file tools only.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { WORKING_TREE } from './git.ts';
import { cacheDir } from './store/index.ts';
import type { CodeGraph, FnNode } from './types.ts';

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  system: string;
  messages: ChatTurn[];
  /** A directory holding the code after the change, for providers that can read files. */
  cwd?: string;
  /** Provider conversation id from the previous reply, to continue it. */
  session?: string;
}

export interface ChatReply {
  text: string;
  session?: string;
}

/**
 * The code as it is after the change, as plain files: the working tree itself when the review is of
 * uncommitted changes, else a copy of the head commit in the cache (made once per commit, never
 * registered with the repository).
 */
export async function headCheckout(graph: CodeGraph): Promise<string> {
  const repo = graph.meta.repo;
  if (graph.meta.head === WORKING_TREE) return repo;
  const commit = (await run('git', ['-C', repo, 'rev-parse', `${graph.meta.head}^{commit}`])).trim();
  const dir = join(cacheDir(), 'checkouts', `${createHash('sha1').update(repo).digest('hex').slice(0, 8)}-${commit.slice(0, 12)}`);
  if (existsSync(dir)) return dir;
  const tmp = `${dir}.tmp-${process.pid}`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  await run('sh', ['-c', 'git -C "$1" archive "$2" | tar -x -C "$3"', 'sh', repo, commit, tmp]);
  renameSync(tmp, dir);
  return dir;
}

export const CHAT_SYSTEM = `You are helping a developer review a code change, inside their review tool.
Answer what they ask, concretely and briefly, grounded in the code; name functions and files in
backticks; say when you are unsure. When you can read files, the working directory holds the code
as it is after the change: look things up (callers, similar code, how something is used) rather
than guessing. You cannot change code or run commands; suggest changes as short snippets.`;

const name = (n: FnNode) => `\`${n.qualifiedName}\` (${n.file})`;

/** What the model knows about the review as a whole: once per conversation. */
export function chatSystem(graph: CodeGraph, opts: { canRead: boolean }): string {
  const b = graph.enrichment?.brief;
  const changed = graph.nodes.filter((n) => n.status !== 'unchanged');
  const title = graph.meta.pr?.title ?? graph.meta.change?.title;
  const description = graph.meta.pr?.body ?? graph.meta.change?.description;
  return [
    CHAT_SYSTEM,
    opts.canRead ? 'You have read-only file tools (Read, Grep, Glob) on the code after the change.' : 'You cannot read files: work from the context below and say what you would need to see.',
    `# The change under review${title ? `: ${title}` : ''}`,
    description ? `## Author's description\n${description.slice(0, 3000)}` : '',
    b ? `## Brief\n${b.overview}\n\nRisks:\n${b.risks.map((r) => `- ${r.title}: ${r.detail}`).join('\n') || '- (none listed)'}` : '',
    `## Changed functions (${changed.length})\n${changed
      .slice(0, 80)
      .map((n) => `- ${name(n)} ${n.status}${n.moved ? ` (moved from ${n.moved.from})` : ''}${n.enrichment ? `: ${n.enrichment.summary}` : ''}`)
      .join('\n')}`,
    `## Changed files\n${(graph.review?.files ?? []).map((f) => `- ${f.path} (${f.status}, +${f.additions} −${f.deletions})`).join('\n')}`,
    graph.review?.preferences ? `## The reviewer's preferences\n${graph.review.preferences.text}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** The change the reviewer has open when they ask: sent with each question. */
export function chatFocus(graph: CodeGraph, fnId: string | undefined): string {
  const fn = fnId ? graph.nodes.find((n) => n.id === fnId) : undefined;
  if (!fn) return '';
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const callers = graph.edges.filter((e) => e.target === fn.id).map((e) => byId.get(e.source)).filter((n): n is FnNode => !!n);
  const callees = graph.edges.filter((e) => e.source === fn.id).map((e) => byId.get(e.target)).filter((n): n is FnNode => !!n);
  const e = fn.enrichment;
  return [
    `[The reviewer is looking at ${name(fn)}, ${fn.status}.]`,
    e ? `Analysis: ${e.summary}${e.reasons.length ? ` (${e.reasons.join('; ')})` : ''}` : '',
    fn.diff ? '```diff\n' + fn.diff.slice(0, 8000) + '\n```' : '',
    callers.length ? `Called by: ${callers.slice(0, 15).map(name).join(', ')}` : 'No callers in the graph.',
    callees.length ? `Calls: ${callees.slice(0, 15).map(name).join(', ')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export function run(cmd: string, args: string[], opts: { cwd?: string; input?: string } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} failed: ${(err || out).trim().slice(0, 300)}`))));
    child.stdin.end(opts.input ?? '');
  });
}
