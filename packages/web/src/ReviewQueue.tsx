import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { displayName, ENTRY_LABEL, isDone, isTest, riskLevel, type FnNode, type Index } from './data.ts';
import { DiffTable, functionHunks, hunksFor, OutdatedThreads, parseHunks, SplitSwitch, useSplitView } from './DiffViewer.tsx';
import { ApproveReview, FunctionDiscussion, useDiscussion } from './Discussion.tsx';
import { codeLinks } from './links.ts';
import { ChatPanel, useChatInfo } from './Chat.tsx';
import { ResetMarks, ReviewProgress, useMarks, type MarkState } from './Marks.tsx';
import { NavButtons, Prose, type NavControls } from './Panel.tsx';
import { RiskBar, StatusBadge } from './nodes.tsx';
import type { ReviewFile } from '../../cli/src/types.ts';

/** One thing to review: a changed function, or a changed file with no functions (README, config…). */
export type QueueItem =
  | { key: string; kind: 'fn'; fn: FnNode; section: Section; reason?: string }
  | { key: string; kind: 'file'; file: ReviewFile; section: Section };
type Section = 'Start here' | 'Changes' | 'Moved and renamed' | 'Tests' | 'Other files' | 'Skipped';
const SECTIONS: Section[] = ['Start here', 'Changes', 'Moved and renamed', 'Tests', 'Other files', 'Skipped'];
/** Items the reviewer's preferences skip: listed apart, not counted as left to review. */
const counts = (q: QueueItem) => q.section !== 'Skipped';

/**
 * The order to review in: the brief's suggested reading order first (with its reasons), then the
 * remaining changes by risk, then tests, then files that changed outside any function.
 */
export function buildQueue(ix: Index): QueueItem[] {
  const out: QueueItem[] = [];
  const seen = new Set<string>();
  const skipped = new Set(ix.graph.review?.skipped ?? []);
  const add = (fn: FnNode | undefined, section: Section, reason?: string) => {
    if (!fn || seen.has(fn.id) || fn.status === 'unchanged') return;
    seen.add(fn.id);
    const where: Section = skipped.has(fn.id) ? 'Skipped' : section === 'Start here' ? section : fn.moved?.exact ? 'Moved and renamed' : isTest(fn) ? 'Tests' : section;
    out.push({ key: fn.id, kind: 'fn', fn, section: where, reason });
  };
  for (const r of ix.graph.enrichment?.brief?.readingOrder ?? []) add(ix.fns.get(r.id), 'Start here', r.reason);
  for (const id of ix.reviewOrder) if (!isTest(ix.fns.get(id)!)) add(ix.fns.get(id), 'Changes');
  for (const id of ix.reviewOrder) add(ix.fns.get(id), 'Tests');
  for (const f of ix.graph.review?.files ?? []) if (f.functions === 0) out.push({ key: `file:${f.path}`, kind: 'file', file: f, section: skipped.has(f.path) ? 'Skipped' : 'Other files' });
  return out;
}

interface Props {
  ix: Index;
  nav?: NavControls;
  at: string | null;
  onAt: (key: string) => void;
  /** Show a function on the map. */
  onMap: (fnId: string) => void;
  /** Full-screen diff of a file. */
  onDiff: (path: string, fnId?: string) => void;
}

/** One change at a time: what it is, its diff, and what it touches — then accept and move on. */
export function ReviewQueue({ ix, nav, at, onAt, onMap, onDiff }: Props) {
  const queue = useMemo(() => buildQueue(ix), [ix]);
  const marks = useMarks();
  const [hideDone, setHideDone] = useState(false);
  const [showSkipped, setShowSkipped] = useState(false);
  const chat = useChatInfo();
  const [chatOpen, setChatOpen] = useState(false);
  const commentBox = useRef<HTMLDivElement>(null);
  // The pending "move to the next change" after an accept: cancelled by anything else you do.
  const advance = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelAdvance = () => {
    if (advance.current) clearTimeout(advance.current);
    advance.current = null;
  };
  // The last accept, for the undo bar.
  const [lastAccepted, setLastAccepted] = useState<QueueItem | null>(null);
  const goTo = (key: string) => {
    cancelAdvance();
    onAt(key);
  };
  useEffect(() => cancelAdvance, []);
  const done = (it: QueueItem) => (it.kind === 'fn' ? isDone(ix, it.fn) : marks.reviewed.has(it.file.path));
  const markOf = (it: QueueItem): MarkState => (done(it) ? 'reviewed' : it.kind === 'fn' ? marks.fnState(it.fn.id) : marks.state(it.file.path));
  const current = queue.find((q) => q.key === at) ?? queue.find((q) => counts(q) && !done(q)) ?? queue.find(counts) ?? queue[0];

  // Next / previous open item from here (wrapping); stays put when everything is done.
  const step = (dir: 1 | -1, fromKey = current?.key) => {
    cancelAdvance();
    const i = queue.findIndex((q) => q.key === fromKey);
    for (let k = 1; k <= queue.length; k++) {
      const q = queue[(i + dir * k + queue.length * k) % queue.length];
      if (counts(q) && !done(q)) return onAt(q.key);
    }
  };
  const setDone = (it: QueueItem, on: boolean) => (it.kind === 'fn' ? marks.toggleFn(it.fn.id, on) : marks.toggle(it.file.path, on));
  const accept = () => {
    if (!current) return;
    cancelAdvance();
    const on = !done(current);
    setDone(current, on);
    if (!on) return setLastAccepted(null);
    // Like archiving: accepting moves on to the next open change, with an undo bar.
    setLastAccepted(current);
    const from = current.key;
    advance.current = setTimeout(() => {
      advance.current = null;
      step(1, from);
    }, 150);
  };
  /** Undo the last accept and go back to it, wherever you are now. */
  const undo = () => {
    if (!lastAccepted) return;
    cancelAdvance();
    setDone(lastAccepted, false);
    onAt(lastAccepted.key);
    setLastAccepted(null);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.metaKey || e.ctrlKey || e.altKey) return;
      const keys: Record<string, () => void> = {
        a: accept,
        u: undo,
        n: () => step(1),
        j: () => step(1),
        p: () => step(-1),
        k: () => step(-1),
        c: () => commentBox.current?.querySelector('textarea')?.focus(),
        z: () => current?.kind === 'fn' && onMap(current.fn.id),
        d: () => current && onDiff(current.kind === 'fn' ? current.fn.file : current.file.path, current.kind === 'fn' ? current.fn.id : undefined),
      };
      const run = keys[e.key];
      if (!run) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      run();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  if (!current) return <div className="empty">Nothing to review in this change.</div>;
  const open = queue.filter((q) => counts(q) && !done(q)).length;

  return (
    <div className="queue">
      <aside className="queue-list" aria-label="Review queue">
        <div className="queue-list-head">
          <NavButtons nav={nav} />
          <ReviewProgress />
          {ix.graph.meta.pr && <ApproveReview author={ix.graph.meta.pr.author} complete={queue.filter(counts).every(done)} remaining={open} />}
          <div className="queue-list-tools">
            <label className="hide-done">
              <input type="checkbox" checked={hideDone} onChange={(e) => setHideDone(e.target.checked)} /> hide done
            </label>
            <ResetMarks />
          </div>
        </div>
        {SECTIONS.map((section) => {
          const all = queue.filter((q) => q.section === section);
          const items = all.filter((q) => !hideDone || !done(q) || q.key === current.key);
          if (!items.length) return null;
          const folded = section === 'Skipped' && !showSkipped && current.section !== 'Skipped';
          return (
            <div key={section} className="queue-section">
              {section === 'Skipped' ? (
                <button className="queue-section-label link" onClick={() => setShowSkipped(folded)} title={ix.graph.review?.preferences?.source}>
                  {folded ? '▸' : '▾'} Skipped by your preferences ({all.length})
                </button>
              ) : (
                <div className="queue-section-label">{section}</div>
              )}
              {!folded && items.map((q) => (
                <button key={q.key} className={`queue-item mark-${markOf(q)} ${q.key === current.key ? 'is-current' : ''}`} onClick={() => goTo(q.key)}>
                  <span className="queue-check">{markOf(q) === 'reviewed' ? '✓' : markOf(q) === 'stale' ? '↻' : '○'}</span>
                  <span className="queue-item-text">
                    <span className="mono queue-item-name">{q.kind === 'fn' ? displayName(q.fn) : q.file.path.split('/').pop()}</span>
                    <span className="queue-item-file mono">{q.kind === 'fn' ? q.fn.file : q.file.path}</span>
                  </span>
                  {q.kind === 'fn' && q.fn.enrichment && <span className={`risk-dot risk-${riskLevel(q.fn.enrichment.blastRadius)}`} title={`Blast radius ${q.fn.enrichment.blastRadius.toFixed(2)}`} />}
                  {q.kind === 'file' && (
                    <span className="file-row-meta">
                      <span className="pr-add">+{q.file.additions}</span>
                      <span className="pr-del">−{q.file.deletions}</span>
                    </span>
                  )}
                </button>
              ))}
            </div>
          );
        })}
      </aside>

      <main className="queue-main">
        {current.kind === 'fn' ? (
          <FunctionReview ix={ix} item={current} mark={markOf(current)} commentBox={commentBox} onAccept={accept} onStep={step} onMap={onMap} onDiff={onDiff} open={open} onAsk={chat ? () => setChatOpen(!chatOpen) : undefined} asking={chatOpen} />
        ) : (
          <FileReview ix={ix} file={current.file} mark={markOf(current)} onAccept={accept} onStep={step} onDiff={onDiff} open={open} />
        )}
      </main>

      {current.kind === 'fn' && (
        <aside className="queue-context" aria-label="Context">
          <Context ix={ix} fn={current.fn} queue={queue} onAt={goTo} onMap={onMap} />
        </aside>
      )}
      {chat && chatOpen && <ChatPanel chat={chat} focus={current.kind === 'fn' ? current.fn : undefined} onClose={() => setChatOpen(false)} />}
      {lastAccepted && done(lastAccepted) && (
        <div className="undo-bar" role="status">
          Accepted <span className="mono">{lastAccepted.kind === 'fn' ? displayName(lastAccepted.fn) : lastAccepted.file.path}</span>
          <button className="link" onClick={undo}>
            Undo <kbd>u</kbd>
          </button>
          <button className="icon-btn" onClick={() => setLastAccepted(null)} aria-label="Dismiss">
            ✕
          </button>
        </div>
      )}
    </div>
  );
}

function Actions({ mark, onAccept, onStep, open, children }: { mark: MarkState; onAccept: () => void; onStep: (d: 1 | -1) => void; open: number; children?: ReactNode }) {
  const { loaded } = useMarks();
  return (
    <div className="queue-actions">
      <button
        className={`btn accept-btn accept-${mark === 'reviewed' ? 'reviewed' : mark === 'stale' ? 'stale' : 'open'}`}
        onClick={onAccept}
        disabled={!loaded}
        title={mark === 'reviewed' ? 'Undo: reopen this change (a)' : 'Accept and go to the next change (a)'}
      >
        {mark === 'reviewed' ? (
          <>
            ✓ Accepted <span className="undo-hint">· undo</span>
          </>
        ) : mark === 'stale' ? (
          '↻ Changed since: accept again'
        ) : (
          '✓ Accept'
        )}{' '}
        <kbd>a</kbd>
      </button>
      {children}
      <span className="queue-actions-spacer" />
      <span className="muted small">{open ? `${open} left` : 'All done ✓'}</span>
      <button className="icon-btn nav-btn" onClick={() => onStep(-1)} title="Previous open change (p)">
        ‹ <kbd>p</kbd>
      </button>
      <button className="icon-btn nav-btn" onClick={() => onStep(1)} title="Next open change (n)">
        <kbd>n</kbd> ›
      </button>
    </div>
  );
}

function FunctionReview({
  ix,
  item,
  mark,
  commentBox,
  onAccept,
  onStep,
  onMap,
  onDiff,
  open,
  onAsk,
  asking,
}: {
  ix: Index;
  item: Extract<QueueItem, { kind: 'fn' }>;
  mark: MarkState;
  commentBox: React.RefObject<HTMLDivElement | null>;
  onAccept: () => void;
  onStep: (d: 1 | -1) => void;
  onMap: (id: string) => void;
  onDiff: (path: string, fnId?: string) => void;
  open: number;
  /** Open or close "Ask" (absent when no model is available). */
  onAsk?: () => void;
  asking?: boolean;
}) {
  const { fn } = item;
  const e = fn.enrichment;
  const [split, toggleSplit] = useSplitView();
  const { discussion } = useDiscussion();
  const hunks = useMemo(() => {
    // Deleted functions live in the old file: their own diff already has the right old lines.
    if (fn.status === 'deleted' && fn.diff) return parseHunks(fn.diff, fn.range.startLine - 1);
    return functionHunks(hunksFor(ix, fn.file, fn.id), fn.range.startLine, fn.range.endLine);
  }, [ix, fn]);
  const risks = (ix.graph.enrichment?.brief?.risks ?? []).filter((r) => r.fnIds.includes(fn.id));
  const invariants = (e?.invariants ?? []).filter((i) => i.status !== 'preserved');
  const showSig = e?.contract.before && e.contract.after && e.contract.before !== e.contract.after;
  const link = codeLinks(ix.graph, fn.file, fn.qualifiedName === '(top level)' ? undefined : fn.range).web;
  const threads = (discussion?.threads ?? []).filter((t) => t.fnId === fn.id);

  return (
    <div className="queue-review" key={fn.id}>
      <header className="queue-head">
        <div className="queue-title">
          <h2 className="mono">{displayName(fn)}</h2>
          <StatusBadge status={fn.status} />
          {e && <RiskBar value={e.blastRadius} />}
        </div>
        <div className="queue-sub mono">
          {fn.file}:{fn.range.startLine}
          {link && (
            <a href={link} target="_blank" rel="noreferrer">
              {' '}
              ↗
            </a>
          )}
        </div>
      </header>
      <Actions mark={mark} onAccept={onAccept} onStep={onStep} open={open}>
        <button className="btn" onClick={() => onDiff(fn.file, fn.id)} title="The whole file's diff (d)">
          Whole file <kbd>d</kbd>
        </button>
        <button className="btn" onClick={() => onMap(fn.id)} title="Callers and callees on the map (z)">
          Map <kbd>z</kbd>
        </button>
        {onAsk && (
          <button className={`btn ask-btn ${asking ? 'is-on' : ''}`} onClick={onAsk} title="Ask the model about this change">
            ✦ Ask
          </button>
        )}
      </Actions>

      {(item.reason || e?.summary) && (
        <section className="queue-note">
          {item.reason && (
            <p className="queue-reason">
              <span className="queue-label">Why now</span> <Prose text={item.reason} />
            </p>
          )}
          {e?.summary && (
            <p>
              <Prose text={e.summary} />
            </p>
          )}
          {e && e.reasons.length > 0 && (
            <ul className="queue-reasons">
              {e.reasons.map((r, i) => (
                <li key={i}>
                  <Prose text={r} />
                </li>
              ))}
            </ul>
          )}
          {e?.concerns && e.concerns.length > 0 && (
            <ul className="queue-concerns">
              {e.concerns.map((c, i) => (
                <li key={i}>
                  <span className="concern-topic">{c.topic}</span> <Prose text={c.note} />
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {(showSig || e?.contract.breaking) && (
        <section className={`queue-callout ${e?.contract.breaking ? 'bad' : ''}`}>
          <div className="queue-callout-title">{e?.contract.breaking ? '⚠ Breaking contract change' : e?.contract.compilerChecked ? 'Signature changed · compiler-checked: every caller is updated in this change' : 'Signature changed'}</div>
          <p>
            <Prose text={e!.contract.description} />
          </p>
          {showSig && (
            <div className="sig mono sig-large">
              <div className="sig-before">{e!.contract.before}</div>
              <div className="sig-after">{e!.contract.after}</div>
            </div>
          )}
        </section>
      )}
      {risks.map((r, i) => (
        <section key={i} className="queue-callout warn">
          <div className="queue-callout-title">
            <Prose text={r.title} />
          </div>
          <p>
            <Prose text={r.detail} />
          </p>
        </section>
      ))}
      {invariants.length > 0 && (
        <section className="queue-callout warn">
          <div className="queue-callout-title">Invariants at risk</div>
          <ul>
            {invariants.map((inv, i) => (
              <li key={i}>
                <span className={`badge inv-badge-${inv.status}`}>{inv.status}</span> <Prose text={inv.statement} />
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="queue-diff">
        <div className="queue-diff-head">
          <span className="queue-label">The change</span>
          <SplitSwitch split={split} toggle={toggleSplit} />
        </div>
        <OutdatedThreads path={fn.file} />
        {hunks.length ? (
          <div className="queue-diff-body">
            <DiffTable path={fn.file} hunks={hunks} split={split} />
          </div>
        ) : (
          <p className="muted small">No line changes to show here{fn.diff ? '' : ' (this graph was saved without source)'}.</p>
        )}
      </section>

      {ix.graph.meta.pr && (
        <section className="queue-discussion" ref={commentBox}>
          <div className="queue-label">Discussion {threads.length ? `(${threads.length})` : ''}</div>
          <FunctionDiscussion fn={fn} threads={threads} />
        </section>
      )}
    </div>
  );
}

function FileReview({ ix, file, mark, onAccept, onStep, onDiff, open }: { ix: Index; file: ReviewFile; mark: MarkState; onAccept: () => void; onStep: (d: 1 | -1) => void; onDiff: (path: string) => void; open: number }) {
  const [split, toggleSplit] = useSplitView();
  const hunks = useMemo(() => hunksFor(ix, file.path), [ix, file.path]);
  return (
    <div className="queue-review" key={file.path}>
      <header className="queue-head">
        <div className="queue-title">
          <h2 className="mono">{file.path}</h2>
          <span className={`badge status-${file.status === 'renamed' ? 'modified' : file.status}`}>{file.status}</span>
        </div>
        <div className="queue-sub">
          <span className="pr-add">+{file.additions}</span> <span className="pr-del">−{file.deletions}</span> · no functions changed
        </div>
      </header>
      <Actions mark={mark} onAccept={onAccept} onStep={onStep} open={open}>
        <button className="btn" onClick={() => onDiff(file.path)}>
          Full screen <kbd>d</kbd>
        </button>
      </Actions>
      <section className="queue-diff">
        <div className="queue-diff-head">
          <span className="queue-label">The change</span>
          <SplitSwitch split={split} toggle={toggleSplit} />
        </div>
        <OutdatedThreads path={file.path} />
        {hunks.length ? (
          <div className="queue-diff-body">
            <DiffTable path={file.path} hunks={hunks} split={split} />
          </div>
        ) : (
          <p className="muted small">No text diff for this file (too large, binary, or saved without source).</p>
        )}
      </section>
    </div>
  );
}

/** What the function is for and what it touches: enough to judge the change without the map. */
function Context({ ix, fn, queue, onAt, onMap }: { ix: Index; fn: FnNode; queue: QueueItem[]; onAt: (key: string) => void; onMap: (id: string) => void }) {
  const inQueue = new Set(queue.map((q) => q.key));
  const callers = (ix.callers.get(fn.id) ?? []).map((e) => ix.fns.get(e.source)!).filter((f) => f && !isTest(f));
  const testCallers = (ix.callers.get(fn.id) ?? []).map((e) => ix.fns.get(e.source)!).filter((f) => f && isTest(f)).length;
  const callees = (ix.callees.get(fn.id) ?? []).map((e) => ix.fns.get(e.target)!).filter(Boolean);
  const entries = useMemo(() => entriesReaching(ix, fn.id), [ix, fn.id]);
  const go = (f: FnNode) => (inQueue.has(f.id) ? onAt(f.id) : onMap(f.id));
  const Row = ({ f, note }: { f: FnNode; note?: string }) => (
    <button className="fn-link" onClick={() => go(f)} title={inQueue.has(f.id) ? 'Review this change' : 'Show on the map'}>
      <span className="fn-link-text">
        <span className="mono">{displayName(f)}</span>
        {f.purpose && <span className="fn-link-purpose">{f.purpose.what}</span>}
      </span>
      <span className="fn-link-meta">
        {note && <span className="badge badge-quiet">{note}</span>}
        {f.status !== 'unchanged' && <StatusBadge status={f.status} />}
      </span>
    </button>
  );
  return (
    <div className="queue-context-inner">
      {fn.purpose && (
        <div className="purpose-block">
          <div>
            <span className="purpose-label">What</span>
            {fn.purpose.what}
          </div>
          <div>
            <span className="purpose-label">Why</span>
            {fn.purpose.why}
          </div>
        </div>
      )}
      <ContextSection title="Called by" count={callers.length} extra={testCallers ? `+${testCallers} test${testCallers > 1 ? 's' : ''}` : undefined}>
        {callers.slice(0, 8).map((f) => (
          <Row key={f.id} f={f} note={f.status === 'unchanged' ? 'not in this change' : undefined} />
        ))}
        {callers.length === 0 && <p className="muted small">{fn.status === 'added' ? 'New: nothing outside this change calls it yet.' : 'No callers found.'}</p>}
      </ContextSection>
      <ContextSection title="Calls" count={callees.length}>
        {callees.slice(0, 8).map((f) => (
          <Row key={f.id} f={f} />
        ))}
      </ContextSection>
      {entries.length > 0 && (
        <ContextSection title="Reached from" count={entries.length}>
          {entries.slice(0, 6).map((f) => (
            <Row key={f.id} f={f} note={ENTRY_LABEL[f.entry!.kind]} />
          ))}
        </ContextSection>
      )}
      {fn.effects.length > 0 && (
        <ContextSection title="Touches" count={fn.effects.length}>
          <div className="guide-chips">
            {fn.effects.map((id) => (
              <span key={id} className="guide-chip">
                {ix.sinks.get(id)?.label ?? id}
              </span>
            ))}
          </div>
        </ContextSection>
      )}
      <button className="btn btn-small" onClick={() => onMap(fn.id)}>
        See it on the map <kbd>z</kbd>
      </button>
    </div>
  );
}

function ContextSection({ title, count, extra, children }: { title: string; count: number; extra?: string; children: ReactNode }) {
  return (
    <section className="queue-context-section">
      <div className="queue-section-label">
        {title} <span className="count">{count}</span> {extra && <span className="muted">{extra}</span>}
      </div>
      {children}
    </section>
  );
}

/** Non-test entry points (routes, CLIs, jobs…) whose calls reach this function. */
function entriesReaching(ix: Index, id: string): FnNode[] {
  const seen = new Set([id]);
  const stack = [id];
  const out: FnNode[] = [];
  while (stack.length) {
    for (const e of ix.callers.get(stack.pop()!) ?? []) {
      if (seen.has(e.source)) continue;
      seen.add(e.source);
      stack.push(e.source);
      const f = ix.fns.get(e.source);
      if (f?.entry && f.entry.kind !== 'test') out.push(f);
    }
  }
  return out;
}
