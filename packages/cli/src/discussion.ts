// A pull request's discussion — line-comment threads, reviews, conversation — attached to the
// functions they are about, and the write side: comment on a function, reply, submit a review.
import { simpleGit } from 'simple-git';
import { githubApi, githubSend } from './github.ts';
import { parseFile, type ExtractedFile } from './parse.ts';
import type { CodeGraph, FnNode, PrComment, PrDiscussion, PrReview, PrThread } from './types.ts';

interface ApiUser {
  login: string;
}
interface ApiReviewComment {
  id: number;
  path: string;
  line: number | null;
  original_line: number | null;
  side?: 'LEFT' | 'RIGHT';
  in_reply_to_id?: number;
  commit_id: string;
  original_commit_id: string;
  user: ApiUser | null;
  body: string;
  created_at: string;
  html_url: string;
}
interface ApiReview {
  id: number;
  state: PrReview['state'];
  user: ApiUser | null;
  body: string | null;
  submitted_at: string | null;
  html_url: string;
}
interface ApiIssueComment {
  id: number;
  user: ApiUser | null;
  body: string;
  created_at: string;
  html_url: string;
}

const comment = (c: { id: number; user: ApiUser | null; body: string | null; created_at: string; html_url: string }): PrComment => ({
  id: c.id,
  author: c.user?.login ?? 'ghost',
  body: c.body ?? '',
  createdAt: c.created_at,
  url: c.html_url,
});

/**
 * Fetch the discussion and attach each thread to the function it is about. A comment made on an
 * older commit is located in the file as it was then, so it still lands on the right function
 * after later pushes; `outdated` marks it as GitHub does.
 */
export async function fetchDiscussion(graph: CodeGraph, root: string): Promise<PrDiscussion> {
  const pr = graph.meta.pr!;
  const base = `repos/${pr.repo}`;
  const [reviewComments, reviews, issueComments] = await Promise.all([
    githubApi<ApiReviewComment[]>(`${base}/pulls/${pr.number}/comments`, { paginate: true }),
    githubApi<ApiReview[]>(`${base}/pulls/${pr.number}/reviews`, { paginate: true }),
    githubApi<ApiIssueComment[]>(`${base}/issues/${pr.number}/comments`, { paginate: true }),
  ]);

  const threads = new Map<number, PrThread>();
  const byId = new Map(reviewComments.map((c) => [c.id, c]));
  const rootOf = (c: ApiReviewComment): ApiReviewComment => (c.in_reply_to_id && byId.has(c.in_reply_to_id) ? rootOf(byId.get(c.in_reply_to_id)!) : c);
  for (const c of [...reviewComments].sort((a, b) => a.created_at.localeCompare(b.created_at))) {
    const r = rootOf(c);
    let t = threads.get(r.id);
    if (!t) {
      t = { id: r.id, path: r.path, line: r.line, originalLine: r.original_line, side: r.side ?? 'RIGHT', outdated: r.line === null, comments: [] };
      threads.set(r.id, t);
    }
    t.comments.push(comment(c));
  }
  const locate = locator(graph, root);
  for (const t of threads.values()) {
    const r = byId.get(t.id)!;
    t.fnId = await locate(t.path, t.line ?? t.originalLine, t.line !== null ? graph.meta.head : r.original_commit_id, t.side);
  }

  return {
    fetchedAt: new Date().toISOString(),
    threads: [...threads.values()],
    reviews: reviews
      .filter((r) => r.state !== 'PENDING')
      .map((r) => ({ id: r.id, author: r.user?.login ?? 'ghost', state: r.state, body: r.body ?? '', submittedAt: r.submitted_at ?? '', url: r.html_url })),
    conversation: issueComments.map(comment),
  };
}

/** Finds the graph function that contained `line` of `path` at `commit`. */
function locator(graph: CodeGraph, root: string) {
  const git = simpleGit(root);
  const parsed = new Map<string, Promise<ExtractedFile | null>>();
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
  return async (path: string, line: number | null, commit: string, side: 'LEFT' | 'RIGHT'): Promise<string | undefined> => {
    if (line === null) return undefined;
    // Left-side comments are on the base version: only deleted functions still live there.
    if (side === 'LEFT') {
      const gone = graph.nodes.find((n) => n.file === path && n.status === 'deleted' && n.range.startLine <= line && line <= n.range.endLine);
      return gone?.id;
    }
    const key = `${commit}:${path}`;
    if (!parsed.has(key)) parsed.set(key, git.show([key]).then((src) => parseFile(path, src), () => null));
    const file = await parsed.get(key)!;
    if (!file) return undefined;
    const containing = file.functions
      .filter((f) => f.startLine <= line && line <= f.endLine)
      .sort((a, b) => a.endLine - a.startLine - (b.endLine - b.startLine) || Number(a.qualifiedName === '(top level)') - Number(b.qualifiedName === '(top level)'));
    for (const f of containing) {
      const id = `${path}#${f.qualifiedName}`;
      if (nodes.has(id)) return id;
    }
    return undefined;
  };
}

/**
 * Where GitHub will accept a line comment on this function: its first added line (or, for a
 * deleted function, its first removed line). Undefined when the function's lines are not in the
 * diff, in which case a comment goes on the conversation instead.
 */
export function commentTarget(fn: FnNode): { line: number; side: 'LEFT' | 'RIGHT' } | undefined {
  if (!fn.diff) return undefined;
  let oldNo = 0;
  let newNo = 0;
  for (const raw of fn.diff.split('\n')) {
    const hunk = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)/);
    if (hunk) {
      oldNo = Number(hunk[1]) + fn.range.startLine - 1;
      newNo = Number(hunk[2]) + fn.range.startLine - 1;
      continue;
    }
    if (raw.startsWith('+')) return { line: newNo, side: 'RIGHT' };
    if (raw.startsWith('-')) {
      if (fn.status === 'deleted') return { line: oldNo, side: 'LEFT' };
      oldNo++;
      continue;
    }
    oldNo++;
    newNo++;
  }
  return undefined;
}

// ---- writing ----

export type ReviewEvent = 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES';

/** Comment on a function: a line comment where GitHub allows one, else on the conversation. */
export async function commentOnFunction(graph: CodeGraph, fn: FnNode, body: string): Promise<{ kind: 'line' | 'conversation'; url: string }> {
  const pr = graph.meta.pr!;
  const target = commentTarget(fn);
  if (target) {
    try {
      const out = await githubSend<{ html_url: string }>('POST', `repos/${pr.repo}/pulls/${pr.number}/comments`, {
        body,
        commit_id: pr.headSha,
        path: fn.file,
        line: target.line,
        side: target.side,
      });
      return { kind: 'line', url: out.html_url };
    } catch (err) {
      // 422: the line is not part of the diff GitHub has (e.g. the PR moved on). Fall through.
      if (!/\b422\b/.test(String((err as Error).message))) throw err;
    }
  }
  const where = graph.meta.remote ? `[\`${fn.qualifiedName}\`](${graph.meta.remote.web}/blob/${pr.headSha}/${fn.file}#L${fn.range.startLine}-L${fn.range.endLine})` : `\`${fn.qualifiedName}\` (${fn.file}:${fn.range.startLine})`;
  const out = await githubSend<{ html_url: string }>('POST', `repos/${pr.repo}/issues/${pr.number}/comments`, { body: `On ${where}:\n\n${body}` });
  return { kind: 'conversation', url: out.html_url };
}

/** A line comment anywhere in the diff (RIGHT = the new version, LEFT = the old one). */
export async function commentOnLine(graph: CodeGraph, path: string, line: number, side: 'LEFT' | 'RIGHT', body: string): Promise<{ url: string }> {
  const pr = graph.meta.pr!;
  const out = await githubSend<{ html_url: string }>('POST', `repos/${pr.repo}/pulls/${pr.number}/comments`, { body, commit_id: pr.headSha, path, line, side });
  return { url: out.html_url };
}

export async function replyToThread(graph: CodeGraph, threadId: number, body: string): Promise<{ url: string }> {
  const pr = graph.meta.pr!;
  const out = await githubSend<{ html_url: string }>('POST', `repos/${pr.repo}/pulls/${pr.number}/comments/${threadId}/replies`, { body });
  return { url: out.html_url };
}

export async function submitReview(graph: CodeGraph, event: ReviewEvent, body: string): Promise<{ url: string }> {
  const pr = graph.meta.pr!;
  if (event !== 'APPROVE' && !body.trim()) throw new Error(event === 'REQUEST_CHANGES' ? 'say what needs to change' : 'write a comment first');
  const out = await githubSend<{ html_url: string }>('POST', `repos/${pr.repo}/pulls/${pr.number}/reviews`, { event, body, commit_id: pr.headSha });
  return { url: out.html_url };
}
