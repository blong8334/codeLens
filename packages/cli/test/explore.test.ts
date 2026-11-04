// Explore mode and the store: whole-package graphs, entry points, hotspots, content-keyed caching,
// and "what changed since you last looked".
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { explore } from '../src/explore.ts';
import { describeGraph, heuristicDescriber, type Describer } from '../src/purpose.ts';
import { Store } from '../src/store.ts';

const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function tempDir(files: Record<string, string>, git = true) {
  const dir = mkdtempSync(join(tmpdir(), 'codelens-explore-'));
  dirs.push(dir);
  write(dir, files);
  if (git) {
    gitIn(dir, 'init', '-q', '-b', 'main');
    gitIn(dir, 'config', 'user.email', 'test@codelens.dev');
    gitIn(dir, 'config', 'user.name', 'CodeLens Test');
    commit(dir, 'base');
  }
  return dir;
}
const write = (dir: string, files: Record<string, string>) => {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
};
const gitIn = (dir: string, ...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
const commit = (dir: string, msg: string) => {
  gitIn(dir, 'add', '-A');
  gitIn(dir, 'commit', '-qm', msg);
};

const SHOP = {
  'package.json': '{"name":"shop"}',
  'api/server.ts': `import express from 'express';
import { placeOrder } from '../orders/place';

const app = express();
app.post('/orders', (req, res) => res.json(placeOrder(req.body.items)));
app.listen(3000);
`,
  'orders/place.ts': `import { price } from './price';
import { save } from '../db/store';

export function placeOrder(items: string[]) {
  const total = price(items);
  return save({ items, total });
}
`,
  'orders/price.ts': `const cache = new Map<string, number>();

export function price(items: string[]) {
  return items.reduce((sum, i) => sum + unitPrice(i), 0);
}

function unitPrice(item: string) {
  return cache.get(item) ?? 1;
}
`,
  'db/store.ts': `import { Pool } from 'pg';
const pool = new Pool();

export class Store {
  get(id: string) {
    return pool.query('select * from orders where id = $1', [id]);
  }
}

export function save(order: object) {
  return pool.query('insert into orders values ($1)', [order]);
}
`,
  'orders/place.test.ts': `import { placeOrder } from './place';
test('places an order', () => placeOrder(['a']));
`,
};

const fn = (g: Awaited<ReturnType<typeof explore>>['graph'], q: string) => {
  const n = g.nodes.find((x) => x.id.endsWith(`#${q}`) || x.qualifiedName === q);
  assert.ok(n, `missing ${q}; have ${g.nodes.map((x) => x.id).join(', ')}`);
  return n;
};

test('explore: whole-package graph with entry points, hotspots and effects', async () => {
  const dir = tempDir(SHOP);
  const { graph } = await explore(dir, { store: new Store(':memory:') });
  assert.equal(graph.meta.mode, 'explore');
  const server = graph.nodes.find((n) => n.file === 'api/server.ts')!;
  assert.equal(server.qualifiedName, '(top level)', 'route wiring at top level is kept');
  assert.equal(server.entry?.kind, 'main');
  assert.ok(graph.edges.some((e) => e.source === server.id && e.target.endsWith('#placeOrder')), 'top level → placeOrder');
  assert.deepEqual(fn(graph, 'save').effects, ['sink:database']);
  assert.ok(graph.explore!.entries.includes(server.id));
  assert.ok(graph.explore!.hotspots.some((h) => h.id.endsWith('#placeOrder')));
  // `cache.get()` on a Map is not Store.get.
  assert.ok(!graph.edges.some((e) => e.source.endsWith('#unitPrice')), `unitPrice calls nothing of ours: ${graph.edges.map((e) => e.id).join(' ')}`);
  // Test code is attributed through its top level.
  assert.equal(graph.nodes.find((n) => n.file === 'orders/place.test.ts')?.entry?.kind, 'test');
});

test('explore: a subdirectory keeps one hop of outside context', async () => {
  const dir = tempDir(SHOP);
  const { graph } = await explore(join(dir, 'orders'), { store: new Store(':memory:') });
  assert.equal(graph.meta.scope, 'orders');
  assert.ok(!fn(graph, 'placeOrder').outside);
  assert.equal(fn(graph, 'save').outside, true, 'callee outside the scope');
  assert.equal(graph.nodes.find((n) => n.file === 'api/server.ts')?.outside, true, 'caller outside the scope');
  assert.ok(!graph.nodes.some((n) => n.id.endsWith('#Store.get')), 'unrelated outside code is left out');
  assert.equal(graph.meta.stats.functions, graph.nodes.filter((n) => !n.outside).length);
});

test('store: parses are reused by content, and snapshots report what changed', async () => {
  const dir = tempDir(SHOP);
  const store = new Store(':memory:');
  const logs: string[] = [];
  const first = await explore(dir, { store, log: (m) => logs.push(m) });
  assert.equal(first.graph.explore!.since, undefined, 'nothing to compare the first time');
  first.record('heuristic');

  logs.length = 0;
  const again = await explore(dir, { store, log: (m) => logs.push(m) });
  assert.ok(logs.some((l) => /from cache, 0 parsed/.test(l)), logs.join('\n'));
  assert.equal(again.graph.explore!.since?.identical, true);
  again.record('heuristic');

  write(dir, {
    'orders/price.ts': SHOP['orders/price.ts'].replace('?? 1', '?? 2') + '\nexport function discount(total: number) {\n  return total * 0.9;\n}\n',
  });
  commit(dir, 'change pricing');
  logs.length = 0;
  const changed = await explore(dir, { store, log: (m) => logs.push(m) });
  const since = changed.graph.explore!.since!;
  assert.equal(since.identical, false);
  assert.equal(since.added, 1);
  assert.equal(since.changed, 1);
  assert.equal(fn(changed.graph, 'discount').since, 'new');
  assert.equal(fn(changed.graph, 'unitPrice').since, 'changed');
  assert.equal(fn(changed.graph, 'placeOrder').since, undefined);
  assert.ok(logs.some((l) => /1 parsed/.test(l)), `only the edited file is re-parsed: ${logs.join('\n')}`);
});

test('store: descriptions are written once per function content', async () => {
  const dir = tempDir(SHOP);
  const store = new Store(':memory:');
  let calls = 0;
  const counting: Describer = {
    name: 'counting',
    async describeFunctions(items) {
      calls += items.length;
      return new Map(items.map((i) => [i.key, { what: `does ${i.node.name}`, why: 'tests' }]));
    },
    describeGroups: heuristicDescriber.describeGroups,
  };
  const opts = { store, concurrency: 2, log: () => {} };
  const a = await explore(dir, { store });
  await describeGraph(a.graph, counting, heuristicDescriber, opts);
  const firstCalls = calls;
  assert.ok(firstCalls > 0);
  assert.equal(fn(a.graph, 'placeOrder').purpose?.what, 'does placeOrder');

  const b = await explore(dir, { store });
  const out = await describeGraph(b.graph, counting, heuristicDescriber, opts);
  assert.equal(calls, firstCalls, 'second run is served entirely from the store');
  assert.equal(out.described, 0);
  assert.equal(fn(b.graph, 'placeOrder').purpose?.source, 'llm');

  write(dir, { 'orders/place.ts': SHOP['orders/place.ts'].replace('const total', 'const sum = 0;\n  const total') });
  const c = await explore(dir, { store });
  await describeGraph(c.graph, counting, heuristicDescriber, opts);
  assert.equal(calls, firstCalls + 1, 'only the edited function is described again');
});

test('explore: works on a plain directory without git', async () => {
  const dir = tempDir({ 'tool.py': 'import subprocess\n\ndef run(cmd):\n    return subprocess.run(cmd)\n\nif __name__ == "__main__":\n    run(["ls"])\n' }, false);
  const { graph } = await explore(dir, { store: new Store(':memory:') });
  assert.equal(graph.explore!.snapshot.commit, null);
  const top = graph.nodes.find((n) => n.qualifiedName === '(top level)')!;
  assert.equal(top.entry?.kind, 'main', '__main__ guard');
  assert.deepEqual(fn(graph, 'run').effects, ['sink:process']);
});

test('explore: CommonJS / Express-style code (member-assigned methods, module.exports, listen)', async () => {
  const dir = tempDir({
    'lib/application.js': `var app = exports = module.exports = {};

app.init = function init() {
  this.set('x-powered-by', true);
};

app.set = function set(key, value) {
  this.settings[key] = value;
  return this;
};
`,
    'lib/response.js': `var res = Object.create(null);
module.exports = res;

res.send = function send(body) {
  return this.end(body);
};
`,
    'lib/utils.js': `function etag(body) {
  return String(body.length);
}
function helper() {}
module.exports = { etag };
`,
    'lib/view.js': `function View(name) {
  this.name = name;
}
View.prototype.render = function render(options) {
  return this.lookup(options);
};
View.prototype.lookup = function lookup(options) {
  return options;
};
module.exports = View;
`,
    'examples/hello/index.js': `var express = require('../../lib/application');
var res = require('../../lib/response');

express.init();
res.send('hi');
if (!module.parent) express.listen(3000);
`,
  });
  const { graph } = await explore(dir, { store: new Store(':memory:') });
  const set = fn(graph, 'app.set');
  assert.equal(set.kind, 'method');
  assert.equal(set.exported, true, 'members of module.exports');
  assert.ok(graph.edges.some((e) => e.source.endsWith('#app.init') && e.target === set.id), 'this.set() inside app.init');
  assert.ok(graph.edges.some((e) => e.source.endsWith('#View.render') && e.target.endsWith('#View.lookup')), 'prototype methods');
  assert.equal(fn(graph, 'etag').exported, true, 'named in module.exports = { … }');
  assert.equal(fn(graph, 'helper').exported, false);
  const example = graph.nodes.find((n) => n.file === 'examples/hello/index.js')!;
  assert.equal(example.entry?.kind, 'main', 'module.parent guard / listen');
  assert.ok(graph.edges.some((e) => e.source === example.id && e.target.endsWith('#res.send')), 'res.send() through the receiver name');
});

test('guide: offline from the README, written once by the model, then served from the store', async () => {
  const { buildGuide, readmeIntro } = await import('../src/guide.ts');
  assert.equal(
    readmeIntro('# Shop\n\n[![build](https://x/badge.svg)](https://x)\n\n```sh\nnpm i\n```\n\nShop is a tiny **order service**: it prices carts and saves orders to [Postgres](https://pg).\n'),
    'Shop is a tiny order service: it prices carts and saves orders to Postgres.',
  );
  const dir = tempDir({ ...SHOP, 'README.md': '# Shop\n\nShop is a tiny order service that prices carts and saves orders.\n' });
  const store = new Store(':memory:');
  const { graph } = await explore(dir, { store });
  await describeGraph(graph, heuristicDescriber, heuristicDescriber, { store, concurrency: 1, log: () => {} });

  const offline = await buildGuide(graph, heuristicDescriber, { store, log: () => {} });
  assert.equal(offline.source, 'readme');
  assert.match(offline.summary, /tiny order service/);
  assert.ok(offline.startHere.length > 0 && offline.startHere.every((s) => graph.nodes.some((n) => n.id === s.id)));

  let calls = 0;
  const writer: Describer = {
    ...heuristicDescriber,
    name: 'writer',
    async describeGuide(input) {
      calls++;
      const place = input.candidates.find((c) => c.node.name === 'placeOrder')!;
      return { summary: 'An order service.', architecture: ['orders prices and saves'], startHere: [{ key: place.key, reason: 'Where orders begin.' }, { key: 'c999', reason: 'unknown ids are dropped' }] };
    },
  };
  const written = await buildGuide(graph, writer, { store, log: () => {} });
  assert.equal(written.source, 'llm');
  assert.deepEqual(written.startHere, [{ id: fn(graph, 'placeOrder').id, reason: 'Where orders begin.' }]);
  await buildGuide(graph, writer, { store, log: () => {} });
  assert.equal(calls, 1, 'second build comes from the store');
});
