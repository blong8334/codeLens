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

export const hasGh = (() => {
  let cached: boolean | undefined;
  // CODELENS_NO_GH skips the gh CLI (tests point CODELENS_GITHUB_API at a fake server).
  return () => (cached ??= !process.env.CODELENS_NO_GH && spawnSync('gh', ['auth', 'token'], { stdio: 'ignore' }).status === 0);
})();

const token = () => process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
/** REST root: api.github.com, or $CODELENS_GITHUB_API (GitHub Enterprise: https://host/api/v3). */
const apiRoot = () => (process.env.CODELENS_GITHUB_API ?? 'https://api.github.com').replace(/\/+$/, '');
const apiHeaders = () => ({ accept: 'application/vnd.github+json', 'user-agent': 'codelens', ...(token() ? { authorization: `Bearer ${token()}` } : {}) });

/**
 * GET a GitHub REST path through `gh` (signed-in auth, Enterprise hosts) or plain fetch.
 * With `paginate`, follows every page of a list endpoint and returns one array.
 */
export async function githubApi<T>(path: string, opts: { paginate?: boolean } = {}): Promise<T> {
  const sep = path.includes('?') ? '&' : '?';
  if (hasGh()) {
    if (!opts.paginate) return JSON.parse(await run('gh', ['api', path])) as T;
    // One JSON object per line, across all pages.
    const out = await run('gh', ['api', '--paginate', `${path}${sep}per_page=100`, '--jq', '.[] | @json']);
    return out.split('\n').filter(Boolean).map((l) => JSON.parse(l)) as T;
  }
  if (!opts.paginate) return (await fetchJson(path)) as T;
  const all: unknown[] = [];
  for (let page = 1; page <= 20; page++) {
    const items = (await fetchJson(`${path}${sep}per_page=100&page=${page}`)) as unknown[];
    all.push(...items);
    if (items.length < 100) break;
  }
  return all as T;
}

async function fetchJson(path: string): Promise<unknown> {
  const res = await fetch(`${apiRoot()}/${path.replace(/^\//, '')}`, { headers: apiHeaders() });
  if (!res.ok) throw new Error(`GitHub ${path}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

/** POST / PATCH / PUT a JSON body to a GitHub REST path, as the signed-in user. */
export const canPostToGitHub = () => hasGh() || !!token();

let login: Promise<string | undefined> | undefined;
/** Who CodeLens posts as (for "you can't approve your own pull request"), or undefined if unknown. */
export function viewerLogin(): Promise<string | undefined> {
  return (login ??= githubApi<{ login: string }>('user').then((u) => u.login, () => undefined));
}

export async function githubSend<T>(method: 'POST' | 'PATCH' | 'PUT', path: string, body: unknown): Promise<T> {
  if (hasGh()) return JSON.parse(await run('gh', ['api', '-X', method, path, '--input', '-'], JSON.stringify(body))) as T;
  if (!token()) throw new Error('to post to GitHub, sign in with `gh auth login` or set GITHUB_TOKEN');
  const res = await fetch(`${apiRoot()}/${path.replace(/^\//, '')}`, { method, headers: { ...apiHeaders(), 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`GitHub ${method} ${path}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
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
      headSha: pr.head.sha,
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

function run(cmd: string, args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    if (input !== undefined) child.stdin!.end(input);
    let out = '';
    let err = '';
    child.stdout!.on("data", (d) => (out += d));
    child.stderr!.on("data", (d) => (err += d));
    child.on('error', reject);
    // gh prints GitHub's error JSON on stdout and a summary ("HTTP 422") on stderr: keep both.
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} ${args.filter((a) => !a.startsWith('credential')).slice(0, 4).join(' ')} failed: ${`${err.trim()} ${out.trim()}`.trim().slice(0, 400)}`))));
  });
}
