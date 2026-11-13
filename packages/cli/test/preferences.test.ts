// Reviewer-shaped reviews: moves and renames, compiler-checked signature changes, and preferences.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { enrich, heuristicProvider } from '../src/enrich.ts';
import { inspect } from '../src/graph.ts';
import { applyPreferences, parsePreferences } from '../src/preferences.ts';

const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** A repo with `before` committed on main and `after` committed on top; returns its path. */
function repo(before: Record<string, string>, after: Record<string, string | null>): string {
  const dir = mkdtempSync(join(tmpdir(), 'codelens-prefs-'));
  dirs.push(dir);
  const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
  const write = (files: Record<string, string | null>) => {
    for (const [p, t] of Object.entries(files)) {
      if (t === null) rmSync(join(dir, p));
      else {
        mkdirSync(dirname(join(dir, p)), { recursive: true });
        writeFileSync(join(dir, p), t);
      }
    }
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@codelens.dev');
  git('config', 'user.name', 'T');
  write(before);
  git('add', '-A');
  git('commit', '-qm', 'base');
  write(after);
  git('add', '-A');
  git('commit', '-qm', 'change');
  return dir;
}

const review = async (dir: string) => enrich(await inspect(dir, { base: 'HEAD~1', head: 'HEAD', maxDepth: 3, full: false }), heuristicProvider, { purposes: false });

test('a function moved to another file, and one renamed, are one exact move each, not a delete and an add', async () => {
  const total = 'export function total(items: number[]): number {\n  let sum = 0;\n  for (const i of items) sum += i;\n  return sum;\n}\n';
  const dir = repo(
    { 'src/a.ts': `${total}export function keep() {\n  return 1;\n}\n`, 'src/b.ts': 'export function helper(x: number) {\n  const y = x * 2;\n  return y + 1;\n}\n' },
    { 'src/a.ts': 'export function keep() {\n  return 1;\n}\n', 'src/moved.ts': total, 'src/b.ts': 'export function assist(x: number) {\n  const y = x * 2;\n  return y + 1;\n}\n' },
  );
  const g = await review(dir);
  const changed = g.nodes.filter((n) => n.status !== 'unchanged');
  assert.deepEqual(changed.map((n) => [n.id, n.status, n.moved]).sort(), [
    ['src/b.ts#assist', 'modified', { from: 'src/b.ts#helper', renamed: true, exact: true }],
    ['src/moved.ts#total', 'modified', { from: 'src/a.ts#total', renamed: false, exact: true }],
  ]);
  const t = changed.find((n) => n.name === 'total')!;
  assert.match(t.enrichment!.summary, /Moves `total` from src\/a.ts to src\/moved.ts/);
  assert.ok(t.enrichment!.blastRadius < 0.1);
});

test('a breaking signature change in a typed language is compiler-checked when every caller is updated', async () => {
  const dir = repo(
    {
      'src/pay.ts': 'export function charge(amount: number) {\n  return amount;\n}\n',
      'src/checkout.ts': "import { charge } from './pay';\nexport function checkout() {\n  return charge(1);\n}\n",
      'src/other.js': "const { charge } = require('./pay');\nfunction other() {\n  return charge(2);\n}\n",
    },
    {
      'src/pay.ts': 'export function charge(amount: number, currency: string) {\n  return amount;\n}\n',
      'src/checkout.ts': "import { charge } from './pay';\nexport function checkout() {\n  return charge(1, 'USD');\n}\n",
      'src/other.js': "const { charge } = require('./pay');\nfunction other() {\n  return charge(2, 'EUR');\n}\n",
    },
  );
  const charge = (await review(dir)).nodes.find((n) => n.name === 'charge')!;
  assert.equal(charge.enrichment!.contract.compilerChecked, true);
  assert.equal(charge.enrichment!.contract.breaking, false);
  assert.ok(charge.enrichment!.reasons.some((r) => /compiler-checked/.test(r)));

  // With a caller left behind, it is breaking again.
  const stale = repo(
    { 'src/pay.ts': 'export function charge(amount: number) {\n  return amount;\n}\n', 'src/checkout.ts': "import { charge } from './pay';\nexport function checkout() {\n  return charge(1);\n}\n" },
    { 'src/pay.ts': 'export function charge(amount: number, currency: string) {\n  return amount;\n}\n' },
  );
  const c2 = (await review(stale)).nodes.find((n) => n.name === 'charge')!;
  assert.equal(c2.enrichment!.contract.breaking, true);
  assert.ok(!c2.enrichment!.contract.compilerChecked);
});

test('preferences: free text, with a skip list that names tests and moves', () => {
  const p = parsePreferences('Care about:\n- performance\n- DRY\n\nSkip:\n- tests (coverage is checked automatically)\n- renames and lift-and-shifts\n', 'prefs.md')!;
  assert.equal(p.skipTests, true);
  assert.equal(p.skipMoves, true);
  assert.match(p.text, /performance/);
  // Caring about tests is not skipping them.
  const q = parsePreferences('I care about tests and naming.\n', 'p')!;
  assert.equal(q.skipTests, false);
  assert.equal(q.skipMoves, false);
  assert.equal(parsePreferences("I don't care about tests", 'p')!.skipTests, true);
  assert.equal(parsePreferences('# Ignore\n* moved code\n', 'p')!.skipMoves, true);
  assert.equal(parsePreferences('  \n', 'p'), undefined);
});

test('applyPreferences lists skipped tests and exact moves, and files made only of them', async () => {
  const dir = repo(
    { 'src/a.ts': 'export function total(n: number) {\n  return n + 1;\n}\nexport function keep() {\n  return 1;\n}\n', 'test/a.test.ts': "test('x', () => {\n  return 1;\n});\n" },
    {
      'src/a.ts': 'export function keep() {\n  return 2;\n}\n',
      'src/b.ts': 'export function total(n: number) {\n  return n + 1;\n}\n',
      'test/a.test.ts': "test('x', () => {\n  return 2;\n});\n",
    },
  );
  const g = await review(dir);
  applyPreferences(g, parsePreferences('Skip: tests, renames and moves', 'p'));
  const skipped = new Set(g.review!.skipped);
  assert.ok(skipped.has('src/b.ts#total'));
  assert.ok(skipped.has('src/b.ts'), 'a file holding only a move is skipped');
  assert.ok(skipped.has('test/a.test.ts'));
  assert.ok(!skipped.has('src/a.ts#keep'));
  assert.ok(!skipped.has('src/a.ts'));
  assert.equal(g.review!.preferences!.source, 'p');

  const plain = await review(dir);
  applyPreferences(plain, undefined);
  assert.equal(plain.review!.skipped, undefined);
});

test('tests skipped by preferences are never sent to the model; their diffs stay in the review', async () => {
  const dir = repo(
    { 'src/a.ts': 'export function price(n: number) {\n  return n;\n}\n', 'test/a.test.ts': 'export function fixture() {\n  return 1;\n}\n' },
    { 'src/a.ts': 'export function price(n: number) {\n  return n * 2;\n}\n', 'test/a.test.ts': 'export function fixture() {\n  return 2;\n}\n' },
  );
  const seen: string[] = [];
  const model: typeof heuristicProvider = {
    ...heuristicProvider,
    name: 'recording',
    async enrichNode(ctx) {
      seen.push(`change:${ctx.node.file}`);
      return { ...ctx.heuristic, source: 'llm' };
    },
    async summarize(graph, ranked) {
      seen.push(...ranked.map((n) => `summary:${n.file}`));
      return 'ok';
    },
    async describeFunctions(items) {
      seen.push(...items.map((i) => `purpose:${i.node.file}`));
      return heuristicProvider.describeFunctions(items);
    },
  };
  const g = await inspect(dir, { base: 'HEAD~1', head: 'HEAD', maxDepth: 3, full: false });
  applyPreferences(g, parsePreferences('Exclude:\n- tests\n', 'p'));
  await enrich(g, model);
  assert.ok(seen.includes('change:src/a.ts') && seen.includes('purpose:src/a.ts'));
  assert.deepEqual(seen.filter((s) => s.includes('test/')), []);
  const fixture = g.nodes.find((n) => n.file === 'test/a.test.ts')!;
  assert.equal(fixture.enrichment!.source, 'heuristic');
  assert.ok(fixture.diff?.includes('+  return 2;'));
  assert.ok(fixture.purpose?.what);

  // Without the preference, tests go to the model like anything else.
  seen.length = 0;
  await enrich(await inspect(dir, { base: 'HEAD~1', head: 'HEAD', maxDepth: 3, full: false }), model);
  assert.ok(seen.includes('change:test/a.test.ts'));
});
