// Type-aware resolution (TypeScript checker) — the cases name matching gets wrong.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { explore } from '../src/explore.ts';
import { inspect } from '../src/graph.ts';

const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
function dir(files: Record<string, string>): string {
  const d = mkdtempSync(join(tmpdir(), 'codelens-typed-'));
  dirs.push(d);
  for (const [p, t] of Object.entries(files)) {
    mkdirSync(dirname(join(d, p)), { recursive: true });
    writeFileSync(join(d, p), t);
  }
  return d;
}

const FILES = {
  'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } } }),
  'src/gateways.ts': `export interface Gateway {
  charge(amount: number): string;
}

export class Stripe implements Gateway {
  charge(amount: number) {
    return 'stripe';
  }
}

export class Paypal implements Gateway {
  constructor(private key = 'k') {}
  charge(amount: number) {
    return 'paypal';
  }
}
`,
  'src/cache.ts': `export class Cache {
  get(key: string) {
    return key;
  }
}
`,
  'src/money.ts': `export const format = (n: number) => n.toFixed(2);
`,
  'src/checkout.ts': `import { Paypal, type Gateway } from './gateways';
import { format } from '@/money';

export function checkout(amount: number, prices: Map<string, number>) {
  const gateway = new Paypal();
  const id = gateway.charge(amount);
  const p = prices.get('x');
  return format(amount) + id + p;
}

export function anyGateway(g: Gateway, amount: number) {
  return g.charge(amount);
}
`,
};

const edgesFrom = (g: { edges: { source: string; target: string; typed?: boolean }[] }, fn: string) => g.edges.filter((e) => e.source.endsWith(`#${fn}`));

test('typed: exact targets, library calls dropped, aliases resolved', async () => {
  const { graph } = await explore(dir(FILES));
  const out = edgesFrom(graph, 'checkout');
  const targets = out.map((e) => e.target).sort();
  assert.deepEqual(targets, ['src/gateways.ts#Paypal.charge', 'src/gateways.ts#Paypal.constructor', 'src/money.ts#format'], `got ${targets.join(', ')}`);
  assert.ok(out.every((e) => e.typed), 'resolved by the checker');
  assert.ok(!out.some((e) => e.target.endsWith('#Stripe.charge')), 'not the other class with the same method name');
  assert.ok(!out.some((e) => e.target.endsWith('#Cache.get')), '`prices.get()` is Map.get, not our Cache.get');
});

test('typed: interfaces fall back to name matching', async () => {
  const { graph } = await explore(dir(FILES));
  // `g: Gateway` could be either class: the checker cannot say, so it is left to names
  // (which, with two `charge` methods and no hint, links nothing rather than guess).
  assert.ok(edgesFrom(graph, 'anyGateway').every((e) => !e.typed));
});

test('typed: --no-types keeps name matching only', async () => {
  const { graph } = await explore(dir(FILES), { types: false });
  assert.ok(graph.edges.every((e) => !e.typed));
  assert.ok(edgesFrom(graph, 'checkout').some((e) => e.target.endsWith('#Cache.get')) === false);
});

test('typed: a review type-checks the reviewed commit, not the working tree', async () => {
  const d = dir(FILES);
  const git = (...a: string[]) => execFileSync('git', a, { cwd: d, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@codelens.dev');
  git('config', 'user.name', 'T');
  git('add', '-A');
  git('commit', '-qm', 'base');
  writeFileSync(join(d, 'src/checkout.ts'), FILES['src/checkout.ts'].replace('new Paypal()', 'new Paypal("live")'));
  git('commit', '-qam', 'change');
  // Uncommitted edit that would change resolution if the working tree were checked.
  writeFileSync(join(d, 'src/checkout.ts'), FILES['src/checkout.ts'].replace(/new Paypal\(\)/, 'new Stripe()').replace('import { Paypal', 'import { Stripe, Paypal'));
  const graph = await inspect(d, { base: 'HEAD~1', head: 'HEAD', maxDepth: 4, full: true });
  const targets = edgesFrom(graph, 'checkout').map((e) => e.target);
  assert.ok(targets.includes('src/gateways.ts#Paypal.charge'), targets.join(', '));
  assert.ok(!targets.includes('src/gateways.ts#Stripe.charge'));
});

test('typed: a checker-confirmed edge is upgraded even when name matching created it first', async () => {
  const { graph } = await explore(
    dir({
      'src/svc.ts': `export class Svc {
  helper() {
    return 1;
  }
}
`,
      // In another file, name matching only reaches Svc.helper with low confidence.
      'src/use.ts': `import { Svc } from './svc';

export function use(loose: any, svc: Svc) {
  loose.helper();
  return svc.helper();
}
`,
    }),
  );
  const edge = graph.edges.find((e) => e.source.endsWith('#use') && e.target.endsWith('#Svc.helper'))!;
  assert.ok(edge, 'edge exists');
  assert.equal(edge.count, 2);
  assert.equal(edge.typed, true);
  assert.equal(edge.confidence, 'high', 'the typed call upgrades the earlier name-matched one');
});

test('typed: tsconfig extends, per-package configs, and paths without baseUrl', async () => {
  const { graph } = await explore(
    dir({
      'tsconfig.base.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@shared/*': ['shared/*'] } } }),
      'shared/money.ts': 'export function format(n: number) {\n  return n.toFixed(2);\n}\n',
      'packages/app/tsconfig.json': JSON.stringify({ extends: '../../tsconfig.base.json' }),
      'packages/app/src/checkout.ts': "import { format } from '@shared/money';\n\nexport function total(n: number) {\n  return format(n);\n}\n",
      'packages/web/tsconfig.json': JSON.stringify({ compilerOptions: { paths: { '~/*': ['./src/*'] } } }),
      'packages/web/src/util.ts': 'export function slug(s: string) {\n  return s.toLowerCase();\n}\n',
      'packages/web/src/page.ts': "import { slug } from '~/util';\n\nexport function title(s: string) {\n  return slug(s);\n}\n",
    }),
  );
  const typedEdge = (from: string, to: string) => graph.edges.find((e) => e.source.endsWith(`#${from}`) && e.target.endsWith(`#${to}`));
  assert.equal(typedEdge('total', 'format')?.typed, true, 'alias inherited through extends');
  assert.equal(typedEdge('title', 'slug')?.typed, true, 'paths resolve without a baseUrl, per package');
});
