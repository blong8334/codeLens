// A snapshot of source files at one point in time — a commit, a git working tree, or a plain
// directory — with a content id (git blob hash) for every file. Blob ids are what the store keys
// parses and descriptions by, so unchanged files are never re-read, re-parsed or re-described.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { simpleGit } from 'simple-git';
import { WORKING_TREE } from './git.ts';

export interface SourceFile {
  path: string;
  /** Git blob id of the content (computed the same way for files outside git). */
  blob: string;
  size?: number;
}

export interface Snapshot {
  /** Repository root (or the directory itself when it is not in a git repository). */
  root: string;
  isGit: boolean;
  /** `WORKING` or the short revision requested. */
  ref: string;
  /** Full commit id this snapshot is based on; null outside git or in an empty repository. */
  commit: string | null;
  /** True when the working tree differs from `commit`. */
  dirty: boolean;
  files: SourceFile[];
  read(file: SourceFile): Promise<string | null>;
  close(): void;
}

export const IGNORED_DIRS = /(^|\/)(node_modules|dist|build|out|target|vendor|coverage|\.next|\.nuxt|__pycache__|\.venv|venv|\.git|\.gradle|\.idea|Pods|DerivedData)\//;

/** Git's object id for a blob: sha1("blob <size>\0<content>"). */
export function blobId(content: Buffer | string): string {
  const buf = typeof content === 'string' ? Buffer.from(content) : content;
  return createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');
}

export async function openSnapshot(dir: string, ref: string = WORKING_TREE): Promise<Snapshot> {
  const abs = resolve(dir);
  let root: string | null = null;
  try {
    root = (await simpleGit(abs).revparse(['--show-toplevel'])).trim();
  } catch {
    root = null;
  }
  if (!root) {
    if (ref !== WORKING_TREE) throw new Error(`${abs} is not in a git repository, so --ref ${ref} cannot be used`);
    return directorySnapshot(abs);
  }
  return gitSnapshot(root, ref);
}

async function gitSnapshot(root: string, ref: string): Promise<Snapshot> {
  const git = simpleGit(root);
  const headCommit = await git.revparse(['HEAD']).then((s) => s.trim(), () => null);
  const reader = new BlobReader(root);
  const base = { root, isGit: true, close: () => reader.close() };

  if (ref !== WORKING_TREE) {
    const commit = (await git.revparse([`${ref}^{commit}`])).trim();
    const files: SourceFile[] = [];
    // <mode> SP <type> SP <object> SP <size> TAB <path>
    for (const line of (await git.raw(['ls-tree', '-r', '-l', '-z', '--full-tree', commit])).split('\0')) {
      const m = line.match(/^(\d+) blob ([0-9a-f]+)\s+(\d+|-)\t(.+)$/);
      if (m && m[1] !== '120000') files.push({ path: m[4], blob: m[2], size: Number(m[3]) });
    }
    return { ...base, ref: commit.slice(0, 7), commit, dirty: false, files, read: (f) => reader.read(f.blob) };
  }

  // Working tree: tracked files whose content matches the index reuse the index's blob id;
  // modified and untracked files are read from disk and hashed.
  const z = async (args: string[]) => (await git.raw(args)).split('\0').filter(Boolean);
  const deleted = new Set(await z(['ls-files', '-z', '--deleted']));
  const modified = new Set(await z(['diff', '--name-only', '-z']));
  const staged = headCommit ? (await z(['diff', '--cached', '--name-only', '-z'])).length > 0 : false;
  const untracked = await z(['ls-files', '-z', '--others', '--exclude-standard']);
  const onDisk = new Map<string, string>();
  const files: SourceFile[] = [];
  for (const entry of await z(['ls-files', '-z', '--stage'])) {
    // <mode> SP <object> SP <stage> TAB <path>
    const m = entry.match(/^(\d+) ([0-9a-f]+) (\d)\t(.+)$/);
    if (!m || m[1] === '120000' || m[1] === '160000' || m[3] !== '0' || deleted.has(m[4])) continue;
    if (!modified.has(m[4])) files.push({ path: m[4], blob: m[2] });
  }
  const fromDisk = [...modified].filter((p) => !deleted.has(p)).concat(untracked);
  for (const path of fromDisk) {
    if (IGNORED_DIRS.test(path)) continue;
    const content = await readFile(join(root, path)).catch(() => null);
    if (!content) continue;
    const blob = blobId(content);
    onDisk.set(blob, content.toString('utf8'));
    files.push({ path, blob, size: content.length });
  }
  return {
    ...base,
    ref: WORKING_TREE,
    commit: headCommit,
    dirty: staged || fromDisk.length > 0,
    files,
    read: async (f) => onDisk.get(f.blob) ?? reader.read(f.blob),
  };
}

async function directorySnapshot(root: string): Promise<Snapshot> {
  const contents = new Map<string, string>();
  const files: SourceFile[] = [];
  const walk = async (dir: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      const rel = relative(root, full);
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.') && !IGNORED_DIRS.test(`${rel}/`)) await walk(full);
      } else if (entry.isFile()) {
        const content = await readFile(full).catch(() => null);
        if (!content) continue;
        const blob = blobId(content);
        contents.set(blob, content.toString('utf8'));
        files.push({ path: rel, blob, size: content.length });
      }
    }
  };
  await walk(root);
  return { root, isGit: false, ref: WORKING_TREE, commit: null, dirty: false, files, read: async (f) => contents.get(f.blob) ?? null, close() {} };
}

/** One long-lived `git cat-file --batch`, so reading thousands of blobs costs one process. */
class BlobReader {
  private proc: ReturnType<typeof spawn> | null = null;
  private chunks: Buffer[] = [];
  private buffered = 0;
  private queue: { resolve: (s: string | null) => void }[] = [];

  constructor(private cwd: string) {}

  read(blob: string): Promise<string | null> {
    if (!this.proc) {
      this.proc = spawn('git', ['cat-file', '--batch'], { cwd: this.cwd, stdio: ['pipe', 'pipe', 'ignore'] });
      this.proc.stdout!.on('data', (d: Buffer) => {
        this.chunks.push(d);
        this.buffered += d.length;
        this.drain();
      });
      this.proc.on('exit', () => {
        for (const q of this.queue.splice(0)) q.resolve(null);
        this.proc = null;
      });
    }
    return new Promise((resolve) => {
      this.queue.push({ resolve });
      this.proc!.stdin!.write(`${blob}\n`);
    });
  }

  private drain() {
    let buf = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks);
    while (this.queue.length) {
      const nl = buf.indexOf(10);
      if (nl < 0) break;
      const header = buf.subarray(0, nl).toString();
      if (header.endsWith(' missing')) {
        buf = buf.subarray(nl + 1);
        this.queue.shift()!.resolve(null);
        continue;
      }
      const size = Number(header.split(' ')[2]);
      if (buf.length < nl + 1 + size + 1) break;
      const body = buf.subarray(nl + 1, nl + 1 + size).toString('utf8');
      buf = buf.subarray(nl + 2 + size);
      this.queue.shift()!.resolve(body);
    }
    this.chunks = buf.length ? [buf] : [];
    this.buffered = buf.length;
  }

  close() {
    this.proc?.stdin?.end();
  }
}
