import { simpleGit, type SimpleGit } from 'simple-git';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const WORKING_TREE = 'WORKING';

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
