import { useState, type ReactNode } from 'react';
import { ENTRY_LABEL, inlineCode, isChanged, type FnNode, type Group, type Index, type Layer, type Selection } from './data.ts';
import { EntryBadge, RiskBar, StatusBadge } from './nodes.tsx';
import { DiffBlock } from './DiffView.tsx';

interface Props {
  ix: Index;
  selection: Selection;
  focus: string;
  expandedGroups: Set<string>;
  onSelect: (s: Selection) => void;
  onFocus: (fnId: string) => void;
  onToggleGroup: (groupId: string) => void;
  onLayer: (layer: Layer, fnId?: string) => void;
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
  const { ix, selection } = props;
  if (!selection) return <OverviewPanel {...props} />;
  if (selection.kind === 'group') return <GroupPanel {...props} group={ix.groups.get(selection.id)!} />;
  if (selection.kind === 'sink') return <SinkPanel {...props} id={selection.id} />;
  if (selection.kind === 'invariant') return <InvariantPanel {...props} fnId={selection.fnId} index={selection.index} />;
  const fn = ix.fns.get(selection.id);
  return fn ? <FnPanel {...props} fn={fn} /> : <OverviewPanel {...props} />;
}

function FnLink({ fn, onSelect, note }: { fn: FnNode; onSelect: Props['onSelect']; note?: string }) {
  return (
    <button className="fn-link" onClick={() => onSelect({ kind: 'fn', id: fn.id })} title={fn.purpose?.what}>
      <span className="fn-link-text">
        <span className="mono">{fn.qualifiedName}</span>
        {fn.purpose && <span className="fn-link-purpose">{fn.purpose.what}</span>}
      </span>
      <span className="fn-link-meta">
        {note && <span className="badge badge-quiet">{note}</span>}
        <EntryBadge fn={fn} />
        {isChanged(fn) && <StatusBadge status={fn.status} />}
      </span>
    </button>
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

function OverviewPanel({ ix, focus, onFocus }: Props) {
  const order = ix.reviewOrder.map((id) => ix.fns.get(id)!).filter(Boolean);
  return (
    <div className="panel-inner">
      <div className="panel-kicker">Review overview</div>
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
                  <span className="mono">{fn.qualifiedName}</span>
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

function FnPanel({ ix, fn, focus, onSelect, onFocus, onLayer }: Props & { fn: FnNode }) {
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
      <h2 className="panel-title mono">{fn.qualifiedName}</h2>
      <div className="panel-badges">
        <StatusBadge status={fn.status} />
        <EntryBadge fn={fn} />
        {fn.exported && <span className="badge badge-quiet">exported</span>}
        {e?.contract.breaking && <span className="badge status-deleted">breaking</span>}
      </div>
      <PurposeBlock fn={fn} />
      {fn.id !== focus && (
        <div className="drill-row drill-row-top">
          <button className="btn btn-primary" onClick={() => onFocus(fn.id)}>
            ◎ Center map here
          </button>
        </div>
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
      {!e && (
        <p className="muted small">
          {fn.depth ? `Unchanged · ${fn.depth} hop${fn.depth > 1 ? 's' : ''} upstream of a change.` : fn.downDepth ? `Unchanged · ${fn.downDepth} hop${fn.downDepth > 1 ? 's' : ''} downstream of a change.` : 'Unchanged.'}
        </p>
      )}
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

function GroupPanel({ ix, group: g, expandedGroups, onSelect, onFocus, onToggleGroup }: Props & { group: Group }) {
  const fns = g.fnIds.map((id) => ix.fns.get(id)!).sort((a, b) => (ix.reviewRank.get(a.id) ?? 999) - (ix.reviewRank.get(b.id) ?? 999));
  const children = ix.childGroups.get(g.id) ?? [];
  const parent = g.parent ? ix.groups.get(g.parent) : undefined;
  const changed = fns.filter(isChanged);
  const risk = ix.groupRisk.get(g.id) ?? 0;
  const entries = fns.filter((f) => f.entry);
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
      {changed.length > 0 && <RiskBar value={risk} />}
      <div className="drill-row drill-row-top">
        {g.kind !== 'file' || fns.length > 1 ? (
          <button className="btn" onClick={() => onToggleGroup(g.id)}>
            {expandedGroups.has(g.id) ? 'Collapse in map' : 'Open in map'}
          </button>
        ) : null}
        {changed[0] && (
          <button className="btn btn-primary" onClick={() => onFocus(changed[0].id)}>
            ◎ Center on {changed[0].name}
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
