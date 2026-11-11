// `codelens diff` across packages: one diff per package, matched to its package and combined into
// one review, with calls between packages linked. The packages are only read.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { inspect } from '../src/graph.ts';
import { combineWorkspace, matchPackage, workspacePackages } from '../src/workspace.ts';

const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), 'codelens-cache-'));
dirs.push(process.env.XDG_CACHE_HOME);

/** A package repo with `files` committed; returns the diff that turns them into `next`, and restores them. */
function pkg(ws: string, name: string, files: Record<string, string>, next: Record<string, string>): string {
  const dir = join(ws, name);
  mkdirSync(dir, { recursive: true });
  const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' }).toString();
  const write = (f: Record<string, string>) => {
    for (const [p, t] of Object.entries(f)) {
      mkdirSync(dirname(join(dir, p)), { recursive: true });
      writeFileSync(join(dir, p), t);
    }
  };
  git('init', '-q', '-b', 'mainline');
  git('config', 'user.email', 't@codelens.dev');
  git('config', 'user.name', 'T');
  write(files);
  git('add', '-A');
  git('commit', '-qm', 'base');
  write(next);
  git('add', '-N', '.');
  const diff = git('diff');
  git('checkout', '--', '.');
  git('clean', '-qfd');
  return diff;
}

function workspace() {
  const ws = mkdtempSync(join(tmpdir(), 'codelens-ws-'));
  dirs.push(ws);
  const payDiff = pkg(
    ws,
    'PaymentsLib',
    { 'src/main/java/pay/Payments.java': 'package pay;\npublic class Payments {\n  public static int charge(int amount) {\n    return amount;\n  }\n}\n' },
    { 'src/main/java/pay/Payments.java': 'package pay;\npublic class Payments {\n  public static int charge(int amount, String currency) {\n    if (amount < 0) throw new IllegalArgumentException("negative");\n    return amount;\n  }\n}\n' },
  );
  const shopDiff = pkg(
    ws,
    'ShopService',
    { 'src/main/java/shop/Checkout.java': 'package shop;\nimport pay.Payments;\npublic class Checkout {\n  public int checkout() {\n    return Payments.charge(5);\n  }\n}\n' },
    { 'src/main/java/shop/Checkout.java': 'package shop;\nimport pay.Payments;\npublic class Checkout {\n  public int checkout() {\n    return Payments.charge(5, "USD");\n  }\n}\n' },
  );
  pkg(ws, 'Unrelated', { 'README.md': 'hi\n' }, {});
  return { ws, payDiff, shopDiff };
}

test('each diff is matched to the package it applies to', () => {
  const { ws, payDiff, shopDiff } = workspace();
  const pkgs = workspacePackages(ws);
  assert.deepEqual(pkgs.map((p) => p.split('/').pop()).sort(), ['PaymentsLib', 'ShopService', 'Unrelated']);
  assert.equal(matchPackage({ label: 'a.diff', text: payDiff }, pkgs, 'HEAD').split('/').pop(), 'PaymentsLib');
  assert.equal(matchPackage({ label: 'b.diff', text: shopDiff }, pkgs, 'HEAD').split('/').pop(), 'ShopService');
  assert.equal(matchPackage({ label: 'b.diff', text: shopDiff, dir: 'ShopService' }, pkgs, 'HEAD').split('/').pop(), 'ShopService');
  const stray = 'diff --git a/nope/X.java b/nope/X.java\n--- a/nope/X.java\n+++ b/nope/X.java\n@@ -1 +1 @@\n-a\n+b\n';
  assert.throws(() => matchPackage({ label: 'c.diff', text: stray }, pkgs, 'HEAD'), /does not match any package/);
});

test('diffs for several packages become one review, with the call between packages linked', async () => {
  const { ws, payDiff, shopDiff } = workspace();
  const before = readFileSync(join(ws, 'PaymentsLib/src/main/java/pay/Payments.java'), 'utf8');
  const change = await combineWorkspace(ws, [{ label: 'shop.diff', text: shopDiff }, { label: 'pay.diff', text: payDiff }], { base: 'HEAD', log: () => {} });
  assert.deepEqual([...change.packages.keys()].sort(), ['PaymentsLib', 'ShopService']);
  // The packages themselves are untouched.
  assert.equal(readFileSync(join(ws, 'PaymentsLib/src/main/java/pay/Payments.java'), 'utf8'), before);
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: join(ws, 'PaymentsLib') }).toString(), '');

  const g = await inspect(change.root, { base: change.base, head: change.head, maxDepth: 3, full: false });
  const changed = g.nodes.filter((n) => n.status !== 'unchanged').map((n) => n.id).sort();
  assert.deepEqual(changed, ['PaymentsLib/src/main/java/pay/Payments.java#Payments.charge', 'ShopService/src/main/java/shop/Checkout.java#Checkout.checkout']);
  assert.ok(g.edges.some((e) => e.source.startsWith('ShopService/') && e.target.startsWith('PaymentsLib/')), 'checkout → charge crosses packages');
  assert.deepEqual(g.review!.files.map((f) => f.path).sort(), ['PaymentsLib/src/main/java/pay/Payments.java', 'ShopService/src/main/java/shop/Checkout.java']);

  // Running again reuses the cache repository and gives the same result.
  const again = await combineWorkspace(ws, [{ label: 'pay.diff', text: payDiff }, { label: 'shop.diff', text: shopDiff }], { base: 'HEAD', log: () => {} });
  assert.equal(again.root, change.root);
  assert.equal(execFileSync('git', ['rev-parse', `${again.head}^{tree}`], { cwd: again.root }).toString(), execFileSync('git', ['rev-parse', `${change.head}^{tree}`], { cwd: change.root }).toString());
});
