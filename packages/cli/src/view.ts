// `codelens view`: serve the built canvas and one graph over plain HTTP, then open the browser.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = fileURLToPath(new URL('../../web/', import.meta.url));
const DIST = join(WEB, 'dist');
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
  const built = join(DIST, 'index.html');
  const newest = (dir: string): number =>
    Math.max(0, ...readdirSync(dir, { withFileTypes: true }).map((e) => (e.isDirectory() ? newest(join(dir, e.name)) : statSync(join(dir, e.name)).mtimeMs)));
  if (existsSync(built) && statSync(built).mtimeMs >= newest(join(WEB, 'src'))) return;
  log('Building the canvas…');
  const r = spawnSync('npm', ['run', 'build'], { cwd: WEB, stdio: ['ignore', 'ignore', 'inherit'] });
  if (r.status !== 0) throw new Error('building the canvas failed (run `npm run build` to see why)');
}

export async function view(graphPath: string, opts: { port?: number; open?: boolean; log: (m: string) => void }): Promise<Server> {
  ensureBuilt(opts.log);
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (url.pathname === '/codelens.graph.json') {
        // Read on every request, so re-running explore and reloading the page shows the new graph.
        res.writeHead(200, { 'content-type': TYPES['.json'], 'cache-control': 'no-store' }).end(await readFile(graphPath));
        return;
      }
      const rel = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\]|\.\.)+/, '');
      const file = join(DIST, rel);
      const target = file.startsWith(DIST) && existsSync(file) && statSync(file).isFile() ? file : join(DIST, 'index.html');
      res.writeHead(200, { 'content-type': TYPES[extname(target)] ?? 'application/octet-stream' }).end(await readFile(target));
    } catch (err) {
      res.writeHead(500).end(String((err as Error).message));
    }
  });
  const port = await listen(server, opts.port ?? 5173);
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
