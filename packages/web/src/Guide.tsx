import type { ReactNode } from 'react';
import { displayName, ENTRY_LABEL, type FnNode, type Group, type Index } from './data.ts';
import { Prose } from './Panel.tsx';

const LANGUAGE_NAMES: Record<string, string> = {
  typescript: 'TypeScript', tsx: 'TSX', javascript: 'JavaScript', python: 'Python', java: 'Java', kotlin: 'Kotlin', scala: 'Scala',
  csharp: 'C#', go: 'Go', rust: 'Rust', c: 'C', cpp: 'C++', swift: 'Swift', ruby: 'Ruby', php: 'PHP',
};

interface Props {
  ix: Index;
  /** Open the map centered on a function. */
  onStart: (fnId: string) => void;
  /** Open the map's overview with a part selected. */
  onPart: (group: Group) => void;
  onMap: () => void;
}

/** Explore mode's landing page: what this is, how it is organized, and where to start reading. */
export function Guide({ ix, onStart, onPart, onMap }: Props) {
  const { graph } = ix;
  const ex = graph.explore;
  const inScope = graph.nodes.filter((n) => !n.outside);
  const guide = ex?.guide ?? fallbackGuide(ix);
  const start = guide.startHere.map((s) => ({ ...s, fn: ix.fns.get(s.id) })).filter((s): s is typeof s & { fn: FnNode } => !!s.fn);
  const name = graph.meta.scope ? `${graph.meta.repo.split('/').pop()}/${graph.meta.scope}` : graph.meta.repo.split('/').pop();
  const languages = [...new Set(inScope.map((n) => n.language))].map((l) => LANGUAGE_NAMES[l] ?? l);
  const remote = graph.meta.remote;
  const repoUrl = remote ? `${remote.web}/tree/${remote.commit}${graph.meta.scope ? `/${graph.meta.scope}` : ''}` : undefined;

  const inside = (g: Group) => g.fnIds.filter((id) => !ix.fns.get(id)?.outside);
  const testy = (g: Group) => inside(g).filter((id) => ix.fns.get(id)?.entry?.kind === 'test').length > inside(g).length / 2;
  const systems = graph.groups.filter((g) => g.kind === 'system' && inside(g).length);
  const at = (kind: Group['kind']) => graph.groups.filter((g) => g.kind === kind && inside(g).length);
  // The coarsest level with more than one part: systems, else modules, else files.
  const partKind = systems.length > 1 ? 'system' : at('module').length > 1 ? 'module' : 'file';
  const parts = at(partKind)
    .sort((a, b) => Number(testy(a)) - Number(testy(b)) || inside(b).length - inside(a).length);
  const hotspots = (ex?.hotspots ?? []).slice(0, 8).map((h) => ({ h, fn: ix.fns.get(h.id)! })).filter((x) => x.fn);
  const entries = (ex?.entries ?? []).map((id) => ix.fns.get(id)!).filter((f) => f && f.entry!.kind !== 'test');
  const entryKinds = [...new Set(entries.map((f) => f.entry!.kind))];

  return (
    <div className="guide">
      <div className="guide-inner">
        <header className="guide-hero">
          <div className="guide-kicker">Package guide</div>
          <h1 className="guide-title mono">{name}</h1>
          <div className="guide-meta">
            <span>{inScope.length} functions</span>
            <span>{new Set(inScope.map((n) => n.file)).size} files</span>
            {languages.length > 0 && <span>{languages.join(', ')}</span>}
            {ex?.snapshot.commit && (
              <span className="mono">
                {ex.snapshot.commit.slice(0, 7)}
                {ex.snapshot.dirty ? ' + uncommitted' : ''}
              </span>
            )}
            {repoUrl && (
              <a href={repoUrl} target="_blank" rel="noreferrer">
                ↗ {new URL(remote!.web).pathname.slice(1)}
              </a>
            )}
          </div>
          <p className="guide-summary">
            <Prose text={guide.summary} />
          </p>
          <div className="guide-source">
            {guide.source === 'llm' ? 'Written by Claude from the README and the code' : guide.source === 'readme' ? `From ${ex?.readme?.path ?? 'the README'}` : 'Assembled from the code'}
            {guide.source !== 'llm' && (
              <>
                {' · '}run <code>explore -p claude-code</code> for a written guide
              </>
            )}
          </div>
          {ex?.since && !ex.since.identical && (
            <div className="since-box">
              <div className="since-head">Since your last look{ex.since.commit ? ` (${ex.since.commit.slice(0, 7)})` : ''}</div>
              <div className="since-counts">
                <span className="chip chip-new">{ex.since.added} new</span>
                <span className="chip chip-changed">{ex.since.changed} changed</span>
                <span className="chip">{ex.since.removed} removed</span>
              </div>
            </div>
          )}
          <div className="guide-actions">
            {start[0] && (
              <button className="btn btn-primary" onClick={() => onStart(start[0].fn.id)}>
                Start with {shortName(start[0].fn)} →
              </button>
            )}
            <button className="btn" onClick={onMap}>
              Open the map
            </button>
          </div>
        </header>

        <div className="guide-columns">
          <GuideSection title="Start here" hint="A suggested reading order. Each opens the map centered on that function.">
            <ol className="guide-start">
              {start.map((s, i) => (
                <li key={s.id}>
                  <button className="guide-start-item" onClick={() => onStart(s.id)}>
                    <span className="guide-step">{i + 1}</span>
                    <span className="guide-start-text">
                      <span className="guide-start-name mono">{displayName(s.fn)}</span>
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
          </GuideSection>
          <GuideSection title="How it's organized">
            <ul className="guide-arch">
              {guide.architecture.map((a, i) => (
                <li key={i}>
                  <Prose text={a} />
                </li>
              ))}
            </ul>
          </GuideSection>
        </div>

        <GuideSection title={{ system: 'Systems', module: 'Modules', file: 'Files' }[partKind]} hint="Click one to see it on the map.">
          <div className="guide-parts">
            {parts.map((g) => (
              <button key={g.id} className={`guide-part ${testy(g) ? 'is-test' : ''}`} onClick={() => onPart(g)}>
                <span className="guide-part-head">
                  <span className="mono">{g.label}</span>
                  <span className="badge badge-quiet">{inside(g).length} fns</span>
                </span>
                <span className="guide-part-summary">{g.summary ?? ''}</span>
              </button>
            ))}
          </div>
        </GuideSection>

        <div className="guide-columns">
          {hotspots.length > 0 && (
            <GuideSection title="Key functions" hint="The most called and most connected.">
              {hotspots.map(({ h, fn }) => (
                <button key={h.id} className="guide-row" onClick={() => onStart(fn.id)}>
                  <span className="guide-row-text">
                    <span className="mono">{displayName(fn)}</span>
                    <span className="guide-row-sub">{fn.purpose?.what}</span>
                  </span>
                  <span className="badge badge-quiet" title="callers / callees">
                    {h.fanIn}↘ {h.fanOut}↗
                  </span>
                </button>
              ))}
            </GuideSection>
          )}
          <div className="guide-stack">
            {entries.length > 0 && (
              <GuideSection title="Ways in" hint={`${entries.length} entry points: ${entryKinds.map((k) => ENTRY_LABEL[k]).join(', ')}.`}>
                {entries.slice(0, 6).map((fn) => (
                  <button key={fn.id} className="guide-row" onClick={() => onStart(fn.id)}>
                    <span className="guide-row-text">
                      <span className="mono">{fn.qualifiedName === '(top level)' ? fn.file : displayName(fn)}</span>
                      <span className="guide-row-sub">{fn.purpose?.what}</span>
                    </span>
                    <span className="badge badge-quiet">{ENTRY_LABEL[fn.entry!.kind]}</span>
                  </button>
                ))}
              </GuideSection>
            )}
            {graph.sinks.length > 0 && (
              <GuideSection title="Talks to">
                <div className="guide-chips">
                  {graph.sinks.map((s) => (
                    <span key={s.id} className={`guide-chip sink-${s.category}`} title={s.examples.join(', ')}>
                      {s.label}
                    </span>
                  ))}
                </div>
              </GuideSection>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function GuideSection({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="guide-section">
      <h2>{title}</h2>
      {hint && <p className="guide-hint">{hint}</p>}
      {children}
    </section>
  );
}

const shortName = (fn: FnNode) => (fn.qualifiedName === '(top level)' ? fn.file.split('/').pop()! : fn.qualifiedName);

/** Graphs made before guides existed: assemble one from what the graph already has. */
function fallbackGuide(ix: Index) {
  const sys = ix.graph.groups.filter((g) => g.kind === 'system').sort((a, b) => b.fnIds.length - a.fnIds.length);
  const mods = ix.graph.groups.filter((g) => g.kind === 'module').sort((a, b) => b.fnIds.length - a.fnIds.length);
  const hot = (ix.graph.explore?.hotspots ?? []).map((h) => h.id);
  return {
    summary: sys[0]?.summary ?? `${ix.graph.nodes.length} functions.`,
    architecture: mods.slice(0, 6).map((m) => `${m.label}: ${m.summary ?? ''}`),
    startHere: [...ix.tour.slice(0, 3), ...hot].slice(0, 5).map((id) => ({ id, reason: ix.fns.get(id)?.purpose?.what ?? '' })),
    source: 'heuristic' as const,
  };
}
