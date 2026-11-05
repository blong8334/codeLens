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
  const [session, setSession] = useState({ live: false, canPost: false });
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
    call<{ pr: boolean; canPost: boolean }>('/api/session')
      .then((s) => {
        if (stop || !s.pr) return;
        setSession({ live: true, canPost: s.canPost });
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
  // `code`, [label](https://…) and bare https:// links; everything else stays text.
  const tokens = text.split(/(`[^`\n]+`|\[[^\]\n]+\]\(https?:\/\/[^)\s]+\)|https?:\/\/[^\s)]+)/g);
  const content = tokens.map((t, i) => {
    if (t.startsWith('`') && t.endsWith('`') && t.length > 2) return <code key={i}>{t.slice(1, -1)}</code>;
    const link = t.match(/^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/);
        if (link) return <a key={i} href={link[2]} target="_blank" rel="noreferrer">{link[1]}</a>;
        if (/^https?:\/\//.test(t)) return <a key={i} href={t} target="_blank" rel="noreferrer">{t}</a>;
        // **bold**: emphasized, never HTML.
        return t.split(/(\*\*[^*]+\*\*)/g).map((b, k) => (b.startsWith('**') && b.endsWith('**') && b.length > 4 ? <strong key={`${i}-${k}`}>{b.slice(2, -2)}</strong> : b));
      });
  return bare ? <>{content}</> : <p className="md-p">{content}</p>;
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
