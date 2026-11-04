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
