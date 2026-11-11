// Review a change that lives outside git hosting (a downloaded .diff/.patch from any code review
// tool): apply it on top of a base revision of a local clone, as a commit object only. The working
// tree, the real index and every branch are left alone; the commit is unreferenced and is pruned
// by git's usual garbage collection.
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface PatchInfo {
  /** From a `git format-patch` / mbox header (`Subject:`), when present. */
  title?: string;
  /** The message body under the subject, when present. */
  description?: string;
}

/** Title and message of a `git format-patch` style patch; empty for a bare unified diff. */
export function patchInfo(text: string): PatchInfo {
  const head = text.split(/^(?:---\n|diff --git |Index: |--- )/m)[0];
  const subject = head.match(/^Subject: (.*(?:\n[ \t].*)*)/m)?.[1];
  if (!subject) return {};
  const title = subject.replace(/\n[ \t]+/g, ' ').replace(/^\[[^\]]*\]\s*/, '').trim();
  const body = head.slice(head.indexOf(subject) + subject.length).replace(/^\n+/, '').trim();
  return { title: title || undefined, description: body || undefined };
}

export interface PatchInput {
  text: string;
  /** How to name it in errors: the file name. */
  label: string;
  /** `git apply -p`: leading path components to drop (default 1, as in `a/` `b/`). */
  strip?: number;
  /** Prepend this directory to the patch's paths. */
  directory?: string;
}

/** Apply one patch to `base` in the repository at `root` and return the resulting commit id. */
export async function commitPatch(root: string, base: string, patch: string, opts: { strip?: number; directory?: string } = {}): Promise<string> {
  return commitPatches(root, base, [{ text: patch, label: 'the patch', ...opts }]);
}

/** Git with a private index and a fixed identity, so nothing of the user's is read or changed. */
export async function scratchGit<T>(root: string, fn: (git: (args: string[], input?: string) => Promise<string>) => Promise<T>): Promise<T> {
  const tmp = await mkdtemp(join(tmpdir(), 'codelens-patch-'));
  const env = {
    ...process.env,
    GIT_INDEX_FILE: join(tmp, 'index'),
    GIT_AUTHOR_NAME: 'CodeLens',
    GIT_AUTHOR_EMAIL: 'codelens@localhost',
    GIT_COMMITTER_NAME: 'CodeLens',
    GIT_COMMITTER_EMAIL: 'codelens@localhost',
  };
  try {
    return await fn((args, input) => run('git', ['-C', root, ...args], env, input));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/** Apply patches in order on top of `base` and return the resulting commit id. */
export async function commitPatches(root: string, base: string, patches: PatchInput[]): Promise<string> {
  return scratchGit(root, async (git) => {
    const baseCommit = (await git(['rev-parse', '--verify', `${base}^{commit}`])).trim();
    await git(['read-tree', baseCommit]);
    for (const p of patches) {
      const before = (await git(['write-tree'])).trim();
      const apply = ['apply', '--cached', '--whitespace=nowarn', ...(p.strip !== undefined ? [`-p${p.strip}`] : []), ...(p.directory ? [`--directory=${p.directory}`] : [])];
      try {
        await git([...apply, '-'], p.text);
      } catch (err) {
        // A three-way apply succeeds when the patch names blobs this clone has (git diffs do).
        await git(['read-tree', before]);
        await git([...apply, '--3way', '-'], p.text).catch(() => {
          throw new Error(
            `${p.label} does not apply to ${base} (${baseCommit.slice(0, 7)}): ${(err as Error).message.replace(/^git .*? failed: /, '')}\n` +
              `Check out the revision the change was written against, or pass --base <ref>${p.strip === undefined ? ' (and --strip 0 if its paths have no a/ b/ prefix)' : ''}.`,
          );
        });
      }
    }
    const tree = (await git(['write-tree'])).trim();
    return (await git(['commit-tree', tree, '-p', baseCommit, '-m', 'CodeLens: patch under review'])).trim();
  });
}

/** Paths a patch reads (pre-image, minus new files) and writes, after stripping `strip` components. */
export function patchPaths(text: string, strip = 1): { reads: string[]; writes: string[] } {
  const cut = (p: string) => p.replace(/\t.*$/, '').trim().split('/').slice(strip).join('/');
  const reads = new Set<string>();
  const writes = new Set<string>();
  // File headers only: a `---` line directly followed by `+++` (a removed line can start with `--`).
  const lines = text.split('\n');
  for (let i = 0; i + 1 < lines.length; i++) {
    const [a, b] = [lines[i].match(/^--- (.+)$/), lines[i + 1].match(/^\+\+\+ (.+)$/)];
    if (!a || !b) continue;
    if (!a[1].startsWith('/dev/null')) reads.add(cut(a[1]));
    if (!b[1].startsWith('/dev/null')) writes.add(cut(b[1]));
  }
  return { reads: [...reads].filter(Boolean), writes: [...writes].filter(Boolean) };
}

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv, input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    if (input !== undefined) child.stdin!.end(input);
    let out = '';
    let err = '';
    child.stdout!.on('data', (d) => (out += d));
    child.stderr!.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} ${args.slice(2, 4).join(' ')} failed: ${err.trim().slice(0, 400)}`))));
  });
}
