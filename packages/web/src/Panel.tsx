import { useState, type ReactNode } from 'react';
import { displayName, ENTRY_LABEL, inlineCode, isChanged, type FnNode, type Group, type Index, type Layer, type Selection } from './data.ts';
import { EntryBadge, RiskBar, SinceBadge, StatusBadge } from './nodes.tsx';
import { DiffBlock } from './DiffView.tsx';
import { codeLinks } from './links.ts';
import { AcceptButton, MarkBox } from './Marks.tsx';
import { FunctionDiscussion, OtherDiscussion, ReviewBox, ReviewsSummary, useDiscussion } from './Discussion.tsx';

interface Props {
  ix: Index;
  selection: Selection;
  focus: string;
  expandedGroups: Set<string>;
  onSelect: (s: Selection) => void;
  onFocus: (fnId: string) => void;
  onToggleGroup: (groupId: string) => void;
  onLayer: (layer: Layer, fnId?: string) => void;
  /** Open the full-screen diff of a file (optionally at a function). */
  onOpenDiff?: (path: string, fnId?: string) => void;
  /** Open the review queue at a changed function. */
  onReview?: (fnId: string) => void;
  nav?: NavControls;
}

export interface NavControls {
  back: () => void;
  forward: () => void;
  canBack: boolean;
  canForward: boolean;
}

/** Back / forward, where the reader's eyes and pointer already are. */
export function NavButtons({ nav }: { nav?: NavControls }) {
  if (!nav) return null;
  return (
    <div className="panel-nav">
      <button className="icon-btn nav-btn" onClick={nav.back} disabled={!nav.canBack} title="Back (Backspace)" aria-label="Back">
        ← Back
      </button>
      <button className="icon-btn nav-btn" onClick={nav.forward} disabled={!nav.canForward} title="Forward" aria-label="Forward">
        →
      </button>
    </div>
  );
}

export function Prose({ text }: { text: string }) {
  return (
    <>
      {inlineCode(text).map((p, i) => (typeof p === 'string' ? p : <code key={i}>{p.code}</code>))}
    </>
  );
}

function Section({ title, count, defaultOpen = true, children }: { title: string; count?: number; defaultOpen?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className={`panel-section ${open ? 'open' : ''}`}>
      <button className="section-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="chev">{open ? '▾' : '▸'}</span>
        {title}
        {count !== undefined && <span className="count">{count}</span>}
      </button>
      {open && <div className="section-body">{children}</div>}
    </section>
  );
}

export function Panel(props: Props) {
  return (
    <>
      <NavButtons nav={props.nav} />
      <PanelBody {...props} />
    </>
  );
}

function PanelBody(props: Props) {
  const { ix, selection } = props;
  if (!selection) return ix.explore ? <ExplorePanel {...props} /> : <OverviewPanel {...props} />;
  if (selection.kind === 'group') return <GroupPanel {...props} group={ix.groups.get(selection.id)!} />;
  if (selection.kind === 'sink') return <SinkPanel {...props} id={selection.id} />;
  if (selection.kind === 'invariant') return <InvariantPanel {...props} fnId={selection.fnId} index={selection.index} />;
  const fn = ix.fns.get(selection.id);
  return fn ? <FnPanel {...props} fn={fn} /> : ix.explore ? <ExplorePanel {...props} /> : <OverviewPanel {...props} />;
}

function FnLink({ fn, onSelect, note }: { fn: FnNode; onSelect: Props['onSelect']; note?: string }) {
  return (
    <button className="fn-link" onClick={() => onSelect({ kind: 'fn', id: fn.id })} title={fn.purpose?.what}>
      <span className="fn-link-text">
        <span className="mono">{displayName(fn)}</span>
        {fn.purpose && <span className="fn-link-purpose">{fn.purpose.what}</span>}
      </span>
      <span className="fn-link-meta">
        {note && <span className="badge badge-quiet">{note}</span>}
        <SinceBadge fn={fn} />
        <EntryBadge fn={fn} />
        {isChanged(fn) && <StatusBadge status={fn.status} />}
      </span>
    </button>
  );
}

const ago = (iso: string) => {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 90) return 'just now';
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
};

/** Explore mode with nothing selected: how the package is laid out and where to start reading. */
function ExplorePanel({ ix, onSelect, onFocus }: Props) {
  const { graph } = ix;
  const ex = graph.explore;
  const inside = (g: Group) => g.fnIds.some((id) => !ix.fns.get(id)?.outside);
  const systems = graph.groups.filter((g) => g.kind === 'system' && inside(g));
  const testShare = (g: Group) => g.fnIds.filter((id) => ix.fns.get(id)?.entry?.kind === 'test').length / Math.max(1, g.fnIds.length);
  const parts = (systems.length > 1 ? systems : graph.groups.filter((g) => g.kind === 'module' && inside(g))).sort(
    (a, b) => Number(testShare(a) > 0.5) - Number(testShare(b) > 0.5) || b.fnIds.length - a.fnIds.length,
  );
  const entries = (ex?.entries ?? []).map((id) => ix.fns.get(id)!).filter(Boolean);
  const byKind = new Map<string, FnNode[]>();
  for (const f of entries) (byKind.get(f.entry!.kind) ?? byKind.set(f.entry!.kind, []).get(f.entry!.kind)!).push(f);
  const fresh = graph.nodes.filter((n) => n.since);
  const name = graph.meta.scope || graph.meta.repo.split('/').pop();
  return (
    <div className="panel-inner">
      <div className="panel-kicker">Explore</div>
      <h2 className="panel-title mono">{name}</h2>
      <div className="panel-badges">
        <span className="badge badge-quiet">{graph.meta.stats.functions} functions</span>
        <span className="badge badge-quiet">{graph.meta.stats.filesParsed} files parsed</span>
        {ex?.snapshot.commit && (
          <span className="badge badge-quiet mono" title={ex.snapshot.commit}>
            {ex.snapshot.commit.slice(0, 7)}
            {ex.snapshot.dirty ? '+' : ''}
          </span>
        )}
      </div>
      {ex?.since && (
        <div className={`since-box ${ex.since.identical ? 'quiet' : ''}`}>
          <div className="since-head">
            Since your last look {ex.since.commit ? <span className="mono">({ex.since.commit.slice(0, 7)})</span> : null} · {ago(ex.since.at)}
          </div>
          {ex.since.identical ? (
            <div>Nothing changed in this package.</div>
          ) : (
            <div className="since-counts">
              <span className="chip chip-new">{ex.since.added} new</span>
              <span className="chip chip-changed">{ex.since.changed} changed</span>
              <span className="chip">{ex.since.removed} removed</span>
            </div>
          )}
        </div>
      )}
      {parts.length > 0 && (
        <Section title={systems.length > 1 ? 'Systems' : 'Modules'} count={parts.length}>
          {parts.map((g) => (
            <button key={g.id} className="fn-link" onClick={() => onSelect({ kind: 'group', id: g.id })}>
              <span className="fn-link-text">
                <span className="mono">{g.label}</span>
                {g.summary && <span className="fn-link-purpose">{g.summary}</span>}
              </span>
              <span className="badge badge-quiet">{g.fnIds.length}</span>
            </button>
          ))}
        </Section>
      )}
      {fresh.length > 0 && (
        <Section title="New or changed since last look" count={fresh.length} defaultOpen={fresh.length <= 12}>
          {fresh.slice(0, 60).map((f) => (
            <FnLink key={f.id} fn={f} onSelect={onSelect} />
          ))}
        </Section>
      )}
      <Section title="Start reading here" count={ix.tour.length}>
        <p className="muted small">Ways into the code. ← / → steps through them on the map.</p>
        {[...byKind]
          .filter(([k]) => k !== 'test' || byKind.size === 1)
          .map(([kind, fns]) => (
            <div key={kind} className="entry-group">
              <div className="entry-group-label">
                {ENTRY_LABEL[kind]} <span className="count">{fns.length}</span>
              </div>
              {fns.slice(0, 12).map((f) => (
                <button key={f.id} className="fn-link" onClick={() => onFocus(f.id)} title="Center the map here">
                  <span className="fn-link-text">
                    <span className="mono">{f.qualifiedName === '(top level)' ? f.file : displayName(f)}</span>
                    {f.purpose && <span className="fn-link-purpose">{f.purpose.what}</span>}
                  </span>
                </button>
              ))}
              {fns.length > 12 && <span className="muted small">+{fns.length - 12} more (use search)</span>}
            </div>
          ))}
      </Section>
      {(ex?.hotspots.length ?? 0) > 0 && (
        <Section title="Hotspots" count={ex!.hotspots.length}>
          <p className="muted small">The functions that hold it together: most called, most connected across modules.</p>
          {ex!.hotspots.slice(0, 15).map((h) => {
            const f = ix.fns.get(h.id);
            if (!f) return null;
            return (
              <button key={h.id} className="fn-link" onClick={() => onFocus(f.id)} title="Center the map here">
                <span className="fn-link-text">
                  <span className="mono">{displayName(f)}</span>
                  {f.purpose && <span className="fn-link-purpose">{f.purpose.what}</span>}
                </span>
                <span className="fn-link-meta">
                  <span className="badge badge-quiet" title="callers / callees">
                    {h.fanIn}↘ {h.fanOut}↗
                  </span>
                </span>
              </button>
            );
          })}
        </Section>
      )}
      {graph.sinks.length > 0 && (
        <Section title="Talks to" count={graph.sinks.length} defaultOpen={false}>
          {graph.sinks.map((sk) => (
            <button key={sk.id} className="fn-link" onClick={() => onSelect({ kind: 'sink', id: sk.id })}>
              <span className="fn-link-text">
                <span>{sk.label}</span>
                <span className="fn-link-purpose mono">{sk.examples.slice(0, 3).join(' · ')}</span>
              </span>
            </button>
          ))}
        </Section>
      )}
      <p className="hint">
        <kbd>/</kbd> search · <kbd>o</kbd> overview · double-click a group to open it, a function to center on it · <kbd>−</kbd>/<kbd>+</kbd> zoom out/in ·{' '}
        <kbd>←</kbd>/<kbd>→</kbd> entry points
      </p>
    </div>
  );
}

/** "View on GitHub" / "Open in VS Code" for a function's lines or a whole file. */
function CodeLinksRow({ ix, file, fn }: { ix: Index; file: string; fn?: FnNode }) {
  const whole = !fn || fn.qualifiedName === '(top level)';
  const links = codeLinks(ix.graph, file, whole ? undefined : fn!.range);
  const dirty = ix.graph.explore?.snapshot.dirty;
  return (
    <div className="code-links">
      {links.web && (
        <a className="btn btn-small" href={links.web} target="_blank" rel="noreferrer" title={dirty ? 'At the last commit; uncommitted edits may shift lines' : undefined}>
          ↗ {links.webLabel}
        </a>
      )}
      <a className="btn btn-small" href={links.editor} title={`${ix.graph.meta.repo}/${file}`}>
        Open in VS Code
      </a>
    </div>
  );
}

/** A function's source with its real line numbers. */
function SourceBlock({ fn }: { fn: FnNode }) {
  const top = fn.qualifiedName === '(top level)';
  const lines = fn.source.split('\n');
  return (
    <div className="diff-scroll source-scroll">
      <table className="diff mono">
        <tbody>
          {lines.map((line, i) => (
            <tr key={i} className="diff-ctx">
              {!top && <td className="ln">{fn.range.startLine + i}</td>}
              <td className="code">{line || ' '}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PurposeBlock({ fn }: { fn: FnNode }) {
  if (!fn.purpose) return null;
  const src = fn.purpose.source === 'llm' ? 'AI summary' : fn.purpose.source === 'doc' ? 'from doc comment' : 'inferred from code';
  return (
    <div className="purpose-block">
      <div>
        <span className="purpose-label">What</span>
        {fn.purpose.what}
      </div>
      <div>
        <span className="purpose-label">Why</span>
        {fn.purpose.why}
      </div>
      <div className="purpose-src">{src}</div>
    </div>
  );
}

function PullRequestCard({ ix }: { ix: Index }) {
  const pr = ix.graph.meta.pr;
  const [open, setOpen] = useState(false);
  if (!pr) return null;
  const body = pr.body.trim();
  return (
    <div className="pr-card">
      <div className="pr-card-head">
        <span className={`pr-state pr-${pr.state}`}>{pr.state}</span>
        <span className="muted small">
          {pr.repo} #{pr.number}
        </span>
      </div>
      <h2 className="panel-title">{pr.title}</h2>
      <div className="pr-card-meta">
        <span>
          <b>{pr.author}</b> wants to merge <code>{pr.headRepo && pr.headRepo !== pr.repo ? `${pr.headRepo}:${pr.headRef}` : pr.headRef}</code> into <code>{pr.baseRef}</code>
        </span>
        {pr.changedFiles !== undefined && (
          <span>
            {pr.changedFiles} file{pr.changedFiles === 1 ? '' : 's'} · <span className="pr-add">+{pr.additions}</span> <span className="pr-del">−{pr.deletions}</span>
          </span>
        )}
      </div>
      {body && (
        <div className={`pr-body ${open ? 'open' : ''}`}>
          <div className="pr-body-text">{body}</div>
          {body.length > 280 && (
            <button className="link" onClick={() => setOpen(!open)}>
              {open ? 'Show less' : 'Show the whole description'}
            </button>
          )}
        </div>
      )}
      <div className="code-links">
        <a className="btn btn-small" href={pr.url} target="_blank" rel="noreferrer">
          ↗ Open on GitHub
        </a>
        <a className="btn btn-small" href={`${pr.url}/files`} target="_blank" rel="noreferrer">
          Files changed
        </a>
      </div>
      <ReviewsSummary />
      <ReviewBox />
      <PrConversation ix={ix} />
    </div>
  );
}

function PrConversation({ ix }: { ix: Index }) {
  const { discussion } = useDiscussion();
  if (!discussion) return null;
  const placed = new Set(discussion.threads.filter((t) => t.fnId && ix.fns.has(t.fnId)).map((t) => t.id));
  const others = discussion.conversation.length + discussion.threads.length - placed.size;
  return (
    <>
      {placed.size > 0 && (
        <p className="muted small">
          {placed.size} review thread{placed.size > 1 ? 's are' : ' is'} on functions in the map (💬 on the cards).
        </p>
      )}
      {others > 0 && (
        <Section title="Conversation" count={others} defaultOpen={false}>
          <OtherDiscussion placed={placed} />
        </Section>
      )}
    </>
  );
}

function OverviewPanel({ ix, focus, onFocus }: Props) {
  const order = ix.reviewOrder.map((id) => ix.fns.get(id)!).filter(Boolean);
  return (
    <div className="panel-inner">
      <PullRequestCard ix={ix} />
      <div className="panel-kicker">{ix.graph.meta.pr ? 'CodeLens review' : 'Review overview'}</div>
      {ix.graph.enrichment ? (
        <p className="summary">
          <Prose text={ix.graph.enrichment.summary} />
        </p>
      ) : (
        <p className="summary muted">
          This graph has not been enriched yet. Run <code>codelens enrich</code> to add contracts, invariants, and summaries.
        </p>
      )}
      <Section title="Changes, in review order" count={order.length}>
        <ol className="review-order">
          {order.map((fn) => (
            <li key={fn.id}>
              <button className={`fn-link ${fn.id === focus ? 'is-current' : ''}`} onClick={() => onFocus(fn.id)} title="Center the map on this change">
                <span className="fn-link-text">
                  <span className="mono">{displayName(fn)}</span>
                  {fn.purpose && <span className="fn-link-purpose">{fn.purpose.what}</span>}
                </span>
                {fn.enrichment && <RiskBar value={fn.enrichment.blastRadius} />}
              </button>
            </li>
          ))}
        </ol>
      </Section>
      <p className="hint">
        Click a card for details · double-click a function to center on it · double-click a group to open it · <kbd>−</kbd>/<kbd>+</kbd> zoom out/in ·{' '}
        <kbd>←</kbd>/<kbd>→</kbd> previous/next change
      </p>
    </div>
  );
}

function FnPanel(props: Props & { fn: FnNode }) {
  const { ix, fn, focus, onSelect, onFocus, onLayer } = props;
  const e = fn.enrichment;
  const callers = (ix.callers.get(fn.id) ?? []).map((c) => ({ edge: c, fn: ix.fns.get(c.source)! }));
  const callees = (ix.callees.get(fn.id) ?? []).map((c) => ({ edge: c, fn: ix.fns.get(c.target)! }));
  const system = ix.groups.get(fn.groups.system);
  return (
    <div className="panel-inner" key={fn.id}>
      <div className="panel-kicker">
        {fn.kind} ·{' '}
        <button className="link" onClick={() => onSelect({ kind: 'group', id: fn.groups.file })}>
          {fn.file}
        </button>
        :{fn.range.startLine}
        {system && (
          <>
            {' · '}
            <button className="link" onClick={() => onSelect({ kind: 'group', id: system.id })}>
              {system.label}
            </button>
          </>
        )}
      </div>
      <h2 className="panel-title mono">{displayName(fn)}</h2>
      <div className="panel-badges">
        {!ix.explore && <StatusBadge status={fn.status} />}
        <SinceBadge fn={fn} />
        <EntryBadge fn={fn} />
        {fn.exported && <span className="badge badge-quiet">exported</span>}
        {e?.contract.breaking && <span className="badge status-deleted">breaking</span>}
      </div>
      <PurposeBlock fn={fn} />
      {(ix.graph.review?.files.some((f) => f.path === fn.file) || fn.diff) && props.onOpenDiff && (
        <div className="diff-launch">
          {props.onReview && fn.status !== 'unchanged' && (
            <button className="btn btn-primary" onClick={() => props.onReview!(fn.id)} title="Open this change in the review queue (r)">
              Review this change
            </button>
          )}
          <AcceptButton fnId={fn.id} />
          <button className="btn" onClick={() => props.onOpenDiff!(fn.file, fn.id)} title="Full-screen diff of this file (d)">
            ⤢ Expand diff
          </button>
        </div>
      )}
      <CodeLinksRow ix={ix} file={fn.file} fn={fn} />
      {fn.id !== focus && (
        <div className="drill-row drill-row-top">
          <button className="btn btn-primary" onClick={() => onFocus(fn.id)}>
            ◎ Center map here
          </button>
        </div>
      )}

      {ix.graph.meta.pr && (
        <Section title="Review discussion" count={ix.threadsByFn.get(fn.id)?.length ?? 0} defaultOpen>
          <FunctionDiscussion fn={fn} threads={ix.threadsByFn.get(fn.id) ?? []} />
        </Section>
      )}
      {e && (
        <>
          <Section title="This change">
            <p>
              <Prose text={e.summary} />
            </p>
            <RiskBar value={e.blastRadius} />
            <ul className="reasons">
              {e.reasons.map((r, i) => (
                <li key={i}>
                  <Prose text={r} />
                </li>
              ))}
            </ul>
          </Section>
          <Section title="Contract">
            <p>
              <Prose text={e.contract.description} />
            </p>
            {e.contract.before && e.contract.after && e.contract.before !== e.contract.after && (
              <div className="sig mono sig-large">
                <div className="sig-before">{e.contract.before}</div>
                <div className="sig-after">{e.contract.after}</div>
              </div>
            )}
          </Section>
          <Section title="Invariants" count={e.invariants.length}>
            {e.invariants.length === 0 && <p className="muted">No invariants detected for this change.</p>}
            {e.invariants.map((inv, i) => (
              <button key={i} className={`inv-row inv-${inv.status}`} onClick={() => onSelect({ kind: 'invariant', fnId: fn.id, index: i })}>
                <span className={`badge inv-badge-${inv.status}`}>{inv.status}</span>
                <span>{inv.statement}</span>
              </button>
            ))}
          </Section>
        </>
      )}
      {!e && ix.explore && (
        <p className="muted small">
          {fn.outside ? 'Outside the explored package · ' : ''}
          {callers.length} caller{callers.length === 1 ? '' : 's'} · {callees.length} callee{callees.length === 1 ? '' : 's'}
          {ix.hotspots.get(fn.id) ? ` · reached from ${ix.hotspots.get(fn.id)!.reach} functions` : ''}
          {fn.since ? ` · ${fn.since} since your last look` : ''}
        </p>
      )}
      {!e && !ix.explore && (
        <p className="muted small">
          {fn.depth ? `Unchanged · ${fn.depth} hop${fn.depth > 1 ? 's' : ''} upstream of a change.` : fn.downDepth ? `Unchanged · ${fn.downDepth} hop${fn.downDepth > 1 ? 's' : ''} downstream of a change.` : 'Unchanged.'}
        </p>
      )}
      <Section title={fn.qualifiedName === '(top level)' ? 'Source (top-level statements)' : `Source · lines ${fn.range.startLine}–${fn.range.endLine}`}>
        {fn.source ? <SourceBlock fn={fn} /> : <p className="muted small">This graph was saved without source code (<code>--no-source</code>). Use the links above to read it.</p>}
      </Section>
      {fn.effects.length > 0 && (
        <Section title="External effects" count={fn.effects.length}>
          {fn.effects.map((id) => (
            <button key={id} className="fn-link" onClick={() => onSelect({ kind: 'sink', id })}>
              <span>{ix.sinks.get(id)?.label ?? id}</span>
            </button>
          ))}
        </Section>
      )}

      <Section title="Callers (upstream)" count={callers.length} defaultOpen={callers.length > 0 && callers.length <= 8}>
        {callers.map(({ edge, fn: c }) => (
          <FnLink key={edge.id} fn={c} onSelect={onSelect} note={edge.dangling ? 'dangling' : edge.confidence === 'low' ? 'inferred' : undefined} />
        ))}
      </Section>
      <Section title="Callees (downstream)" count={callees.length} defaultOpen={false}>
        {callees.map(({ edge, fn: c }) => (
          <FnLink key={edge.id} fn={c} onSelect={onSelect} note={edge.confidence === 'low' ? 'inferred' : undefined} />
        ))}
      </Section>
      {fn.diff && (
        <Section title="Diff" defaultOpen={false}>
          <DiffBlock diff={fn.diff} startLine={fn.range.startLine} />
        </Section>
      )}
      <div className="drill-row">
        {e && e.invariants.length > 0 && (
          <button className="btn" onClick={() => onLayer(2, fn.id)}>
            Invariants
          </button>
        )}
        {fn.diff && (
          <button className="btn" onClick={() => onLayer(3, fn.id)}>
            Diff →
          </button>
        )}
      </div>
    </div>
  );
}

function GroupPanel(props: Props & { group: Group }) {
  const { ix, group: g, expandedGroups, onSelect, onFocus, onToggleGroup } = props;
  const fns = g.fnIds.map((id) => ix.fns.get(id)!).sort((a, b) => (ix.reviewRank.get(a.id) ?? 999) - (ix.reviewRank.get(b.id) ?? 999));
  const children = ix.childGroups.get(g.id) ?? [];
  const parent = g.parent ? ix.groups.get(g.parent) : undefined;
  const changed = fns.filter(isChanged);
  const risk = ix.groupRisk.get(g.id) ?? 0;
  const entries = fns.filter((f) => f.entry);
  const degree = (f: FnNode) => (ix.callers.get(f.id)?.length ?? 0) + (ix.callees.get(f.id)?.length ?? 0);
  const start = changed[0] ?? entries.find((f) => f.entry!.kind !== 'test') ?? [...fns].sort((a, b) => degree(b) - degree(a))[0];
  return (
    <div className="panel-inner" key={g.id}>
      <div className="panel-kicker">
        {g.kind}
        {parent && (
          <>
            {' in '}
            <button className="link" onClick={() => onSelect({ kind: 'group', id: parent.id })}>
              {parent.label}
            </button>
          </>
        )}
      </div>
      <h2 className="panel-title">{g.path ?? g.label}</h2>
      <div className="panel-badges">
        <span className="badge badge-quiet">{g.auto ? 'auto-detected' : 'from .codelens.json'}</span>
        <span className="badge badge-quiet">{fns.length} functions in view</span>
        {changed.length > 0 && <span className="badge status-modified">{changed.length} changed</span>}
      </div>
      {g.summary && <p className="summary">{g.summary}</p>}
      {g.kind === 'file' && g.path && <CodeLinksRow ix={ix} file={g.path} />}
      {g.kind === 'file' && g.path && props.onOpenDiff && ix.graph.review?.files.some((f) => f.path === g.path) && (
        <div className="diff-launch">
          <button className="btn btn-primary" onClick={() => props.onOpenDiff!(g.path!)}>
            ⤢ Expand diff
          </button>
          <MarkBox path={g.path} />
        </div>
      )}
      {changed.length > 0 && <RiskBar value={risk} />}
      <div className="drill-row drill-row-top">
        {g.kind !== 'file' || fns.length > 1 ? (
          <button className="btn" onClick={() => onToggleGroup(g.id)}>
            {expandedGroups.has(g.id) ? 'Collapse in map' : 'Open in map'}
          </button>
        ) : null}
        {start && (
          <button className="btn btn-primary" onClick={() => onFocus(start.id)}>
            ◎ Center on {start.name === '(top level)' ? start.file.split('/').pop() : start.name}
          </button>
        )}
      </div>
      {children.length > 0 && (
        <Section title={g.kind === 'system' ? 'Modules' : 'Files'} count={children.length}>
          {children.map((c) => (
            <button key={c.id} className="fn-link" onClick={() => onSelect({ kind: 'group', id: c.id })}>
              <span className="fn-link-text">
                <span className="mono">{c.label}</span>
                {c.summary && <span className="fn-link-purpose">{c.summary}</span>}
              </span>
              {c.changed > 0 && <span className="badge status-modified">{c.changed}</span>}
            </button>
          ))}
        </Section>
      )}
      {entries.length > 0 && (
        <Section title="Entry points" count={entries.length} defaultOpen={false}>
          {entries.map((f) => (
            <FnLink key={f.id} fn={f} onSelect={onSelect} note={ENTRY_LABEL[f.entry!.kind]} />
          ))}
        </Section>
      )}
      <Section title="Functions" count={fns.length} defaultOpen={g.kind === 'file'}>
        {fns.map((f) => (
          <FnLink key={f.id} fn={f} onSelect={onSelect} />
        ))}
      </Section>
    </div>
  );
}

function SinkPanel({ ix, id, onSelect }: Props & { id: string }) {
  const sink = ix.sinks.get(id);
  if (!sink) return null;
  const users = ix.graph.nodes.filter((n) => n.effects.includes(id));
  return (
    <div className="panel-inner">
      <div className="panel-kicker">External effect</div>
      <h2 className="panel-title">{sink.label}</h2>
      <Section title="Example calls">
        <pre className="evidence mono">{sink.examples.join('\n')}</pre>
      </Section>
      <Section title="Performed by" count={users.length}>
        {users.map((f) => (
          <FnLink key={f.id} fn={f} onSelect={onSelect} />
        ))}
      </Section>
      <p className="hint">Detected from unresolved calls to known clients and packages. Add your own in <code>.codelens.json</code> under <code>sinks</code>.</p>
    </div>
  );
}

function InvariantPanel({ ix, fnId, index, onSelect, onLayer }: Props & { fnId: string; index: number }) {
  const fn = ix.fns.get(fnId)!;
  const inv = fn.enrichment!.invariants[index];
  return (
    <div className="panel-inner">
      <div className="panel-kicker">Invariant</div>
      <h2 className="panel-title">{inv.statement}</h2>
      <div className="panel-badges">
        <span className={`badge inv-badge-${inv.status}`}>{inv.status}</span>
        <span className="badge badge-quiet">{inv.risk} risk</span>
      </div>
      {inv.evidence && (
        <Section title="Evidence">
          <pre className="evidence mono">{inv.evidence}</pre>
        </Section>
      )}
      <Section title="Owned by">
        <FnLink fn={fn} onSelect={onSelect} />
      </Section>
      <div className="drill-row">
        <button className="btn" onClick={() => onLayer(3, fn.id)}>
          View diff →
        </button>
      </div>
    </div>
  );
}
