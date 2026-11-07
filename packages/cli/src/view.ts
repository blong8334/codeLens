// `codelens view`: serve the built canvas and one graph over plain HTTP, then open the browser.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { userInfo } from 'node:os';
import { openStore, type Store } from './store/index.ts';
import type { CodeGraph } from './types.ts';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

// Published: the built canvas ships next to the bundle (dist/web). In the repo: packages/web,
// rebuilt on demand when its sources change.
const PACKAGED = fileURLToPath(new URL('./web/', import.meta.url));
const WEB = fileURLToPath(new URL('../../web/', import.meta.url));
const IS_PACKAGED = existsSync(join(PACKAGED, 'index.html'));
const DIST = IS_PACKAGED ? PACKAGED.replace(/[\\/]$/, '') : join(WEB, 'dist');
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/** Build the canvas when there is no build yet, or its sources are newer than the build. */
function ensureBuilt(log: (m: string) => void) {
  if (IS_PACKAGED || !existsSync(join(WEB, 'src'))) return;
  const built = join(DIST, 'index.html');
  const newest = (dir: string): number =>
    Math.max(0, ...readdirSync(dir, { withFileTypes: true }).map((e) => (e.isDirectory() ? newest(join(dir, e.name)) : statSync(join(dir, e.name)).mtimeMs)));
  if (existsSync(built) && statSync(built).mtimeMs >= newest(join(WEB, 'src'))) return;
  log('Building the canvas…');
  const r = spawnSync('npm', ['run', 'build'], { cwd: WEB, stdio: ['ignore', 'ignore', 'inherit'] });
  if (r.status !== 0) throw new Error('building the canvas failed (run `npm run build` to see why)');
}

export async function view(graphPath: string, opts: { port?: number; open?: boolean; store?: string; log: (m: string) => void }): Promise<Server> {
  ensureBuilt(opts.log);
  // Any web page can send requests to localhost. Writes therefore need this token, which only the
  // CodeLens page itself receives (in its HTML), and every API call must name this server as its
  // host — which defeats DNS rebinding.
  const token = randomBytes(24).toString('hex');
  let storePromise: Promise<Store> | undefined;
  const getStore = () => (storePromise ??= openStore(opts.store));
  let port = 0;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (url.pathname.startsWith('/api/')) return await api(req, res, url, { graphPath, token, port: () => port, store: getStore });
      if (url.pathname === '/codelens.graph.json') {
        // Read on every request, so re-running explore and reloading the page shows the new graph.
        res.writeHead(200, { 'content-type': TYPES['.json'], 'cache-control': 'no-store' }).end(await readFile(graphPath));
        return;
      }
      const rel = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\]|\.\.)+/, '');
      const file = join(DIST, rel);
      const target = file.startsWith(DIST) && existsSync(file) && statSync(file).isFile() ? file : join(DIST, 'index.html');
      if (target.endsWith('index.html')) {
        // Pick up canvas changes made while the server runs (CodeLens development).
        ensureBuilt(opts.log);
        const html = (await readFile(target, 'utf8')).replace('<head>', `<head><meta name="codelens-token" content="${token}">`);
        res.writeHead(200, { 'content-type': TYPES['.html'], 'cache-control': 'no-store' }).end(html);
        return;
      }
      res.writeHead(200, { 'content-type': TYPES[extname(target)] ?? 'application/octet-stream' }).end(await readFile(target));
    } catch (err) {
      res.writeHead(500).end(String((err as Error).message));
    }
  });
  port = await listen(server, opts.port ?? 5173);
  const address = `http://localhost:${port}/`;
  opts.log(`CodeLens is showing ${graphPath}\n  ${address}   (Ctrl+C to stop)`);
  if (opts.open !== false) openBrowser(address);
  return server;
}

/** Listen on `port`, or the next free one. */
function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const attempt = (p: number) => {
      server.once('error', (err: NodeJS.ErrnoException) => (err.code === 'EADDRINUSE' && p < port + 20 ? attempt(p + 1) : reject(err)));
      server.listen(p, '127.0.0.1', () => resolve(p));
    };
    attempt(port);
  });
}

function openBrowser(url: string) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
}

// ---- the pull request API the canvas uses to read and write the GitHub discussion ----

const MAX_BODY = 64 * 1024;

async function api(req: IncomingMessage, res: ServerResponse, url: URL, ctx: { graphPath: string; token: string; port: () => number; store: () => Promise<Store> }) {
  const send = (status: number, data: unknown) => res.writeHead(status, { 'content-type': TYPES['.json'], 'cache-control': 'no-store' }).end(JSON.stringify(data));
  const hosts = [`localhost:${ctx.port()}`, `127.0.0.1:${ctx.port()}`];
  if (!hosts.includes(req.headers.host ?? '')) return send(403, { error: 'wrong host' });
  if (req.headers.origin && !hosts.some((h) => req.headers.origin === `http://${h}`)) return send(403, { error: 'wrong origin' });

  const { canPostToGitHub, viewerLogin } = await import('./github.ts');
  const graph = JSON.parse(await readFile(ctx.graphPath, 'utf8')) as CodeGraph;
  if (url.pathname === '/api/session' && req.method === 'GET') {
    const canPost = !!graph.meta.pr && canPostToGitHub();
    return send(200, { pr: !!graph.meta.pr, canPost, login: canPost ? await viewerLogin() : undefined, marks: !!graph.review });
  }

  // "I'm good with this file" marks: CodeLens's own, so they work for any platform (or none).
  if (url.pathname.startsWith('/api/review/')) {
    if (!graph.review) return send(404, { error: 'this graph is not a review' });
    const store = await ctx.store();
    const reviewer = await reviewerName(graph.meta.repo);
    const marks = async () => Object.fromEntries(await store.getMarks(graph.review!.key, reviewer));
    if (url.pathname === '/api/review/marks' && req.method === 'GET') return send(200, { reviewer, marks: await marks() });
    if (url.pathname === '/api/review/mark' && req.method === 'POST') {
      const denied = guardWrite(req, ctx.token);
      if (denied) return send(403, { error: denied });
      const body = await readBody(req);
      // A whole file ({ path }) or one changed function ({ fnId }, marked under its id).
      const target =
        typeof body.fnId === 'string'
          ? graph.review.functions?.[body.fnId] && { key: body.fnId, fingerprint: graph.review.functions[body.fnId] }
          : graph.review.files.find((f) => f.path === body.path) && { key: String(body.path), fingerprint: graph.review.files.find((f) => f.path === body.path)!.fingerprint };
      if (!target) return send(400, { error: typeof body.fnId === 'string' ? 'not a changed function in this review' : 'not a file in this review' });
      await store.setMark(graph.review.key, reviewer, target.key, body.reviewed ? target.fingerprint : null);
      return send(200, { reviewer, marks: await marks() });
    }
    if (url.pathname === '/api/review/reset' && req.method === 'POST') {
      const denied = guardWrite(req, ctx.token);
      if (denied) return send(403, { error: denied });
      await store.clearMarks(graph.review.key, reviewer);
      return send(200, { reviewer, marks: await marks() });
    }
    return send(404, { error: 'not found' });
  }
  if (!graph.meta.pr) return send(404, { error: 'this graph is not a pull request review' });

  const discussion = await import('./discussion.ts');
  if (url.pathname === '/api/pr/discussion' && req.method === 'GET') {
    const fresh = await discussion.fetchDiscussion(graph, graph.meta.repo);
    // Keep the file current, so the next open starts from the latest discussion.
    graph.meta.pr.discussion = fresh;
    await writeFile(ctx.graphPath, JSON.stringify(graph, null, 2));
    return send(200, fresh);
  }

  if (req.method !== 'POST') return send(405, { error: 'method not allowed' });
  const denied = guardWrite(req, ctx.token);
  if (denied) return send(denied === 'expected JSON' ? 415 : 403, { error: denied });
  const body = await readBody(req);
  const text = typeof body.body === 'string' ? body.body.trim() : '';
  try {
    if (url.pathname === '/api/pr/comment') {
      const fn = graph.nodes.find((n) => n.id === body.fnId);
      if (!fn) return send(400, { error: 'unknown function' });
      if (!text) return send(400, { error: 'write a comment first' });
      return send(200, await discussion.commentOnFunction(graph, fn, text));
    }
    if (url.pathname === '/api/pr/line-comment') {
      const { path, line, side } = body as { path?: string; line?: number; side?: string };
      if (!graph.review?.files.some((f) => f.path === path)) return send(400, { error: 'not a file in this review' });
      if (typeof line !== 'number' || line < 1 || (side !== 'LEFT' && side !== 'RIGHT') || !text) return send(400, { error: 'path, line, side and body are required' });
      return send(200, await discussion.commentOnLine(graph, path!, line, side, text));
    }
    if (url.pathname === '/api/pr/reply') {
      if (typeof body.threadId !== 'number' || !text) return send(400, { error: 'threadId and body are required' });
      return send(200, await discussion.replyToThread(graph, body.threadId, text));
    }
    if (url.pathname === '/api/pr/review') {
      const event = body.event as string;
      if (!['COMMENT', 'APPROVE', 'REQUEST_CHANGES'].includes(event)) return send(400, { error: 'event must be COMMENT, APPROVE or REQUEST_CHANGES' });
      return send(200, await discussion.submitReview(graph, event as 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES', text));
    }
  } catch (err) {
    return send(502, { error: gitHubMessage((err as Error).message) });
  }
  return send(404, { error: 'not found' });
}

/** Writes need the page's token and a JSON body (which also forces a CORS preflight). */
function guardWrite(req: IncomingMessage, token: string): string | undefined {
  const given = Buffer.from(String(req.headers['x-codelens-token'] ?? ''));
  const expected = Buffer.from(token);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return 'missing or wrong token';
  if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) return 'expected JSON';
  return undefined;
}

/** Whose marks these are: $CODELENS_REVIEWER, else git's user.name, else the OS user. */
async function reviewerName(repo: string): Promise<string> {
  if (process.env.CODELENS_REVIEWER) return process.env.CODELENS_REVIEWER;
  const { simpleGit } = await import('simple-git');
  const name = await simpleGit(repo).raw(['config', 'user.name']).then((s) => s.trim(), () => '');
  return name || userInfo().username;
}

/** GitHub's own message ("Can not approve your own pull request") rather than the whole error. */
function gitHubMessage(raw: string): string {
  const m = raw.match(/"message"\s*:\s*"([^"]+)"/g);
  const messages = m?.map((x) => x.replace(/^"message"\s*:\s*"|"$/g, '')) ?? [];
  return messages.length ? [...new Set(messages)].join(' — ') : raw.slice(0, 300);
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('request too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(new Error('invalid JSON'));
      }
    });
  });
}
