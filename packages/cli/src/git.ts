import { simpleGit, type SimpleGit } from 'simple-git';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const WORKING_TREE = 'WORKING';

/** Larger per-file diffs (generated files, lockfiles) are listed without their text. */
const MAX_PATCH_CHARS = 300_000;

export interface ReviewFileDiff {
  /** Unified diff hunks with 3 lines of context, from the first `@@`. */
  patch?: string;
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  additions: number;
  deletions: number;
  fingerprint: string;
}

export interface FileChange {
  status: 'added' | 'modified' | 'deleted';
  path: string;
  /** Path in the base revision (differs from `path` on renames). */
  basePath: string;
}

export class Repo {
  readonly git: SimpleGit;

  constructor(readonly root: string) {
    this.git = simpleGit(root);
  }

  static async open(dir: string): Promise<Repo> {
    const top = (await simpleGit(dir).revparse(['--show-toplevel'])).trim();
    return new Repo(top);
  }

  async resolve(ref: string): Promise<string> {
    if (ref === WORKING_TREE) return ref;
    return (await this.git.revparse(['--short', ref])).trim();
  }

  /** All files tracked (plus untracked, for the working tree) at `head`. */
  async listFiles(head: string): Promise<string[]> {
    if (head === WORKING_TREE) {
      const out = await this.git.raw(['ls-files', '--cached', '--others', '--exclude-standard']);
      return out.split('\n').filter(Boolean);
    }
    const out = await this.git.raw(['ls-tree', '-r', '--name-only', head]);
    return out.split('\n').filter(Boolean);
  }

  async readAt(ref: string, path: string): Promise<string | null> {
    try {
      if (ref === WORKING_TREE) return await readFile(join(this.root, path), 'utf8');
      return await this.git.show([`${ref}:${path}`]);
    } catch {
      return null;
    }
  }

  /**
   * Every changed file (code or not) with its line counts and a fingerprint of its own diff: the
   * fingerprint survives unrelated pushes and rebases, and changes when this file's changes do.
   */
  async fileDiffs(base: string, head: string): Promise<ReviewFileDiff[]> {
    const range = head === WORKING_TREE ? [base] : [base, head];
    const numstat = await this.git.raw(['diff', '--numstat', '-M', '--no-color', ...range]);
    const patch = await this.git.raw(['diff', '-M', '--no-color', '--no-ext-diff', '--unified=0', ...range]);
    // The readable version, with context, for the diff viewer.
    const full = await this.git.raw(['diff', '-M', '--no-color', '--no-ext-diff', '--unified=3', ...range]);
    const readable = new Map<string, string>();
    for (const chunk of full.split(/^diff --git /m).slice(1)) {
      const path = (chunk.match(/^\+\+\+ b\/(.+)$/m) ?? chunk.match(/^rename to (.+)$/m) ?? chunk.match(/^--- a\/(.+)$/m))?.[1];
      const start = chunk.indexOf('\n@@');
      if (path && start >= 0 && chunk.length <= MAX_PATCH_CHARS) readable.set(path, chunk.slice(start + 1).trimEnd());
    }
    const counts = new Map<string, { additions: number; deletions: number }>();
    for (const line of numstat.split('\n').filter(Boolean)) {
      const [a, d, ...rest] = line.split('\t');
      // Renames print `old => new` (or `dir/{old => new}/file`); keep the new path.
      const path = rest.join('\t').replace(/\{[^}]* => ([^}]*)\}/, '$1').replace(/^.* => /, '').replace(/\/\//g, '/');
      counts.set(path, { additions: Number(a) || 0, deletions: Number(d) || 0 });
    }
    const out: ReviewFileDiff[] = [];
    for (const chunk of patch.split(/^diff --git /m).slice(1)) {
      const path = (chunk.match(/^\+\+\+ b\/(.+)$/m) ?? chunk.match(/^rename to (.+)$/m) ?? chunk.match(/^--- a\/(.+)$/m))?.[1];
      if (!path) continue;
      const status = /^new file mode/m.test(chunk) ? 'added' : /^deleted file mode/m.test(chunk) ? 'deleted' : /^rename from/m.test(chunk) ? 'renamed' : 'modified';
      // Only the changed lines themselves: line numbers and context move with unrelated edits.
      const body = chunk
        .split('\n')
        .filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---) /.test(l))
        .join('\n');
      const fingerprint = createHash('sha1').update(`${status}\0${body}`).digest('hex').slice(0, 16);
      out.push({ path, status, fingerprint, ...(counts.get(path) ?? { additions: 0, deletions: 0 }), patch: readable.get(path) });
    }
    return out;
  }

  /** The checked-out branch name, or null when detached. */
  async branch(): Promise<string | null> {
    const b = (await this.git.raw(['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => '')).trim();
    return b && b !== 'HEAD' ? b : null;
  }

  async changedFiles(base: string, head: string): Promise<FileChange[]> {
    const args = ['diff', '--name-status', '-M', base];
    if (head !== WORKING_TREE) args.push(head);
    const out = await this.git.raw(args);
    const changes: FileChange[] = [];
    for (const line of out.split('\n').filter(Boolean)) {
      const [code, a, b] = line.split('\t');
      if (code.startsWith('R')) changes.push({ status: 'modified', path: b, basePath: a });
      else if (code === 'A') changes.push({ status: 'added', path: a, basePath: a });
      else if (code === 'D') changes.push({ status: 'deleted', path: a, basePath: a });
      else changes.push({ status: 'modified', path: a, basePath: a });
    }
    if (head === WORKING_TREE) {
      const untracked = await this.git.raw(['ls-files', '--others', '--exclude-standard']);
      for (const path of untracked.split('\n').filter(Boolean)) {
        changes.push({ status: 'added', path, basePath: path });
      }
    }
    return changes;
  }
}

export interface RemoteInfo {
  /** Browsable https URL of the repository, without credentials or `.git`. */
  web: string;
  host: 'github' | 'gitlab' | 'bitbucket' | 'other';
  /** Full commit id that code links point at. */
  commit: string;
}

/**
 * Where the code can be browsed online: `origin` (or the first remote), normalized from
 * ssh/https forms to a web URL. Undefined for repositories with no remote.
 */
export async function remoteInfo(root: string, commit: string | null): Promise<RemoteInfo | undefined> {
  if (!commit) return undefined;
  const git = simpleGit(root);
  try {
    const remotes = (await git.raw(['remote'])).split('\n').filter(Boolean);
    const name = remotes.includes('origin') ? 'origin' : remotes[0];
    if (!name) return undefined;
    const web = webUrl((await git.raw(['remote', 'get-url', name])).trim());
    if (!web) return undefined;
    const hostname = new URL(web).hostname;
    const host = /github/.test(hostname) ? 'github' : /gitlab/.test(hostname) ? 'gitlab' : /bitbucket/.test(hostname) ? 'bitbucket' : 'other';
    return { web, host, commit };
  } catch {
    return undefined;
  }
}

/** `git@github.com:o/r.git`, `ssh://git@host/o/r`, `https://token@host/o/r.git` → `https://host/o/r`. */
export function webUrl(remote: string): string | undefined {
  let m = remote.match(/^[\w.-]+@([^:/]+):(.+?)(\.git)?\/?$/);
  if (m) return `https://${m[1]}/${m[2]}`;
  m = remote.match(/^(?:ssh|git|https?):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+?)(\.git)?\/?$/);
  if (m) return `https://${m[1]}/${m[2]}`;
  return undefined;
}

/**
 * The revision a branch should be reviewed against, the way a pull request is: the merge base of
 * `base` (default: the remote's default branch, else main/master) and `head`.
 */
export async function reviewBase(root: string, base: string | undefined, head: string): Promise<{ base: string; label: string }> {
  const git = simpleGit(root);
  // `--quiet` makes git exit silently on a missing ref, which simple-git does not treat as an
  // error, so check that it actually printed a commit id.
  const exists = (ref: string) => git.raw(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).then((out) => /^[0-9a-f]{40}/.test(out.trim()), () => false);
  let target = base;
  if (!target) {
    const remoteHead = await git.raw(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']).then((s) => s.trim().replace('refs/remotes/', ''), () => '');
    for (const candidate of [remoteHead, 'origin/main', 'origin/master', 'main', 'master'].filter(Boolean)) {
      if (await exists(candidate)) {
        target = candidate;
        break;
      }
    }
    if (!target) throw new Error('could not find a base branch; pass --base <ref>');
  }
  const headRef = head === WORKING_TREE ? 'HEAD' : head;
  const mergeBase = await git.raw(['merge-base', target, headRef]).then((s) => s.trim(), () => '');
  return mergeBase ? { base: mergeBase, label: `${target} (fork point ${mergeBase.slice(0, 7)})` } : { base: target, label: target };
}
