import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import type { CodeGraph, FnNode } from './data.ts';
import type { PrDiscussion, PrReview, PrThread } from '../../cli/src/types.ts';

// ---- talking to `codelens view`'s local API (absent when the page is opened some other way) ----

const token = () => document.querySelector<HTMLMetaElement>('meta[name="codelens-token"]')?.content ?? '';

export async function call<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'content-type': 'application/json', 'x-codelens-token': token() },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

interface DiscussionState {
  discussion?: PrDiscussion;
  /** The local server can post to GitHub as the signed-in user. */
  canPost: boolean;
  /** The local server can fetch fresh discussion. */
  live: boolean;
  /** The GitHub account posts go out as. */
  login?: string;
  refreshing: boolean;
  refresh: () => Promise<void>;
  comment: (fnId: string, body: string) => Promise<string>;
  reply: (threadId: number, body: string) => Promise<string>;
  lineComment: (path: string, line: number, side: 'LEFT' | 'RIGHT', body: string) => Promise<string>;
  review: (event: 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES', body: string) => Promise<string>;
}

const Ctx = createContext<DiscussionState>({
  canPost: false,
  live: false,
  refreshing: false,
  refresh: async () => {},
  comment: async () => '',
  reply: async () => '',
  lineComment: async () => '',
  review: async () => '',
});
export const useDiscussion = () => useContext(Ctx);

const REFRESH_MS = 60_000;

/** Loads the discussion, keeps it fresh while the page is open, and posts on the user's behalf. */
export function DiscussionProvider({ graph, onChange, children }: { graph: CodeGraph; onChange: (d: PrDiscussion) => void; children: ReactNode }) {
  const pr = graph.meta.pr;
  const [discussion, setDiscussion] = useState<PrDiscussion | undefined>(pr?.discussion);
  const [session, setSession] = useState<{ live: boolean; canPost: boolean; login?: string }>({ live: false, canPost: false });
  const [refreshing, setRefreshing] = useState(false);

  const refresh = useCallback(async () => {
    if (!pr) return;
    setRefreshing(true);
    try {
      const fresh = await call<PrDiscussion>('/api/pr/discussion');
      setDiscussion(fresh);
      onChange(fresh);
    } finally {
      setRefreshing(false);
    }
  }, [pr, onChange]);

  useEffect(() => {
    if (!pr) return;
    let stop = false;
    call<{ pr: boolean; canPost: boolean; login?: string }>('/api/session')
      .then((s) => {
        if (stop || !s.pr) return;
        setSession({ live: true, canPost: s.canPost, login: s.login });
        void refresh().catch(() => {});
      })
      .catch(() => {});
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void refresh().catch(() => {});
    }, REFRESH_MS);
    return () => {
      stop = true;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pr?.url]);

  const after = async (p: Promise<{ url: string }>) => {
    const { url } = await p;
    await refresh().catch(() => {});
    return url;
  };
  const value: DiscussionState = {
    discussion,
    ...session,
    refreshing,
    refresh,
    comment: (fnId, body) => after(call('/api/pr/comment', { fnId, body })),
    reply: (threadId, body) => after(call('/api/pr/reply', { threadId, body })),
    lineComment: (path, line, side, body) => after(call('/api/pr/line-comment', { path, line, side, body })),
    review: (event, body) => after(call('/api/pr/review', { event, body })),
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

// ---- pieces ----

export function ago(iso: string): string {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (!Number.isFinite(s)) return '';
  if (s < 90) return 'just now';
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129600) return `${Math.round(s / 3600)} h ago`;
  if (s < 60 * 86400) return `${Math.round(s / 86400)} days ago`;
  return new Date(iso).toLocaleDateString();
}

/**
 * The Markdown GitHub comments mostly use (code blocks, suggested changes, inline code, links),
 * rendered as React elements: never as HTML, so a comment cannot inject anything into the page.
 */
export function Markdown({ text }: { text: string }) {
  const parts = text.split(/^```([\w-]*)[^\n]*\n([\s\S]*?)^```\s*$/m);
  const out: ReactNode[] = [];
  for (let i = 0; i < parts.length; i += 3) {
    out.push(...blocks(parts[i], `b${i}`));
    if (i + 2 < parts.length) {
      const lang = parts[i + 1];
      out.push(
        <div key={`c${i}`} className={`md-code ${lang === 'suggestion' ? 'md-suggestion' : ''}`}>
          {lang === 'suggestion' && <div className="md-code-label">Suggested change</div>}
          <pre className="mono">{parts[i + 2].replace(/\n$/, '')}</pre>
        </div>,
      );
    }
  }
  return <>{out}</>;
}

/** Headings, lists, tables and paragraphs, as React elements. */
function blocks(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  const lines = text.replace(/<!--[\s\S]*?-->/g, '').split('\n');
  let para: string[] = [];
  const flush = () => {
    if (para.join('').trim()) out.push(<Inline key={`${keyPrefix}p${out.length}`} text={para.join('\n').trim()} />);
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    if (heading) {
      flush();
      out.push(
        <h4 key={`${keyPrefix}h${i}`} className="md-h">
          <Inline text={heading[1]} bare />
        </h4>,
      );
      continue;
    }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      flush();
      const ordered = /^\s*\d/.test(line);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) {
        let item = lines[i].replace(/^\s*([-*+]|\d+[.)])\s+/, '');
        // Continuation lines belong to the item.
        while (i + 1 < lines.length && /^\s{2,}\S/.test(lines[i + 1]) && !/^\s*([-*+]|\d+[.)])\s+/.test(lines[i + 1])) item += ` ${lines[++i].trim()}`;
        items.push(item);
        i++;
      }
      i--;
      const List = ordered ? 'ol' : 'ul';
      out.push(
        <List key={`${keyPrefix}l${i}`} className="md-list">
          {items.map((it, k) => (
            <li key={k}>
              <Inline text={it.replace(/^\[( |x)\]\s*/i, (m) => (m.includes('x') || m.includes('X') ? '☑ ' : '☐ '))} bare />
            </li>
          ))}
        </List>,
      );
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      flush();
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        if (!/^\s*\|[\s:|-]+\|\s*$/.test(lines[i])) rows.push(lines[i].trim().slice(1, -1).split('|').map((c) => c.trim()));
        i++;
      }
      i--;
      out.push(
        <div key={`${keyPrefix}t${i}`} className="md-table-wrap">
          <table className="md-table">
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri}>
                  {r.map((c, ci) => (ri === 0 ? <th key={ci}><Inline text={c} bare /></th> : <td key={ci}><Inline text={c} bare /></td>))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    if (!line.trim()) flush();
    else para.push(line);
  }
  flush();
  return out;
}

function Inline({ text, bare }: { text: string; bare?: boolean }) {
  const content = inline(text, 'i');
  return bare ? <>{content}</> : <p className="md-p">{content}</p>;
}

// `code` (any number of backticks, so code can contain one), **bold** (which may hold code),
// [label](https://…) and bare https:// links; everything else stays text, never HTML.
const INLINE = /(`+)([^\n]*?[^`\n])\1(?!`)|\*\*(.+?)\*\*|\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)|(https?:\/\/[^\s)]+)/g;

function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const k = `${key}-${m.index}`;
    if (m[1]) out.push(<code key={k}>{m[1].length > 1 ? m[2].replace(/^ (.*) $/, '$1') : m[2]}</code>);
    else if (m[3] !== undefined) out.push(<strong key={k}>{inline(m[3], k)}</strong>);
    else if (m[4]) out.push(<a key={k} href={m[5]} target="_blank" rel="noreferrer">{m[4]}</a>);
    else out.push(<a key={k} href={m[6]} target="_blank" rel="noreferrer">{m[6]}</a>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function Comment({ author, body, createdAt, url }: { author: string; body: string; createdAt: string; url: string }) {
  return (
    <div className="gh-comment">
      <div className="gh-comment-head">
        <b>{author}</b>
        <a href={url} target="_blank" rel="noreferrer" className="muted small">
          {ago(createdAt)} ↗
        </a>
      </div>
      <div className="gh-comment-body">
        <Markdown text={body} />
      </div>
    </div>
  );
}

export function Compose({ placeholder, actions, hint }: { placeholder: string; hint?: string; actions: { label: string; primary?: boolean; run: (text: string) => Promise<string>; allowEmpty?: boolean }[] }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string; url?: string } | null>(null);
  const go = async (a: (typeof actions)[number]) => {
    setBusy(true);
    setResult(null);
    try {
      const url = await a.run(text);
      setText('');
      setResult({ ok: true, message: 'Posted', url });
    } catch (err) {
      setResult({ ok: false, message: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="compose">
      <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder={placeholder} rows={3} disabled={busy} />
      {hint && <div className="muted small">{hint}</div>}
      <div className="compose-actions">
        {actions.map((a) => (
          <button key={a.label} className={`btn btn-small ${a.primary ? 'btn-primary' : ''}`} disabled={busy || (!a.allowEmpty && !text.trim())} onClick={() => go(a)}>
            {a.label}
          </button>
        ))}
        {result && (
          <span className={`compose-result ${result.ok ? 'ok' : 'err'}`}>
            {result.message}
            {result.url && (
              <>
                {' · '}
                <a href={result.url} target="_blank" rel="noreferrer">
                  view on GitHub ↗
                </a>
              </>
            )}
          </span>
        )}
      </div>
    </div>
  );
}

export function ThreadView({ thread }: { thread: PrThread }) {
  const { canPost, reply } = useDiscussion();
  const [replying, setReplying] = useState(false);
  return (
    <div className={`gh-thread ${thread.outdated ? 'is-outdated' : ''}`}>
      <div className="gh-thread-where">
        <span className="mono">
          {thread.path}:{thread.line ?? thread.originalLine}
        </span>
        {thread.outdated && <span className="badge badge-quiet" title="The code has changed since this comment">outdated</span>}
      </div>
      {thread.comments.map((c) => (
        <Comment key={c.id} {...c} />
      ))}
      {canPost &&
        (replying ? (
          <Compose placeholder="Reply…" actions={[{ label: 'Reply', primary: true, run: (t) => reply(thread.id, t) }]} />
        ) : (
          <button className="link small" onClick={() => setReplying(true)}>
            Reply
          </button>
        ))}
    </div>
  );
}

/** The discussion section of a function's panel. */
export function FunctionDiscussion({ fn, threads }: { fn: FnNode; threads: PrThread[] }) {
  const { canPost, live, comment } = useDiscussion();
  return (
    <>
      {threads.length === 0 && <p className="muted small">No review comments on this function yet.</p>}
      {threads.map((t) => (
        <ThreadView key={t.id} thread={t} />
      ))}
      {canPost ? (
        <Compose
          placeholder={`Comment on ${fn.qualifiedName}…`}
          hint={fn.diff ? 'Posted on the first changed line of this function.' : 'This function is unchanged, so the comment goes on the pull request conversation, linked to it.'}
          actions={[{ label: 'Comment', primary: true, run: (t) => comment(fn.id, t) }]}
        />
      ) : (
        <p className="muted small">{live ? 'Sign in with `gh auth login` to comment from CodeLens.' : 'Open this graph with `codelens view` to comment from CodeLens.'}</p>
      )}
    </>
  );
}

const STATE_LABEL: Record<PrReview['state'], string> = {
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'requested changes',
  COMMENTED: 'commented',
  DISMISSED: 'dismissed',
  PENDING: 'pending',
};

/** Each reviewer's standing verdict, as GitHub counts it: their latest approve / request changes. */
export function reviewVerdicts(reviews: PrReview[]): PrReview[] {
  const latest = new Map<string, PrReview>();
  for (const r of [...reviews].sort((a, b) => a.submittedAt.localeCompare(b.submittedAt))) {
    if (r.state === 'COMMENTED' && latest.has(r.author)) continue;
    latest.set(r.author, r);
  }
  return [...latest.values()];
}

export function ReviewsSummary() {
  const { discussion, refresh, refreshing, live } = useDiscussion();
  if (!discussion) return null;
  const verdicts = reviewVerdicts(discussion.reviews);
  return (
    <div className="gh-reviews">
      <div className="gh-reviews-head">
        <span className="purpose-label">Reviews</span>
        {live && (
          <button className="link small" onClick={() => void refresh().catch(() => {})} disabled={refreshing} title={`Updated ${ago(discussion.fetchedAt)}`}>
            {refreshing ? 'refreshing…' : `↻ ${ago(discussion.fetchedAt)}`}
          </button>
        )}
      </div>
      {verdicts.length === 0 && <span className="muted small">No reviews yet.</span>}
      <div className="gh-verdicts">
        {verdicts.map((r) => (
          <a key={r.author} href={r.url} target="_blank" rel="noreferrer" className={`gh-verdict v-${r.state.toLowerCase()}`}>
            {r.state === 'APPROVED' ? '✓' : r.state === 'CHANGES_REQUESTED' ? '✕' : '💬'} {r.author} {STATE_LABEL[r.state]}
          </a>
        ))}
      </div>
    </div>
  );
}

/**
 * Finish the review on GitHub: approve (or request changes), with an optional comment. Prominent
 * once every change is reviewed; explains up front when GitHub won't allow it (your own PR).
 */
export function ApproveReview({ author, complete, remaining }: { author: string; complete: boolean; remaining: number }) {
  const { canPost, login, review, discussion } = useDiscussion();
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState<{ event: string; url: string } | null>(null);
  if (!canPost) return null;
  const mine = !!login && login.toLowerCase() === author.toLowerCase();
  const verdict = discussion && login ? reviewVerdicts(discussion.reviews).find((r) => r.author.toLowerCase() === login.toLowerCase()) : undefined;
  if (done)
    return (
      <div className="approve-done">
        {done.event === 'APPROVE' ? '✓ Approved' : 'Changes requested'} ·{' '}
        <a href={done.url} target="_blank" rel="noreferrer">
          view on GitHub ↗
        </a>
      </div>
    );
  if (mine)
    return (
      <div className="approve-note muted small" title="GitHub does not allow approving or requesting changes on your own pull request">
        Your pull request: GitHub doesn't let authors approve their own. Comments still work.
      </div>
    );
  if (!open)
    return (
      <button className={`btn ${complete ? 'btn-primary approve-ready' : ''} approve-btn`} onClick={() => setOpen(true)} title={complete ? 'Everything is reviewed' : `${remaining} change${remaining === 1 ? '' : 's'} not reviewed yet`}>
        {verdict?.state === 'APPROVED' ? '✓ You approved · review again' : complete ? '✓ Approve PR' : 'Approve PR…'}
        {!complete && <span className="approve-remaining"> · {remaining} left</span>}
      </button>
    );
  const run = (event: 'APPROVE' | 'REQUEST_CHANGES') => async (text: string) => {
    const url = await review(event, text);
    setDone({ event, url });
    return url;
  };
  return (
    <div className="approve-box">
      {!complete && <div className="approve-warn small">{remaining} change{remaining === 1 ? ' is' : 's are'} not reviewed yet.</div>}
      <Compose
        placeholder="Optional comment for the author…"
        actions={[
          { label: 'Approve', primary: true, allowEmpty: true, run: run('APPROVE') },
          { label: 'Request changes', run: run('REQUEST_CHANGES') },
          { label: 'Cancel', allowEmpty: true, run: async () => (setOpen(false), '') },
        ]}
      />
    </div>
  );
}

export function ReviewBox() {
  const { canPost, review } = useDiscussion();
  if (!canPost) return null;
  return (
    <Compose
      placeholder="Leave a review…"
      actions={[
        { label: 'Comment', run: (t) => review('COMMENT', t) },
        { label: 'Approve', primary: true, allowEmpty: true, run: (t) => review('APPROVE', t) },
        { label: 'Request changes', run: (t) => review('REQUEST_CHANGES', t) },
      ]}
    />
  );
}

/** Conversation comments and line threads that are not on any function in the map. */
export function OtherDiscussion({ placed }: { placed: Set<number> }) {
  const { discussion } = useDiscussion();
  if (!discussion) return null;
  const loose = discussion.threads.filter((t) => !placed.has(t.id));
  return (
    <>
      {discussion.conversation.map((c) => (
        <Comment key={c.id} {...c} />
      ))}
      {loose.map((t) => (
        <ThreadView key={t.id} thread={t} />
      ))}
    </>
  );
}
