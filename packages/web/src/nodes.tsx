import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { displayName, ENTRY_LABEL, isChanged, isDone, riskLevel, type FnNode, type Index, type Invariant } from './data.ts';
import type { MapItem } from './impact.ts';
import { codeLinks } from './links.ts';

export function RiskBar({ value, label = true }: { value: number; label?: boolean }) {
  return (
    <div className={`risk risk-${riskLevel(value)}`} title={`Blast radius ${value.toFixed(2)}`}>
      <div className="risk-track">
        <div className="risk-fill" style={{ width: `${Math.max(4, value * 100)}%` }} />
      </div>
      {label && <span className="risk-value">{value.toFixed(2)}</span>}
    </div>
  );
}

export function StatusBadge({ status }: { status: FnNode['status'] }) {
  return <span className={`badge status-${status}`}>{status}</span>;
}

/** 💬 count of pull request threads on a function (or inside a group). */
export function ThreadBadge({ ix, ids }: { ix: Index; ids: string[] }) {
  const n = ids.reduce((sum, id) => sum + (ix.threadsByFn.get(id)?.length ?? 0), 0);
  if (!n) return null;
  return (
    <span className="badge thread-badge" title={`${n} review thread${n > 1 ? 's' : ''}`}>
      💬 {n}
    </span>
  );
}

export function SinceBadge({ fn }: { fn: FnNode }) {
  if (!fn.since) return null;
  return (
    <span className={`badge since-${fn.since}`} title={`${fn.since === 'new' ? 'Added' : 'Changed'} since your last explore`}>
      {fn.since}
    </span>
  );
}

export function EntryBadge({ fn }: { fn: FnNode }) {
  if (!fn.entry) return null;
  return (
    <span className={`badge entry-badge entry-${fn.entry.kind}`} title={fn.entry.reason}>
      ⇥ {ENTRY_LABEL[fn.entry.kind]}
    </span>
  );
}

const handles = (
  <>
    <Handle type="target" position={Position.Left} />
    <Handle type="source" position={Position.Right} />
  </>
);

type MapData = { item: MapItem; ix: Index; selected: boolean; expanded: boolean };
type MapNode = Node<MapData>;

const riskEdge = (fn: FnNode) => (fn.enrichment ? `risk-edge-${riskLevel(fn.enrichment.blastRadius)}` : isChanged(fn) ? '' : 'risk-edge-none');

// ---- focus: the function everything is arranged around ----

export function FocusCard({ data }: NodeProps<MapNode>) {
  const fn = data.item.fn!;
  const e = fn.enrichment;
  const c = e?.contract;
  const showSig = c?.before && c.after && c.before !== c.after;
  return (
    <div className={`card focus-card ${riskEdge(fn)} ${data.selected ? 'is-selected' : ''} ${isDone(data.ix, fn) ? 'is-reviewed' : ''}`}>
      {handles}
      <div className="fn-head">
        <span className="card-title mono">{displayName(fn)}</span>
        <span className="fn-head-badges">
          <ThreadBadge ix={data.ix} ids={[fn.id]} />
          <SinceBadge fn={fn} />
          <EntryBadge fn={fn} />
          {(isChanged(fn) || !data.ix.explore) && <StatusBadge status={fn.status} />}
        </span>
      </div>
      {(() => {
        const link = codeLinks(data.ix.graph, fn.file, fn.qualifiedName === '(top level)' ? undefined : fn.range).web;
        const text = `${fn.file}:${fn.range.startLine}`;
        return link ? (
          <a className="card-path card-link nodrag" href={link} target="_blank" rel="noreferrer" title="Open the code" onClick={(e) => e.stopPropagation()}>
            {text} ↗
          </a>
        ) : (
          <div className="card-path">{text}</div>
        );
      })()}
      {fn.purpose && (
        <div className="purpose">
          <div className="purpose-what">{fn.purpose.what}</div>
          <div className="purpose-why">{fn.purpose.why}</div>
        </div>
      )}
      {c?.breaking && <div className="breaking">⚠ breaking: {c.kinds.join(', ')}</div>}
      {showSig && (
        <div className="sig mono">
          <div className="sig-before">{c!.before}</div>
          <div className="sig-after">{c!.after}</div>
        </div>
      )}
      {e && <RiskBar value={e.blastRadius} />}
    </div>
  );
}

// ---- a single function in a column ----

export function FnCard({ data }: NodeProps<Node<{ item?: MapItem; fn?: FnNode; ix?: Index; selected: boolean; dimmed?: boolean }>>) {
  const fn = data.item?.fn ?? data.fn!;
  const e = fn.enrichment;
  return (
    <div className={`card fn-card ${riskEdge(fn)} ${data.selected ? 'is-selected' : ''} ${data.dimmed ? 'is-dimmed' : ''} ${data.ix && isDone(data.ix, fn) ? 'is-reviewed' : ''}`}>
      {handles}
      <div className="fn-head">
        <span className="card-title mono" title={fn.qualifiedName}>
          {displayName(fn)}
        </span>
        <span className="fn-head-badges">
          {data.ix && <ThreadBadge ix={data.ix} ids={[fn.id]} />}
          <SinceBadge fn={fn} />
          <EntryBadge fn={fn} />
          {isChanged(fn) && <StatusBadge status={fn.status} />}
        </span>
      </div>
      <div className="card-path">{fn.file}</div>
      <div className="purpose-what clamp-2">{fn.purpose?.what ?? fn.signature.text}</div>
      {e ? (
        <RiskBar value={e.blastRadius} />
      ) : fn.effects.length > 0 ? (
        <div className="card-foot">
          <EffectsLine fn={fn} />
        </div>
      ) : null}
    </div>
  );
}

function EffectsLine({ fn }: { fn: FnNode }) {
  return <span className="effects">→ {fn.effects.map((s) => s.replace('sink:', '')).join(', ')}</span>;
}

// ---- a file / module / system standing in for several functions ----

export function GroupCard({ data }: NodeProps<Node<MapData & { dimmed?: boolean }>>) {
  const { item, ix, selected, expanded, dimmed } = data;
  const g = item.group!;
  const fns = item.fnIds.map((id) => ix.fns.get(id)!);
  const changed = fns.filter(isChanged).length;
  const entries = fns.filter((f) => f.entry && f.entry.kind !== 'test').length;
  const tests = fns.filter((f) => f.entry?.kind === 'test').length;
  const risk = Math.max(0, ...fns.map((f) => f.enrichment?.blastRadius ?? 0));
  const fresh = fns.filter((f) => f.since).length;
  return (
    <div className={`card group-card group-${g.kind} ${changed ? `risk-edge-${riskLevel(risk)}` : ''} ${selected ? 'is-selected' : ''} ${expanded ? 'is-expanded' : ''} ${dimmed ? 'is-dimmed' : ''} ${fns.length && fns.every((f) => ix.reviewed.has(f.file)) ? 'is-reviewed' : ''}`}>
      {handles}
      <div className="fn-head">
        <span className="card-title" title={g.path ?? g.label}>
          {g.label}
        </span>
        <span className="fn-head-badges">
          <ThreadBadge ix={ix} ids={item.fnIds} />
          <span className={`badge kind-badge`}>{g.kind}</span>
        </span>
      </div>
      <div className="group-meta">
        <span>
          {fns.length} fn{fns.length > 1 ? 's' : ''}
        </span>
        {changed > 0 && <span className="chip chip-changed">{changed} changed</span>}
        {fresh > 0 && <span className="chip chip-new" title="new or changed since your last explore">{fresh} new/changed</span>}
        {entries > 0 && <span className="chip chip-entry">{entries} entry</span>}
        {tests > 0 && <span className="chip">{tests} test{tests > 1 ? 's' : ''}</span>}
      </div>
      <div className="purpose-what clamp-2">{g.summary ?? ''}</div>
    </div>
  );
}

const PLURAL = { fn: 'functions', file: 'files', module: 'modules', system: 'systems' } as const;

export function BundleCard({ data }: NodeProps<MapNode>) {
  const { item, selected } = data;
  const hidden = item.hidden ?? [];
  const names = hidden.map((h) => (h.fn ? displayName(h.fn) : (h.group?.label ?? ''))).filter(Boolean);
  if (item.collapse) {
    return (
      <div className="card bundle-card collapse-card">
        {handles}
        <div className="card-title">− Show fewer</div>
        <div className="bundle-hint">click to collapse this column</div>
      </div>
    );
  }
  // Overview fold cards ("+N more files in src/lang") vs. capped impact-map columns.
  const fold = item.id.startsWith('rest|');
  const kinds = new Set(hidden.map((h) => (h.fn ? 'fn' : h.group!.kind)));
  const noun = kinds.size === 1 ? PLURAL[[...kinds][0] as keyof typeof PLURAL] : 'parts';
  return (
    <div className={`card bundle-card ${selected ? 'is-selected' : ''}`}>
      {handles}
      <div className="card-title">
        +{hidden.length} more {fold ? noun : ''}
      </div>
      {fold && <div className="card-path">{item.group ? `in ${item.group.label}` : 'elsewhere'}</div>}
      <div className="card-path clamp-2">{names.slice(0, 6).join(', ')}</div>
      <div className="bundle-hint">{fold ? 'double-click to show them' : 'click to expand column'}</div>
    </div>
  );
}

export function SinkCard({ data }: NodeProps<MapNode>) {
  const { item, selected } = data;
  const s = item.sink!;
  return (
    <div className={`card sink-card sink-${s.category} ${selected ? 'is-selected' : ''}`}>
      <Handle type="target" position={Position.Left} />
      <div className="fn-head">
        <span className="card-title">{s.label}</span>
        <span className="badge kind-badge">effect</span>
      </div>
      <div className="card-path clamp-2 mono">{s.examples.slice(0, 3).join(' · ')}</div>
      <div className="group-meta">
        <span>
          from {item.fnIds.length} function{item.fnIds.length > 1 ? 's' : ''}
        </span>
      </div>
    </div>
  );
}

export function ColumnHeader({ data }: NodeProps<Node<{ label: string; count: number; col: number; expanded?: boolean }>>) {
  return (
    <div className={`col-header ${data.col === 0 ? 'col-header-focus' : ''}`}>
      <span>{data.label}</span>
      {data.col !== 0 && data.count > 0 && <span className="count">{data.count}</span>}
      {data.expanded && <span className="col-collapse" title="Collapse this column">− Show fewer</span>}
    </div>
  );
}

// ---- invariants layer ----

export type InvariantFlowNode = Node<{ invariant: Invariant; selected: boolean }, 'invariant'>;

export function InvariantCard({ data }: NodeProps<InvariantFlowNode>) {
  const { invariant: inv, selected } = data;
  return (
    <div className={`card invariant-card inv-${inv.status} ${selected ? 'is-selected' : ''}`}>
      <Handle type="target" position={Position.Left} />
      <div className="inv-head">
        <span className={`badge inv-badge-${inv.status}`}>{inv.status}</span>
        <span className="badge badge-quiet">{inv.risk} risk</span>
      </div>
      <div className="inv-statement">{inv.statement}</div>
    </div>
  );
}

export const nodeTypes = {
  focus: FocusCard,
  fn: FnCard,
  // Not `group`: React Flow reserves that type name and styles it as a container.
  cluster: GroupCard,
  bundle: BundleCard,
  sink: SinkCard,
  header: ColumnHeader,
  invariant: InvariantCard,
};
