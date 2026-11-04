// GitHub pull requests: look one up, get its code locally (reusing your clone when you have one),
// and hand the revisions to the review pipeline. Auth comes from the `gh` CLI when it is signed in,
// else $GITHUB_TOKEN / $GH_TOKEN; public repositories also work without either.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import { webUrl } from './git.ts';
import { cacheDir } from './store/index.ts';
import type { PullRequestInfo } from './types.ts';

export interface PrRef {
  owner?: string;
  repo?: string;
  number: number;
}

/** `123`, `#123`, `owner/repo#123`, or a pull request URL. */
export function parsePrRef(input: string): PrRef {
  const s = input.trim();
  let m = s.match(/^#?(\d+)$/);
  if (m) return { number: Number(m[1]) };
  m = s.match(/^([\w.-]+)\/([\w.-]+)#(\d+)$/);
  if (m) return { owner: m[1], repo: m[2], number: Number(m[3]) };
  m = s.match(/^https?:\/\/[^/]*github[^/]*\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/);
  if (m) return { owner: m[1], repo: m[2], number: Number(m[3]) };
  throw new Error(`not a pull request: "${input}" (expected 123, owner/repo#123, or a pull request URL)`);
}

const hasGh = (() => {
  let cached: boolean | undefined;
  return () => (cached ??= spawnSync('gh', ['auth', 'token'], { stdio: 'ignore' }).status === 0);
})();

/** GET a GitHub REST path through `gh` (signed-in auth, Enterprise hosts) or plain fetch. */
export async function githubApi<T>(path: string): Promise<T> {
  if (hasGh()) {
    const out = await run('gh', ['api', path]);
    return JSON.parse(out) as T;
  }
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  const res = await fetch(`https://api.github.com/${path.replace(/^\//, '')}`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'codelens', ...(token ? { authorization: `Bearer ${token}` } : {}) },
  });
  if (!res.ok) throw new Error(`GitHub ${path}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as T;
}

/** Git config that lets git fetch private repositories with the `gh` login. */
export const gitAuth = (): string[] => (hasGh() ? ['-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential'] : []);

interface ApiPull {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  state: string;
  draft?: boolean;
  merged_at: string | null;
  user: { login: string };
  base: { ref: string; sha: string; repo: { full_name: string; clone_url: string } };
  head: { ref: string; sha: string; repo: { full_name: string } | null };
  additions?: number;
  deletions?: number;
  changed_files?: number;
}

export interface CheckedOutPr {
  info: PullRequestInfo;
  /** Local repository holding both revisions. */
  root: string;
  base: string;
  head: string;
  /** True when CodeLens made (or reused) its own copy because no local clone was found. */
  cached: boolean;
}

/**
 * Resolve a pull request and fetch both its revisions into a local repository: the clone at
 * `dir` when it is the PR's repository, else a code-only clone in the CodeLens cache.
 */
export async function checkoutPr(input: string, dir: string, log: (m: string) => void): Promise<CheckedOutPr> {
  const ref = parsePrRef(input);
  let local: { root: string; slug?: string } | undefined;
  try {
    const root = (await simpleGit(dir).revparse(['--show-toplevel'])).trim();
    local = { root, slug: await repoSlug(root) };
  } catch {
    local = undefined;
  }
  const owner = ref.owner ?? local?.slug?.split('/')[0];
  const repo = ref.repo ?? local?.slug?.split('/')[1];
  if (!owner || !repo) throw new Error(`which repository is #${ref.number} in? Run inside a GitHub clone, or pass owner/repo#${ref.number} or the PR URL`);

  const pr = await githubApi<ApiPull>(`repos/${owner}/${repo}/pulls/${ref.number}`);
  const slug = pr.base.repo.full_name;
  log(`#${pr.number} ${pr.title} — ${pr.user.login} wants to merge ${pr.head.repo?.full_name === slug ? pr.head.ref : `${pr.head.repo?.full_name ?? 'deleted fork'}:${pr.head.ref}`} into ${pr.base.ref}`);

  // Prefer the user's own clone; otherwise keep a code-only clone per repository in the cache.
  let root: string;
  let cached = false;
  if (local && local.slug?.toLowerCase() === slug.toLowerCase()) root = local.root;
  else {
    root = join(cacheDir(), 'repos', ...slug.split('/'));
    cached = true;
    if (!existsSync(join(root, '.git'))) {
      log(`Cloning ${slug} (code only, into the CodeLens cache)…`);
      mkdirSync(root, { recursive: true });
      await run('git', [...gitAuth(), 'clone', '--quiet', '--no-checkout', pr.base.repo.clone_url, root]);
    }
  }
  // GitHub publishes every PR head (forks included) as refs/pull/N/head on the base repository.
  const remote = (await remoteFor(root, slug)) ?? pr.base.repo.clone_url;
  const shallow = (await run('git', ['-C', root, 'rev-parse', '--is-shallow-repository'])).trim() === 'true';
  log(`Fetching the pull request${shallow ? ' (and history, for the fork point)' : ''}…`);
  await run('git', [...gitAuth(), '-C', root, 'fetch', '--quiet', ...(shallow ? ['--unshallow'] : []), remote, `+refs/pull/${pr.number}/head:refs/codelens/pr/${pr.number}`, `+refs/heads/${pr.base.ref}:refs/codelens/base/${pr.base.ref}`]);
  // The diff GitHub shows is against the fork point, not the base branch's tip.
  const mergeBase = (await run('git', ['-C', root, 'merge-base', `refs/codelens/base/${pr.base.ref}`, pr.head.sha]).catch(() => '')).trim() || pr.base.sha;

  return {
    root,
    base: mergeBase,
    head: pr.head.sha,
    cached,
    info: {
      number: pr.number,
      title: pr.title,
      url: pr.html_url,
      author: pr.user.login,
      state: pr.merged_at ? 'merged' : pr.draft ? 'draft' : pr.state === 'open' ? 'open' : 'closed',
      baseRef: pr.base.ref,
      headRef: pr.head.ref,
      headRepo: pr.head.repo?.full_name,
      repo: slug,
      body: (pr.body ?? '').slice(0, 4000),
      additions: pr.additions,
      deletions: pr.deletions,
      changedFiles: pr.changed_files,
    },
  };
}

/** `owner/repo` of the repository's GitHub remote (origin first). */
async function repoSlug(root: string): Promise<string | undefined> {
  const git = simpleGit(root);
  const remotes = (await git.raw(['remote'])).split('\n').filter(Boolean);
  for (const name of ['origin', 'upstream', ...remotes]) {
    if (!remotes.includes(name)) continue;
    const web = webUrl((await git.raw(['remote', 'get-url', name])).trim());
    const m = web?.match(/^https:\/\/[^/]*github[^/]*\/([^/]+\/[^/]+)$/);
    if (m) return m[1];
  }
  return undefined;
}

/** Name of the remote pointing at `slug`, if the clone has one. */
async function remoteFor(root: string, slug: string): Promise<string | undefined> {
  const git = simpleGit(root);
  for (const name of (await git.raw(['remote'])).split('\n').filter(Boolean)) {
    const web = webUrl((await git.raw(['remote', 'get-url', name])).trim());
    if (web?.toLowerCase().endsWith(`/${slug.toLowerCase()}`)) return name;
  }
  return undefined;
}

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} ${args.filter((a) => !a.startsWith('credential')).slice(0, 4).join(' ')} failed: ${err.trim().slice(0, 300)}`))));
  });
}
