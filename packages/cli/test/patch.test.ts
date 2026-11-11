// `codelens diff`: a patch from any review tool, applied as a commit object without touching the
// working tree, then reviewed like a branch.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { inspect } from '../src/graph.ts';
import { commitPatch, patchInfo } from '../src/patch.ts';

const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const BEFORE = 'export function charge(amount: number) {\n  return amount;\n}\nexport function checkout() {\n  return charge(1);\n}\n';
const AFTER = 'export function charge(amount: number) {\n  if (amount < 0) throw new Error("bad");\n  return amount;\n}\nexport function checkout() {\n  return charge(1);\n}\n';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'codelens-patch-'));
  dirs.push(dir);
  const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' }).toString();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@codelens.dev');
  git('config', 'user.name', 'T');
  writeFileSync(join(dir, 'pay.ts'), BEFORE);
  git('add', '-A');
  git('commit', '-qm', 'base');
  // Make the patch the way another tool would hand it over, then put the tree back.
  writeFileSync(join(dir, 'pay.ts'), AFTER);
  const patch = git('diff');
  git('checkout', '--', 'pay.ts');
  return { dir, git, patch };
}

test('commitPatch applies a patch as a commit and leaves the working tree and index alone', async () => {
  const { dir, git, patch } = setup();
  const head = await commitPatch(dir, 'HEAD', patch);
  assert.equal(git('show', `${head}:pay.ts`), AFTER);
  assert.equal(readFileSync(join(dir, 'pay.ts'), 'utf8'), BEFORE);
  assert.equal(git('status', '--porcelain'), '');
  assert.equal(git('rev-parse', `${head}^`).trim(), git('rev-parse', 'HEAD').trim());

  const graph = await inspect(dir, { base: 'HEAD', head, maxDepth: 2, full: false });
  assert.deepEqual(
    graph.nodes.filter((n) => n.status !== 'unchanged').map((n) => [n.qualifiedName, n.status]),
    [['charge', 'modified']],
  );
  assert.equal(graph.review?.files[0].path, 'pay.ts');
});

test('commitPatch handles paths without a/ b/ prefixes, and explains a patch that does not apply', async () => {
  const { dir, git, patch } = setup();
  const bare = patch.replace(/^(---|\+\+\+) [ab]\//gm, '$1 ').replace(/^diff --git a\/(\S+) b\//m, 'diff --git $1 ');
  const head = await commitPatch(dir, 'HEAD', bare, { strip: 0 });
  assert.equal(git('show', `${head}:pay.ts`), AFTER);

  const broken = patch.replace('return amount;', 'return amount * 2;');
  await assert.rejects(commitPatch(dir, 'HEAD', broken), /does not apply to HEAD/);
});

test('patchInfo reads the subject and message of a format-patch file', () => {
  const text = 'From abc Mon Sep 17 00:00:00 2001\nFrom: A <a@b.c>\nSubject: [PATCH] Reject negative\n amounts in charge\n\nCharges below zero were stored.\nNow they throw.\n---\n pay.ts | 1 +\n\ndiff --git a/pay.ts b/pay.ts\n';
  assert.deepEqual(patchInfo(text), { title: 'Reject negative amounts in charge', description: 'Charges below zero were stored.\nNow they throw.' });
  assert.deepEqual(patchInfo('diff --git a/x b/x\n'), {});
});
