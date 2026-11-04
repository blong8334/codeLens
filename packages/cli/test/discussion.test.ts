// Pull request discussion against a fake GitHub: never the real one. CODELENS_NO_GH keeps the
// signed-in `gh` CLI out of it, and CODELENS_GITHUB_API points every request at a local server.
process.env.CODELENS_NO_GH = '1';
process.env.GITHUB_TOKEN = 'test-token';

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { commentOnFunction, commentTarget, fetchDiscussion, replyToThread, submitReview } from '../src/discussion.ts';
import type { CodeGraph, FnNode } from '../src/types.ts';

interface Call {
  method: string;
  path: string;
  body?: Record<string, unknown>;
  auth?: string;
}
const calls: Call[] = [];
let reject422 = false;
let fixtures: Record<string, unknown[]> = {};

const server = createServer((req, res) => {
  let raw = '';
  req.on('data', (d) => (raw += d));
  req.on('end', () => {
    const url = new URL(req.url!, 'http://x');
    calls.push({ method: req.method!, path: url.pathname, body: raw ? JSON.parse(raw) : undefined, auth: req.headers.authorization });
    const json = (status: number, data: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(data));
    if (req.method === 'GET') {
      const page = Number(url.searchParams.get('page') ?? 1);
      return json(200, page === 1 ? (fixtures[url.pathname] ?? []) : []);
    }
    if (reject422 && url.pathname.endsWith('/pulls/7/comments')) return json(422, { message: 'Validation Failed', errors: [{ message: 'line must be part of the diff' }] });
    json(201, { html_url: `https://github.example/${url.pathname}#new` });
  });
});

let repoDir = '';
let firstCommit = '';
before(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  process.env.CODELENS_GITHUB_API = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  repoDir = mkdtempSync(join(tmpdir(), 'codelens-discussion-'));
  const git = (...a: string[]) => execFileSync('git', a, { cwd: repoDir, stdio: 'pipe' }).toString().trim();
  git('init', '-q');
  git('config', 'user.email', 't@codelens.dev');
  git('config', 'user.name', 'T');
  writeFileSync(join(repoDir, 'pay.ts'), 'export function charge(a: number) {\n  return a;\n}\n\nexport function refund(a: number) {\n  return -a;\n}\n');
  git('add', '-A');
  git('commit', '-qm', 'one');
  firstCommit = git('rev-parse', 'HEAD');
  // A later push moves both functions down two lines: old line numbers no longer match.
  writeFileSync(join(repoDir, 'pay.ts'), '// payments\n\nexport function charge(a: number) {\n  return a * 1;\n}\n\nexport function refund(a: number) {\n  return -a;\n}\n');
  git('commit', '-qam', 'two');
});
after(() => {
  server.close();
  rmSync(repoDir, { recursive: true, force: true });
});

function node(name: string, start: number, end: number, diff?: string): FnNode {
  return {
    id: `pay.ts#${name}`, name, qualifiedName: name, file: 'pay.ts', language: 'typescript', kind: 'function', exported: true,
    range: { startLine: start, endLine: end }, signature: { params: [], async: false, text: '' }, status: diff ? 'modified' : 'unchanged',
    depth: null, downDepth: null, transitiveCallers: 0, source: '', throws: [], groups: { file: '', module: '', system: '' }, effects: [], diff,
  };
}
const graph = (): CodeGraph => ({
  version: 2,
  meta: {
    repo: repoDir, base: 'a', head: 'HEAD', generatedAt: '', stats: { filesParsed: 1, functions: 2, changedFunctions: 1, impactedFunctions: 0 },
    remote: { web: 'https://github.com/acme/shop', host: 'github', commit: 'abc' },
    pr: { number: 7, title: 't', url: 'u', author: 'me', state: 'open', baseRef: 'main', headRef: 'f', repo: 'acme/shop', headSha: 'headsha', body: '' },
  },
  // charge changed its return line (function line 2 → file line 4); refund is untouched.
  nodes: [node('charge', 3, 5, '@@ -1,3 +1,3 @@\n export function charge(a: number) {\n-  return a;\n+  return a * 1;\n }'), node('refund', 7, 9)],
  edges: [], groups: [], sinks: [],
});

test('commentTarget: the first added line, in file coordinates', () => {
  assert.deepEqual(commentTarget(graph().nodes[0]), { line: 4, side: 'RIGHT' });
  assert.equal(commentTarget(graph().nodes[1]), undefined, 'unchanged functions have no diff line');
});

test('discussion: threads grouped and located, even when outdated', async () => {
  const c = (id: number, extra: Record<string, unknown>) => ({ id, path: 'pay.ts', side: 'RIGHT', commit_id: 'headsha', original_commit_id: firstCommit, user: { login: `u${id}` }, body: `b${id}`, created_at: `2026-01-0${id}T00:00:00Z`, html_url: `h${id}`, line: null, original_line: null, ...extra });
  fixtures = {
    '/repos/acme/shop/pulls/7/comments': [
      c(1, { original_line: 2 }), // outdated: line 2 was inside charge at the first commit
      c(2, { in_reply_to_id: 1 }),
      c(3, { line: 8, original_line: 8, original_commit_id: 'headsha' }), // current: refund in head
      c(4, { in_reply_to_id: 2 }), // reply to a reply joins the same thread
    ],
    '/repos/acme/shop/pulls/7/reviews': [{ id: 9, state: 'APPROVED', user: { login: 'lead' }, body: '', submitted_at: '2026-01-05T00:00:00Z', html_url: 'r9' }, { id: 10, state: 'PENDING', user: { login: 'x' }, body: '', submitted_at: null, html_url: '' }],
    '/repos/acme/shop/issues/7/comments': [{ id: 20, user: { login: 'bot' }, body: 'hello', created_at: '2026-01-01T00:00:00Z', html_url: 'i20' }],
  };
  const g = graph();
  g.meta.head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir }).toString().trim();
  const d = await fetchDiscussion(g, repoDir);
  assert.equal(d.threads.length, 2);
  const [first, second] = d.threads;
  assert.deepEqual(first.comments.map((x) => x.id), [1, 2, 4]);
  assert.equal(first.outdated, true);
  assert.equal(first.fnId, 'pay.ts#charge', 'outdated comment located in the file as it was');
  assert.equal(second.fnId, 'pay.ts#refund');
  assert.deepEqual(d.reviews.map((r) => r.state), ['APPROVED'], 'pending reviews are private');
  assert.equal(d.conversation[0].body, 'hello');
  assert.ok(calls.some((x) => x.path.endsWith('/pulls/7/comments') && x.auth === 'Bearer test-token'));
});

test('writing: line comments, fallback to the conversation, replies and reviews', async () => {
  calls.length = 0;
  const g = graph();
  const [charge, refund] = g.nodes;

  const line = await commentOnFunction(g, charge, 'nice');
  assert.equal(line.kind, 'line');
  assert.deepEqual(calls.at(-1), { method: 'POST', path: '/repos/acme/shop/pulls/7/comments', auth: 'Bearer test-token', body: { body: 'nice', commit_id: 'headsha', path: 'pay.ts', line: 4, side: 'RIGHT' } });

  reject422 = true;
  const fallback = await commentOnFunction(g, charge, 'again');
  reject422 = false;
  assert.equal(fallback.kind, 'conversation', 'a rejected line comment goes on the conversation');
  assert.equal(calls.at(-1)!.path, '/repos/acme/shop/issues/7/comments');
  assert.match(String(calls.at(-1)!.body!.body), /^On \[`charge`\]\(https:\/\/github\.com\/acme\/shop\/blob\/headsha\/pay\.ts#L3-L5\):\n\nagain$/);

  const unchanged = await commentOnFunction(g, refund, 'why?');
  assert.equal(unchanged.kind, 'conversation');

  await replyToThread(g, 1, 'agreed');
  assert.deepEqual(calls.at(-1), { method: 'POST', path: '/repos/acme/shop/pulls/7/comments/1/replies', auth: 'Bearer test-token', body: { body: 'agreed' } });

  await assert.rejects(submitReview(g, 'REQUEST_CHANGES', '  '), /say what needs to change/);
  await submitReview(g, 'APPROVE', '');
  assert.deepEqual(calls.at(-1)!.body, { event: 'APPROVE', body: '', commit_id: 'headsha' });
});
