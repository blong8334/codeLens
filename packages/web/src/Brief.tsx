import type { ReactNode } from 'react';
import { displayName, isDone, riskLevel, type FnNode, type Index } from './data.ts';
import { Markdown, ReviewBox, ReviewsSummary } from './Discussion.tsx';
import { FilesChecklist } from './Marks.tsx';
import { NavButtons, Prose, type NavControls } from './Panel.tsx';
import type { ReviewBrief } from '../../cli/src/types.ts';

interface Props {
  nav?: NavControls;
  onOpenDiff?: (path: string) => void;
  ix: Index;
  /** Open the map centered on a function. */
  onStart: (fnId: string) => void;
  onMap: () => void;
}

/** A code review's landing page: what the change is, what could go wrong, where to start. */
export function Brief({ ix, onStart, onMap, nav, onOpenDiff }: Props) {
  const { graph } = ix;
  const pr = graph.meta.pr;
  const brief = graph.enrichment?.brief ?? fallbackBrief(ix);
  const risk = graph.enrichment?.overallRisk;
  const changed = graph.nodes.filter((n) => n.status !== 'unchanged');
  const breaking = changed.filter((n) => n.enrichment?.contract.breaking).length;
  const atRisk = changed.reduce((n, f) => n + (f.enrichment?.invariants.filter((i) => i.status !== 'preserved').length ?? 0), 0);
  const order = brief.readingOrder.map((r) => ({ ...r, fn: ix.fns.get(r.id) })).filter((r): r is typeof r & { fn: FnNode } => !!r.fn);
  const fnChip = (id: string) => {
    const fn = ix.fns.get(id);
    return fn ? (
      <button key={id} className="brief-fn mono" onClick={() => onStart(id)} title="Open on the map">
        {displayName(fn)}
      </button>
    ) : null;
  };

  return (
    <div className="guide brief">
      <div className="guide-inner">
        <header className="guide-hero">
          <div className="brief-top">
            <div className="guide-kicker">Code review</div>
            <NavButtons nav={nav} />
          </div>
          {pr ? (
            <>
              <h1 className="brief-title">
                {pr.title} <span className="brief-number">#{pr.number}</span>
              </h1>
              <div className="guide-meta">
                <span className={`pr-state pr-${pr.state}`}>{pr.state}</span>
                <span>
                  <b>{pr.author}</b> → <code>{pr.baseRef}</code> from <code>{pr.headRepo && pr.headRepo !== pr.repo ? `${pr.headRepo}:${pr.headRef}` : pr.headRef}</code>
                </span>
                {pr.changedFiles !== undefined && (
                  <span>
                    {pr.changedFiles} files · <span className="pr-add">+{pr.additions}</span> <span className="pr-del">−{pr.deletions}</span>
                  </span>
                )}
                <a href={pr.url} target="_blank" rel="noreferrer">
                  ↗ GitHub
                </a>
              </div>
            </>
          ) : (
            <h1 className="brief-title mono">
              {graph.meta.base} → {graph.meta.head === 'WORKING' ? 'working tree' : graph.meta.head}
            </h1>
          )}
          <div className="brief-facts">
            {risk !== undefined && (
              <span className={`brief-risk risk-${riskLevel(risk)}`}>
                {riskLevel(risk)} risk <b>{risk.toFixed(2)}</b>
              </span>
            )}
            <span>
              <b>{changed.length}</b> functions changed
            </span>
            <span>
              <b>{graph.meta.stats.impactedFunctions}</b> callers affected
            </span>
            {breaking > 0 && (
              <span className="brief-bad">
                <b>{breaking}</b> breaking
              </span>
            )}
            {atRisk > 0 && (
              <span className="brief-warn">
                <b>{atRisk}</b> invariants at risk
              </span>
            )}
            {graph.sinks.length > 0 && <span>touches {graph.sinks.map((s) => s.label.toLowerCase()).join(', ')}</span>}
          </div>
          <div className="guide-actions">
            {order[0] && (
              <button className="btn btn-primary" onClick={() => onStart(order[0].fn.id)}>
                Start review with {displayName(order[0].fn)} →
              </button>
            )}
            <button className="btn" onClick={onMap}>
              Open the map
            </button>
          </div>
        </header>

        <div className="guide-columns">
          {pr && (
            <Section title="The author's description">
              <div className="brief-description">{pr.body.trim() ? <Markdown text={pr.body} /> : <p className="muted">No description.</p>}</div>
            </Section>
          )}
          <Section title="What this change does" hint={brief.source === 'llm' ? 'Written by the model from the description and the diffs' : 'Assembled from the analysis · run with -p claude-code for a written brief'}>
            <p className="guide-summary brief-overview">
              <Prose text={brief.overview} />
            </p>
            <ul className="guide-arch">
              {brief.approach.map((a, i) => (
                <li key={i}>
                  <Prose text={a} />
                </li>
              ))}
            </ul>
          </Section>
        </div>

        <div className="guide-columns">
          <Section title="Risks" hint={brief.risks.length ? undefined : 'Nothing stood out.'}>
            {brief.risks.map((r, i) => (
              <div key={i} className="brief-risk-card">
                <div className="brief-risk-title">
                  <Prose text={r.title} />
                </div>
                <div className="brief-risk-detail">
                  <Prose text={r.detail} />
                </div>
                {r.fnIds.length > 0 && <div className="brief-fns">{r.fnIds.map(fnChip)}</div>}
              </div>
            ))}
          </Section>
          <Section title="Things to watch">
            <ul className="brief-watch">
              {brief.watch.map((w, i) => (
                <li key={i}>
                  <Prose text={w} />
                </li>
              ))}
            </ul>
            {brief.testing && (
              <p className="brief-testing">
                <span className="purpose-label">Testing</span>{' '}
                <span>
                  <Prose text={brief.testing} />
                </span>
              </p>
            )}
          </Section>
        </div>

        {graph.review && graph.review.files.length > 0 && (
          <Section title="Files" hint="Check off what you're good with, smallest first. Reviewed files fade on the map and drop out of the step-through; a later push that changes one clears its check.">
            <FilesChecklist
              onDiff={onOpenDiff}
              onOpen={(path) => {
                const first = ix.reviewOrder.find((id) => ix.fns.get(id)?.file === path);
                if (first) onStart(first);
              }}
            />
          </Section>
        )}

        <div className="guide-columns">
          <Section title="Reading order" hint="Each opens the map centered on that change.">
            <ol className="guide-start">
              {order.map((s, i) => (
                <li key={s.id} className={isDone(ix, s.fn) ? 'is-done' : ''}>
                  <button className="guide-start-item" onClick={() => onStart(s.id)}>
                    <span className="guide-step">{i + 1}</span>
                    <span className="guide-start-text">
                      <span className="guide-start-name mono">
                        {displayName(s.fn)} <span className={`badge status-${s.fn.status}`}>{s.fn.status}</span>
                      </span>
                      <span className="guide-start-file mono">{s.fn.file}</span>
                      <span className="guide-start-reason">
                        <Prose text={s.reason} />
                      </span>
                    </span>
                    <span className="guide-go">→</span>
                  </button>
                </li>
              ))}
            </ol>
          </Section>
          {pr && (
            <Section title="Reviews">
              <ReviewsSummary />
              <ReviewBox />
            </Section>
          )}
        </div>
      </div>
    </div>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="guide-section">
      <h2>{title}</h2>
      {hint && <p className="guide-hint">{hint}</p>}
      {children}
    </section>
  );
}

/** Graphs made before briefs existed (or without enrichment): what the graph already says. */
function fallbackBrief(ix: Index): ReviewBrief {
  const order = ix.reviewOrder.slice(0, 5);
  return {
    overview: ix.graph.enrichment?.summary ?? `${ix.reviewOrder.length} functions changed.`,
    approach: [],
    risks: ix.graph.nodes
      .filter((n) => n.enrichment?.contract.breaking)
      .map((n) => ({ title: `Breaking change to \`${n.qualifiedName}\``, detail: n.enrichment!.contract.description, fnIds: [n.id] })),
    watch: [],
    readingOrder: order.map((id) => ({ id, reason: ix.fns.get(id)?.enrichment?.reasons[0] ?? '' })),
    testing: '',
    source: 'heuristic',
  };
}
