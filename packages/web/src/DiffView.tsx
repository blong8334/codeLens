import { useEffect, useRef } from 'react';
import { riskLevel, type Index, type Selection } from './data.ts';
import { RiskBar, StatusBadge } from './nodes.tsx';
import { Prose } from './Panel.tsx';

/** Render a hunk-only unified diff with old/new line numbers offset to the function's position. */
export function DiffBlock({ diff, startLine }: { diff: string; startLine: number }) {
  let oldNo = 0;
  let newNo = 0;
  const rows = diff.split('\n').map((line, i) => {
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)/);
    if (hunk) {
      oldNo = Number(hunk[1]) + startLine - 1;
      newNo = Number(hunk[2]) + startLine - 1;
      return (
        <tr key={i} className="diff-hunk">
          <td colSpan={3}>{line}</td>
        </tr>
      );
    }
    if (line.startsWith('\\')) return null;
    const kind = line[0] === '+' ? 'add' : line[0] === '-' ? 'del' : 'ctx';
    const row = (
      <tr key={i} className={`diff-${kind}`}>
        <td className="ln">{kind !== 'add' ? oldNo : ''}</td>
        <td className="ln">{kind !== 'del' ? newNo : ''}</td>
        <td className="code">
          <span className="sign">{kind === 'add' ? '+' : kind === 'del' ? '−' : ' '}</span>
          {line.slice(1)}
        </td>
      </tr>
    );
    if (kind !== 'add') oldNo++;
    if (kind !== 'del') newNo++;
    return row;
  });
  return (
    <div className="diff-scroll">
      <table className="diff mono">
        <tbody>{rows}</tbody>
      </table>
    </div>
  );
}

/** Layer 4: every changed function's diff, highest blast radius first. */
export function DiffView({ ix, focusFn, selection, onSelect }: { ix: Index; focusFn?: string; selection: Selection; onSelect: (s: Selection) => void }) {
  const changed = ix.graph.nodes
    .filter((n) => n.diff)
    .sort((a, b) => (ix.reviewRank.get(a.id) ?? 999) - (ix.reviewRank.get(b.id) ?? 999));
  const refs = useRef(new Map<string, HTMLElement>());

  useEffect(() => {
    const target = focusFn ?? (selection?.kind === 'fn' ? selection.id : undefined);
    if (target) refs.current.get(target)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [focusFn, selection]);

  return (
    <div className="diff-view">
      {changed.map((fn, i) => {
        const e = fn.enrichment;
        const active = (selection?.kind === 'fn' && selection.id === fn.id) || focusFn === fn.id;
        return (
          <article
            key={fn.id}
            ref={(el) => {
              if (el) refs.current.set(fn.id, el);
            }}
            className={`diff-card ${active ? 'is-selected' : ''} ${e ? `risk-edge-${riskLevel(e.blastRadius)}` : ''}`}
          >
            <header className="diff-card-head" onClick={() => onSelect({ kind: 'fn', id: fn.id })}>
              <span className="review-num">{i + 1}</span>
              <div className="diff-card-title">
                <span className="mono">{fn.qualifiedName}</span>
                <span className="card-path">
                  {fn.file}:{fn.range.startLine}
                </span>
              </div>
              <StatusBadge status={fn.status} />
              {e && <RiskBar value={e.blastRadius} />}
            </header>
            {e && (
              <p className="diff-summary">
                <Prose text={e.summary} />
              </p>
            )}
            <DiffBlock diff={fn.diff!} startLine={fn.range.startLine} />
          </article>
        );
      })}
    </div>
  );
}
