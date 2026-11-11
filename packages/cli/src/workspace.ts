// One review across several repositories: a change that spans packages (one diff per package, as
// code.amazon and similar tools export them). Each diff is matched to the package it applies to,
// and the packages are combined into one snapshot, each in its own folder, base and patched, in a
// CodeLens-owned repository in the cache. The packages themselves are only read.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { commitPatches, patchPaths, scratchGit, type PatchInput } from './patch.ts';
import { cacheDir } from './store/index.ts';

export interface PackagePatch {
  /** The patch file (for messages). */
  label: string;
  text: string;
  /** Package directory, when given explicitly (`Package=file.diff`). */
  dir?: string;
}

export interface WorkspaceChange {
  /** The combined repository (in the cache). */
  root: string;
  base: string;
  head: string;
  /** Package folder name → the diffs applied to it. */
  packages: Map<string, string[]>;
}

const git = (cwd: string, args: string[], input?: string) => {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', input, maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error(`git ${args.slice(0, 2).join(' ')} failed in ${cwd}: ${r.stderr.trim().slice(0, 300)}`);
  return r.stdout;
};
const isRepo = (dir: string) => existsSync(join(dir, '.git'));

/** Git repositories at `dir` and directly under it: the packages of a workspace. */
export function workspacePackages(dir: string): string[] {
  const root = resolve(dir);
  const out = isRepo(root) ? [root] : [];
  for (const name of readdirSync(root)) {
    const p = join(root, name);
    if (!name.startsWith('.') && statSync(p, { throwIfNoEntry: false })?.isDirectory() && isRepo(p)) out.push(p);
  }
  return out;
}

/** The package a patch applies to: the one where every file it modifies exists at `base`. */
export function matchPackage(patch: PackagePatch, candidates: string[], base: string, strip?: number): string {
  if (patch.dir) {
    const dir = candidates.find((c) => basename(c) === patch.dir || c === resolve(patch.dir!));
    if (dir) return dir;
    if (isRepo(resolve(patch.dir))) return resolve(patch.dir);
    throw new Error(`${patch.label}: ${patch.dir} is not a git repository in this workspace`);
  }
  const { reads, writes } = patchPaths(patch.text, strip ?? 1);
  const paths = reads.length ? reads : writes;
  const fits = candidates.filter((c) => {
    if (!reads.length) return true;
    const out = spawnSync('git', ['-C', c, 'cat-file', '--batch-check'], { encoding: 'utf8', input: reads.map((p) => `${base}:${p}`).join('\n') + '\n' }).stdout;
    return !/ missing$/m.test(out) && out.trim().length > 0;
  });
  // A diff that only adds files fits anywhere; prefer the package that already has their folders.
  const ranked = reads.length ? fits : fits.filter((c) => paths.some((p) => existsSync(join(c, p.split('/').slice(0, -1).join('/') || '.')) && p.includes('/')));
  if (ranked.length === 1) return ranked[0];
  const names = (ranked.length ? ranked : candidates).map((c) => basename(c)).join(', ');
  throw new Error(
    ranked.length
      ? `${patch.label} could belong to ${names}; say which: Package=${patch.label}`
      : `${patch.label} does not match any package here (${names || 'no git repositories found'}); run from the workspace's src folder, check out the right revision, or say which: Package=${patch.label}`,
  );
}

/**
 * Combine the packages the patches touch into one repository: a base commit with each package's
 * `base` under its folder, and a head commit with the patches applied.
 */
export async function combineWorkspace(dir: string, patches: PackagePatch[], opts: { base: string; strip?: number; log: (m: string) => void }): Promise<WorkspaceChange> {
  const candidates = workspacePackages(dir);
  const assigned = patches.map((p) => ({ patch: p, root: matchPackage(p, candidates, opts.base, opts.strip) }));
  const roots = [...new Set(assigned.map((a) => a.root))].sort();
  const folder = (root: string) => (relative(resolve(dir), root) || basename(root)).replace(/\\/g, '/');
  const packages = new Map<string, string[]>();
  for (const a of assigned) packages.set(folder(a.root), [...(packages.get(folder(a.root)) ?? []), a.patch.label]);
  for (const [name, files] of packages) opts.log(`  ${name} ← ${files.join(', ')}`);

  // A cache repository per set of packages, so their objects are fetched once and reused.
  const repo = join(cacheDir(), 'workspaces', createHash('sha1').update(roots.join('\0')).digest('hex').slice(0, 12));
  if (!existsSync(join(repo, '.git'))) {
    mkdirSync(repo, { recursive: true });
    git(repo, ['init', '-q']);
  }
  const commits = roots.map((root) => {
    git(repo, ['fetch', '--quiet', '--no-tags', '--depth=1', root, opts.base]);
    return { root, commit: git(repo, ['rev-parse', 'FETCH_HEAD']).trim() };
  });
  const base = await scratchGit(repo, async (g) => {
    await g(['read-tree', '--empty']);
    for (const { root, commit } of commits) await g(['read-tree', `--prefix=${folder(root)}/`, commit]);
    const tree = (await g(['write-tree'])).trim();
    return (await g(['commit-tree', tree, '-m', `CodeLens: ${[...packages.keys()].join(', ')} at ${opts.base}`])).trim();
  });
  const inputs: PatchInput[] = assigned.map((a) => ({ text: a.patch.text, label: a.patch.label, strip: opts.strip, directory: folder(a.root) }));
  const head = await commitPatches(repo, base, inputs);
  return { root: repo, base, head, packages };
}
