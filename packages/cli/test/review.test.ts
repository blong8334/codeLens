// `codelens review`: the report and its Markdown, on a small repo with a breaking change.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { code, enrich, heuristicProvider } from '../src/enrich.ts';
import { reviewBase } from '../src/git.ts';
import { inspect } from '../src/graph.ts';
import { COMMENT_MARKER, reviewMarkdown, reviewReport } from '../src/review.ts';
import { parsePrRef } from '../src/github.ts';

const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'codelens-review-'));
  dirs.push(dir);
  const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
  const write = (files: Record<string, string>) => {
    for (const [p, t] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, p)), { recursive: true });
      writeFileSync(join(dir, p), t);
    }
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@codelens.dev');
  git('config', 'user.name', 'T');
  write({
    'src/pay.ts': "import { Pool } from 'pg';\nconst pool = new Pool();\nexport function charge(amount: number) {\n  return pool.query('insert', [amount]);\n}\n",
    'src/routes/checkout.ts': "import { charge } from '../pay';\nexport function handleCheckout(req: { amount: number }) {\n  return charge(req.amount);\n}\n",
  });
  git('add', '-A');
  git('commit', '-qm', 'base');
  git('checkout', '-q', '-b', 'feature');
  write({ 'src/pay.ts': "import { Pool } from 'pg';\nconst pool = new Pool();\nexport function charge(amount: number, currency: string) {\n  if (amount < 0) throw new Error(`bad ${amount}`);\n  return pool.query('insert', [amount, currency]);\n}\n" });
  git('add', '-A');
  git('commit', '-qm', 'feature');
  return dir;
}

test('review: report and Markdown for a breaking change', async () => {
  const dir = repo();
  const { base, label } = await reviewBase(dir, undefined, 'HEAD');
  assert.match(label, /^main \(fork point [0-9a-f]{7}\)$/, 'finds main and uses the fork point');
  const graph = await enrich(await inspect(dir, { base, head: 'HEAD', maxDepth: 4, full: false }), heuristicProvider, { purposes: false });
  const report = reviewReport(graph);
  const charge = report.changes.find((c) => c.name === 'charge')!;
  assert.equal(charge.breaking, true);
  assert.equal(charge.contract?.after, '(amount: number, currency: string)');
  assert.deepEqual(charge.reachedFrom, ['handleCheckout']);
  assert.deepEqual(charge.effects, ['Database']);
  assert.deepEqual(report.entryPoints, [{ name: 'handleCheckout', kind: 'route', file: 'src/routes/checkout.ts', reaches: ['charge'] }]);

  const md = reviewMarkdown(report);
  assert.ok(md.startsWith(COMMENT_MARKER), 'marker for updating the comment in place');
  assert.match(md, /### Review in this order/);
  assert.match(md, /\| 1 \| `charge`/);
  assert.match(md, /- \(amount: number\)\n {2}\+ \(amount: number, currency: string\)/);
  assert.match(md, /route `handleCheckout` → `charge`/);
  assert.match(md, /\*\*Database\*\*, via `charge`/);
});

test('review: inline code survives backticks', () => {
  assert.equal(code('a'), '`a`');
  assert.equal(code('throw new Error(`bad ${x}`)'), '`` throw new Error(`bad ${x}`) ``');
});

test('pr: accepts numbers, owner/repo#n and URLs', () => {
  assert.deepEqual(parsePrRef('123'), { number: 123 });
  assert.deepEqual(parsePrRef('#7'), { number: 7 });
  assert.deepEqual(parsePrRef('expressjs/express#7574'), { owner: 'expressjs', repo: 'express', number: 7574 });
  assert.deepEqual(parsePrRef('https://github.com/expressjs/express/pull/7574/files'), { owner: 'expressjs', repo: 'express', number: 7574 });
  assert.deepEqual(parsePrRef('https://github.acme.corp/team/app/pull/9'), { owner: 'team', repo: 'app', number: 9 });
  assert.throws(() => parsePrRef('main'), /not a pull request/);
});

test('review: model analyses are stored, so a new push re-analyzes only what moved', async () => {
  const { openStore } = await import('../src/store/index.ts');
  const dir = repo();
  const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
  const store = await openStore(':memory:');
  const calls = { enrich: 0, summary: 0 };
  const counting = {
    ...heuristicProvider,
    name: 'counting-model',
    async enrichNode(ctx: Parameters<typeof heuristicProvider.enrichNode>[0]) {
      calls.enrich++;
      return { ...ctx.heuristic, source: 'llm' as const };
    },
    async summarize(...args: Parameters<typeof heuristicProvider.summarize>) {
      calls.summary++;
      return heuristicProvider.summarize(...args);
    },
  };
  const run = async () => {
    const { base } = await reviewBase(dir, 'main', 'HEAD');
    return enrich(await inspect(dir, { base, head: 'HEAD', maxDepth: 4, full: false }), counting, { purposes: false, store });
  };
  const first = await run();
  const analyzed = calls.enrich;
  assert.ok(analyzed > 0);
  await run();
  assert.equal(calls.enrich, analyzed, 'same push: nothing re-analyzed');
  assert.equal(calls.summary, 1, 'same push: summary reused');

  // A new push adds an unrelated helper: only it is new to analyze. (Had the push changed a
  // caller of `charge`, `charge` would rightly be re-analyzed: its situation would have changed.)
  writeFileSync(join(dir, 'src/util.ts'), 'export function slug(s: string) {\n  return s.toLowerCase();\n}\n');
  git('add', '-A');
  git('commit', '-qm', 'push 2');
  const second = await run();
  assert.equal(calls.enrich, analyzed + 1, 'only the newly changed function is analyzed');
  assert.equal(second.nodes.find((n) => n.name === 'charge')?.enrichment?.source, 'llm');
  assert.ok(first.enrichment && second.enrichment);
});

test('brief: assembled offline, written once by a model, then reused', async () => {
  const { buildBrief } = await import('../src/brief.ts');
  const { openStore } = await import('../src/store/index.ts');
  const dir = repo();
  const { base } = await reviewBase(dir, 'main', 'HEAD');
  const graph = await enrich(await inspect(dir, { base, head: 'HEAD', maxDepth: 4, full: false }), heuristicProvider, { purposes: false });
  const store = await openStore(':memory:');

  const offline = await buildBrief(graph, heuristicProvider, { store, log: () => {} });
  assert.equal(offline.source, 'heuristic');
  assert.match(offline.risks[0]?.title ?? '', /Breaking change to `charge`/);
  assert.deepEqual(offline.risks[0].fnIds, ['src/pay.ts#charge']);
  assert.equal(offline.readingOrder[0]?.id, 'src/pay.ts#charge');
  assert.match(offline.testing, /No test files changed/);

  let calls = 0;
  const model = {
    ...heuristicProvider,
    name: 'brief-model',
    async describeBrief(input: { changes: { key: string; node: { name: string } }[] }) {
      calls++;
      const c = input.changes.find((x) => x.node.name === 'charge')!;
      return { overview: 'Adds a currency to charges.', approach: ['`charge` takes a currency'], risks: [{ title: 'Callers break', detail: 'Missing currency.', ids: [c.key, 'c99'] }], watch: ['Check callers'], readingOrder: [{ id: c.key, reason: 'The change itself.' }], testing: 'Untested.' };
    },
  };
  const written = await buildBrief(graph, model, { store, log: () => {} });
  assert.equal(written.source, 'llm');
  assert.deepEqual(written.risks[0].fnIds, ['src/pay.ts#charge'], 'unknown ids are dropped');
  await buildBrief(graph, model, { store, log: () => {} });
  assert.equal(calls, 1, 'the second build is served from the store');
});

test('marks: a file stays reviewed across unrelated pushes, and reopens when it changes', async () => {
  const { openStore } = await import('../src/store/index.ts');
  const dir = repo();
  const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
  const store = await openStore(':memory:');
  const review = async () => {
    const { base } = await reviewBase(dir, 'main', 'HEAD');
    return (await inspect(dir, { base, head: 'HEAD', maxDepth: 4, full: false })).review!;
  };
  const first = await review();
  assert.match(first.key, /^local:.*:feature$/, 'local reviews are keyed by repo and branch');
  const pay = first.files.find((f) => f.path === 'src/pay.ts')!;
  assert.equal(pay.functions, 1);
  assert.ok(pay.additions > 0);
  await store.setMark(first.key, 'me', pay.path, pay.fingerprint);

  // An unrelated push: pay.ts's diff is unchanged, so the mark still matches.
  writeFileSync(join(dir, 'notes.md'), 'hello\n');
  git('add', '-A');
  git('commit', '-qm', 'notes');
  const second = await review();
  const marks = await store.getMarks(second.key, 'me');
  assert.equal(marks.get('src/pay.ts')?.fingerprint, second.files.find((f) => f.path === 'src/pay.ts')!.fingerprint, 'still reviewed');
  assert.ok(second.files.some((f) => f.path === 'notes.md' && f.functions === 0), 'non-code files are listed too');

  // pay.ts changes again: its fingerprint moves, so the old mark no longer matches (stale).
  writeFileSync(join(dir, 'src/pay.ts'), "import { Pool } from 'pg';\nconst pool = new Pool();\nexport function charge(amount: number, currency = 'usd') {\n  return pool.query('insert', [amount, currency]);\n}\n");
  git('commit', '-qam', 'rework');
  const third = await review();
  assert.notEqual(marks.get('src/pay.ts')?.fingerprint, third.files.find((f) => f.path === 'src/pay.ts')!.fingerprint, 'changed since reviewed');
  await store.setMark(third.key, 'me', 'src/pay.ts', null);
  assert.equal((await store.getMarks(third.key, 'me')).size, 0);
});
