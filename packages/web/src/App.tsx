import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Background, Controls, getNodesBounds, MiniMap, ReactFlow, useReactFlow, useStore, type Edge, type Node, type NodeMouseHandler } from '@xyflow/react';
import { buildIndex, defaultOverviewLod, displayName, isDone, LAYERS, LODS, OVERVIEW, riskLevel, type CodeGraph, type Index, type Layer, type Lod, type Selection } from './data.ts';
import { buildMap, type MapItem } from './impact.ts';
import { buildOverview } from './overview.ts';
import { Search, type SearchHit } from './Search.tsx';
import { Guide } from './Guide.tsx';
import { Brief } from './Brief.tsx';
import { MarksProvider, ReviewProgress, useMarks } from './Marks.tsx';
import { DiffViewer } from './DiffViewer.tsx';
import { DiscussionProvider } from './Discussion.tsx';
import type { PrDiscussion } from '../../cli/src/types.ts';
import { invariantLayer } from './layers.ts';
import { nodeTypes } from './nodes.tsx';
import { Panel } from './Panel.tsx';
import { DiffView } from './DiffView.tsx';

export function App() {
  const [graph, setGraph] = useState<CodeGraph | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const url = new URLSearchParams(location.search).get('graph') ?? '/codelens.graph.json';
    fetch(url)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${url}: ${r.status}`))))
      .then((g) => (isGraph(g) ? setGraph(g) : setError(versionError(g))))
      .catch((e) => setError(String(e.message ?? e)));
  }, []);

  if (!graph) return <Loader error={error} onLoad={setGraph} />;
  return <Review graph={graph} onReset={() => setGraph(null)} />;
}

const isGraph = (g: unknown): g is CodeGraph => (g as CodeGraph)?.version === 2 && Array.isArray((g as CodeGraph).nodes);
const versionError = (g: unknown) =>
  (g as { version?: number })?.version === 1 ? 'This graph was made by an older CodeLens. Re-run `codelens inspect` to regenerate it.' : 'Not a CodeLens graph.';

function Loader({ error, onLoad }: { error: string | null; onLoad: (g: CodeGraph) => void }) {
  const [dragging, setDragging] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);
  const read = async (file: File) => {
    try {
      const g = JSON.parse(await file.text());
      if (!isGraph(g)) throw new Error(versionError(g));
      onLoad(g);
    } catch (e) {
      setParseError((e as Error).message);
    }
  };
  return (
    <div
      className={`loader ${dragging ? 'dragging' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        const f = e.dataTransfer.files[0];
        if (f) read(f);
      }}
    >
      <div className="loader-card">
        <div className="brand brand-lg">
          <span className="brand-mark" /> CodeLens
        </div>
        {!error ? (
          <p className="muted">Loading graph…</p>
        ) : (
          <>
            <p>Drop a graph JSON here, or choose a file.</p>
            <label className="btn btn-primary">
              Choose file
              <input type="file" accept="application/json,.json" hidden onChange={(e) => e.target.files?.[0] && read(e.target.files[0])} />
            </label>
            <p className="muted small">
              Generate one with <code>npm run codelens -- inspect . --enrich</code>
            </p>
          </>
        )}
        {(parseError || (error && !error.includes(':'))) && <p className="error">{parseError ?? error}</p>}
      </div>
    </div>
  );
}

const BUDGETS = [25, 40, 80, 0] as const;
const BUDGET_KEY = 'codelens.cardBudget';

/** The viewer's card limit, remembered per browser. 0 = no limit. */
function useBudget(): [number, (n: number) => void] {
  const [budget, setBudget] = useState<number>(() => {
    try {
      const v = Number(localStorage.getItem(BUDGET_KEY));
      return (BUDGETS as readonly number[]).includes(v) && localStorage.getItem(BUDGET_KEY) !== null ? v : 25;
    } catch {
      return 25;
    }
  });
  const update = (n: number) => {
    setBudget(n);
    try {
      localStorage.setItem(BUDGET_KEY, String(n));
    } catch {
      // Storage unavailable: the choice lasts for this page only.
    }
  };
  return [budget, update];
}

function Review({ graph, onReset }: { graph: CodeGraph; onReset: () => void }) {
  // Fresh pull request discussion replaces the graph's copy and re-indexes (comment counts on cards).
  const [version, setVersion] = useState(0);
  const onDiscussion = useCallback(
    (d: PrDiscussion) => {
      if (!graph.meta.pr) return;
      graph.meta.pr.discussion = d;
      setVersion((v) => v + 1);
    },
    [graph],
  );
  return (
    <DiscussionProvider graph={graph} onChange={onDiscussion}>
      <MarksProvider graph={graph}>
        <ReviewView graph={graph} version={version} onReset={onReset} />
      </MarksProvider>
    </DiscussionProvider>
  );
}

function ReviewView({ graph, version, onReset }: { graph: CodeGraph; version: number; onReset: () => void }) {
  const { reviewed, accepted } = useMarks();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const ix = useMemo(() => buildIndex(graph, reviewed, accepted), [graph, version, reviewed, accepted]);

  // Deep links: ?layer=1&fn=<node id>&lod=2
  const params = new URLSearchParams(location.search);
  const linked = params.get('fn');
  const initialFocus = params.get('ov') ? OVERVIEW : linked && ix.fns.has(linked) ? linked : ix.explore ? OVERVIEW : (ix.reviewOrder[0] ?? OVERVIEW);
  // Stepping through changes skips files already marked reviewed.
  const tour = ix.explore ? ix.tour : ix.reviewOrder.filter((id) => ix.fns.has(id) && !isDone(ix, ix.fns.get(id)!));
  const searchRef = useRef<HTMLInputElement>(null);
  // Explore mode opens on the guide unless a link asks for a specific function or the map.
  // Both modes open on a landing page — the package guide, or the review brief — unless a link
  // asks for a specific function or the map.
  const landing = ix.explore || !!graph.meta.pr || !!graph.enrichment;
  const landingName = ix.explore ? 'Guide' : 'Brief';
  const [view, setView] = useState<'guide' | 'map'>(() => (landing && (params.get('view') === 'guide' || (!linked && params.get('view') !== 'map')) ? 'guide' : 'map'));

  const [layer, setLayer] = useState<Layer>(() => (Number(params.get('layer')) || 1) as Layer);
  const [history, setHistory] = useState<string[]>([initialFocus]);
  const focus = history.at(-1)!;
  const [focusLod, setFocusLod] = useState<Lod>(() => (params.has('lod') ? (Number(params.get('lod')) as Lod) : 1));
  const [overviewLod, setOverviewLod] = useState<Lod>(() => (!linked && params.has('lod') ? (Math.max(1, Number(params.get('lod'))) as Lod) : defaultOverviewLod(graph)));
  const inOverview = focus === OVERVIEW;
  const lod = inOverview ? overviewLod : focusLod;
  const setLod = inOverview ? setOverviewLod : setFocusLod;
  const minLod: Lod = inOverview ? 1 : 0;
  const hasTests = useMemo(() => graph.nodes.some((n) => n.entry?.kind === 'test'), [graph]);
  const [showTests, setShowTests] = useState(() => !ix.explore);
  const [budget, setBudget] = useBudget();
  const [opened, setOpened] = useState<Set<string>>(new Set());
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [expandedCols, setExpandedCols] = useState<Set<number>>(new Set());
  const [selection, setSelection] = useState<Selection>(() => (params.has('sel') ? decodeSelection(params.get('sel')) : linked ? { kind: 'fn', id: initialFocus } : null));

  // ---- back / forward: every move is a browser history entry, and the URL says where you are ----
  const [nav, setNav] = useState({ depth: 0, max: 0 });
  useEffect(() => {
    const place: Place = { view, layer, focus, sel: encodeSelection(selection) };
    const current = window.history.state as (Place & { depth?: number }) | null;
    // Equal to the current entry: nothing moved, or this render is restoring it after back/forward.
    if (current && current.view === place.view && current.layer === place.layer && current.focus === place.focus && current.sel === place.sel) return;
    const url = placeUrl(place);
    if (current?.depth === undefined) {
      window.history.replaceState({ ...place, depth: 0 }, '', url);
      return;
    }
    const depth = current.depth + 1;
    window.history.pushState({ ...place, depth }, '', url);
    setNav({ depth, max: depth });
  }, [view, layer, focus, selection]);
  useEffect(() => {
    const onPop = (e: PopStateEvent) => {
      const p = e.state as (Place & { depth: number }) | null;
      if (!p) return;
      setView(p.view);
      setLayer(p.layer);
      setHistory((h) => {
        const at = h.lastIndexOf(p.focus);
        return at >= 0 ? h.slice(0, at + 1) : [...h.slice(-11), p.focus];
      });
      setSelection(decodeSelection(p.sel));
      setNav((n) => ({ depth: p.depth, max: Math.max(n.max, p.depth) }));
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const back = useCallback(() => window.history.back(), []);
  const forward = useCallback(() => window.history.forward(), []);
  const navControls = { back, forward, canBack: nav.depth > 0, canForward: nav.depth < nav.max };
  // The full-screen diff of one file, over everything else.
  const [diff, setDiff] = useState<{ path: string; fnId?: string } | null>(null);
  const openDiff = useCallback((path: string, fnId?: string) => setDiff({ path, fnId }), []);

  const centerOn = useCallback(
    (id: string, mode: 'push' | 'replace' = 'push') => {
      setHistory((h) => (h.at(-1) === id ? h : mode === 'push' ? [...h.slice(-11), id] : [id]));
      setExpandedGroups(new Set());
      setExpandedCols(new Set());
      setSelection({ kind: 'fn', id });
      setLayer(1);
    },
    [],
  );
  const showOverview = useCallback(() => {
    setHistory((h) => (h.at(-1) === OVERVIEW ? h : [...h.slice(-11), OVERVIEW]));
    setExpandedGroups(new Set());
    setOpened(new Set());
    setLayer(1);
  }, []);
  const changeLod = useCallback(
    (next: Lod) => {
      setLod(Math.max(minLod, next) as Lod);
      setExpandedGroups(new Set());
      setOpened(new Set());
      setExpandedCols(new Set());
    },
    [setLod, minLod],
  );
  const onSearch = useCallback(
    (hit: SearchHit) => {
      setView('map');
      if (hit.kind === 'fn') return centerOn(hit.fn.id);
      // Show a group at its own level in the overview, selected.
      const level = ({ file: 1, module: 2, system: 3 } as const)[hit.group.kind];
      setOverviewLod(level);
      setHistory((h) => (h.at(-1) === OVERVIEW ? h : [...h.slice(-11), OVERVIEW]));
      setExpandedGroups(new Set());
      setSelection({ kind: 'group', id: hit.group.id });
      setLayer(1);
    },
    [centerOn],
  );
  const toggleGroup = useCallback((id: string) => {
    setExpandedGroups((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }, []);
  const stepChange = useCallback(
    (delta: number) => {
      if (!tour.length) return;
      const i = tour.indexOf(focus);
      const next = i < 0 && delta < 0 ? tour.length - 1 : (i + delta + tour.length) % tour.length;
      centerOn(tour[next], i < 0 ? 'push' : 'replace');
    },
    [tour, focus, centerOn],
  );
  const openLayer = useCallback((l: Layer, fnId?: string) => {
    setLayer(l);
    if (fnId) setSelection({ kind: 'fn', id: fnId });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === '/') {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (landing && (e.key === 'g' || e.key === 'b')) setView('guide');
      else if (landing && e.key === 'm') setView('map');
      else if (e.key === 'Backspace' && nav.depth > 0) back();
      else if (view === 'guide') return;
      else if (e.key === 'o' || e.key === 'Home') showOverview();
      else if (!ix.explore && ['1', '2', '3'].includes(e.key)) setLayer(Number(e.key) as Layer);
      else if (e.key === 'Escape') setSelection(null);
      else if (e.key === 'd' && selection?.kind === 'fn' && ix.fns.get(selection.id)) openDiff(ix.fns.get(selection.id)!.file, selection.id);
      else if (layer === 1 && (e.key === '-' || e.key === '_')) changeLod(Math.min(3, lod + 1) as Lod);
      else if (layer === 1 && (e.key === '=' || e.key === '+')) changeLod(Math.max(minLod, lod - 1) as Lod);
      else if (e.key === 'ArrowRight' || e.key === 'j') stepChange(1);
      else if (e.key === 'ArrowLeft' || e.key === 'k') stepChange(-1);
      else if (e.key === 'Backspace' && nav.depth > 0) back();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [layer, lod, minLod, history, changeLod, stepChange, showOverview, ix, view, nav, back, selection, openDiff]);

  const { meta, enrichment } = graph;
  const risk = enrichment?.overallRisk ?? 0;
  const changeIndex = tour.indexOf(focus);
  const ex = graph.explore;
  const stepNoun = ix.explore ? 'Entry point' : 'Change';

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" /> CodeLens
        </div>
        <div className="topbar-meta">
          <span className="mono repo" title={meta.repo}>
            {meta.repo.split('/').pop()}
          </span>
          {ix.explore ? (
            <span className="mono rev" title={ex?.snapshot.commit ?? undefined}>
              {meta.scope ? `${meta.scope} · ` : ''}
              {ex?.snapshot.commit ? ex.snapshot.commit.slice(0, 7) : 'no git'}
              {ex?.snapshot.dirty ? ' + uncommitted' : ''}
            </span>
          ) : meta.pr ? (
            <a className="pr-title" href={meta.pr.url} target="_blank" rel="noreferrer" title={`Open #${meta.pr.number} on GitHub`}>
              <span className={`pr-state pr-${meta.pr.state}`}>{meta.pr.state}</span>
              <span className="pr-number">#{meta.pr.number}</span>
              <span className="pr-name">{meta.pr.title}</span>
              <span className="pr-go">↗</span>
            </a>
          ) : (
            <span className="mono rev">
              {meta.base} → {meta.head === 'WORKING' ? 'working tree' : meta.head}
            </span>
          )}
        </div>
        {landing && (
          <div className="view-switch" role="tablist" aria-label="View">
            <button role="tab" aria-selected={view === 'guide'} className={view === 'guide' ? 'active' : ''} onClick={() => setView('guide')} title={`${landingName} (${ix.explore ? 'g' : 'b'})`}>
              {landingName}
            </button>
            <button role="tab" aria-selected={view === 'map'} className={view === 'map' ? 'active' : ''} onClick={() => setView('map')} title="Map (m)">
              Map
            </button>
          </div>
        )}
        <Search ref={searchRef} ix={ix} onPick={onSearch} />
        <div className="stats">
          {ix.explore ? (
            <>
              <Stat value={meta.stats.functions} label="functions" />
              <Stat value={ix.tour.length} label="entry points" />
              <Stat value={graph.groups.filter((g) => g.kind === 'module' && g.fnIds.some((id) => !ix.fns.get(id)?.outside)).length} label="modules" />
              {ex?.since && !ex.since.identical && <Stat value={ex.since.added + ex.since.changed} label="new or changed" />}
            </>
          ) : (
            <>
              <Stat value={meta.stats.changedFunctions} label="changed" />
              <Stat value={meta.stats.impactedFunctions} label="impacted callers" />
              <Stat value={graph.groups.filter((g) => g.kind === 'system').length} label="systems" />
            </>
          )}
          {enrichment && (
            <div className={`stat stat-risk risk-${riskLevel(risk)}`} title={`Scored by ${enrichment.provider}`}>
              <span className="stat-value">{risk.toFixed(2)}</span>
              <span className="stat-label">overall risk</span>
            </div>
          )}
        </div>
        <button className="btn btn-ghost" onClick={onReset} title="Load another graph">
          Open…
        </button>
      </header>

      {!ix.explore && view === 'map' && (
      <nav className="layers" aria-label="Review layers">
        {LAYERS.map((l) => (
          <button key={l.id} className={`layer-tab ${layer === l.id ? 'active' : ''}`} onClick={() => setLayer(l.id)} title={l.hint}>
            <span className="layer-num">{l.id}</span>
            <span className="layer-text">
              <span className="layer-name">{l.name}</span>
              <span className="layer-hint">{l.hint}</span>
            </span>
          </button>
        ))}
      </nav>
      )}

      {!ix.explore && view === 'guide' ? (
        <Brief
          ix={ix}
          nav={navControls}
          onOpenDiff={openDiff}
          onStart={(id) => {
            setView('map');
            centerOn(id);
          }}
          onMap={() => {
            setView('map');
            setLayer(1);
          }}
        />
      ) : ix.explore && view === 'guide' ? (
        <Guide
          ix={ix}
          onStart={(id) => {
            setView('map');
            centerOn(id);
          }}
          onPart={(g) => onSearch({ kind: 'group', group: g, score: 0 })}
          onMap={() => {
            setView('map');
            showOverview();
          }}
        />
      ) : (
      <main className="workspace">
        <div className="stage">
          {layer === 1 && (
            <div className="map-toolbar">
              <div className="focus-bar">
                <button className={`icon-btn home-btn ${inOverview ? 'active' : ''}`} onClick={showOverview} title="Overview (o)">
                  ⌂
                </button>
                <button className="icon-btn" onClick={() => stepChange(-1)} title={`Previous ${stepNoun.toLowerCase()} (←)`} disabled={!tour.length}>
                  ‹
                </button>
                <span className="focus-count">
                  {changeIndex >= 0
                    ? `${stepNoun} ${changeIndex + 1} of ${tour.length}`
                    : inOverview
                      ? 'Overview'
                      : !ix.explore && ix.fns.get(focus) && isDone(ix, ix.fns.get(focus)!)
                        ? tour.length
                          ? `Accepted · ${tour.length} left`
                          : 'All changes reviewed ✓'
                        : 'Exploring'}
                </span>
                <button className="icon-btn" onClick={() => stepChange(1)} title={`Next ${stepNoun.toLowerCase()} (→)`} disabled={!tour.length}>
                  ›
                </button>
                <span className="crumbs">
                  {history.map((id, i) => (
                    <span key={`${id}-${i}`}>
                      {i > 0 && <span className="crumb-sep">›</span>}
                      <button
                        className={`crumb ${i === history.length - 1 ? 'current' : ''}`}
                        onClick={() => setHistory((h) => h.slice(0, i + 1))}
                        title={ix.fns.get(id)?.file}
                      >
                        {id === OVERVIEW ? 'Overview' : ix.fns.has(id) ? displayName(ix.fns.get(id)!) : id}
                      </button>
                    </span>
                  ))}
                </span>
              </div>
              {!ix.explore && <ReviewProgress compact />}
              <div className="lod" role="radiogroup" aria-label="Level of detail">
                {inOverview && hasTests && (
                  <button className={`lod-btn tests-btn ${showTests ? 'active' : ''}`} onClick={() => setShowTests(!showTests)} aria-pressed={showTests} title="Show test code in the overview">
                    Tests
                  </button>
                )}
                <span className="lod-label" title={inOverview ? 'Show the code as systems, modules or files' : 'Show the callers and callees around the focus as individual functions, or grouped by file, module or system'}>
                  Group by
                </span>
                <label className="budget" title="Most cards drawn at once; the rest fold into “+N more” cards">
                  <span className="lod-label">Cards</span>
                  <select value={budget} onChange={(e) => setBudget(Number(e.target.value))}>
                    {BUDGETS.map((b) => (
                      <option key={b} value={b}>
                        {b || 'All'}
                      </option>
                    ))}
                  </select>
                </label>
                {LODS.filter((l) => l.id >= minLod).map((l) => (
                  <button key={l.id} role="radio" aria-checked={lod === l.id} className={`lod-btn ${lod === l.id ? 'active' : ''}`} onClick={() => changeLod(l.id)}>
                    {l.name}
                  </button>
                ))}
              </div>
            </div>
          )}
          {layer === 1 && inOverview && (
            <OverviewCanvas
              ix={ix}
              lod={lod}
              expandedGroups={expandedGroups}
              selection={selection}
              showTests={showTests}
              budget={budget}
              opened={opened}
              onOpen={(key) => setOpened((o) => new Set(o).add(key))}
              onShowAll={() => setBudget(0)}
              onSelect={setSelection}
              onFocus={centerOn}
              onToggleGroup={toggleGroup}
            />
          )}
          {layer === 1 && !inOverview && (
            <ImpactCanvas
              ix={ix}
              focus={focus}
              lod={lod}
              expandedGroups={expandedGroups}
              expandedCols={expandedCols}
              selection={selection}
              budget={budget}
              onSelect={setSelection}
              onFocus={centerOn}
              onToggleGroup={toggleGroup}
              onExpandCol={(c) => setExpandedCols((s) => new Set(s).add(c))}
            />
          )}
          {layer === 2 && <InvariantCanvas ix={ix} selection={selection} onSelect={setSelection} />}
          {layer === 3 && <DiffView ix={ix} focusFn={selection?.kind === 'fn' ? selection.id : undefined} selection={selection} onSelect={setSelection} />}
          {layer !== 3 && <Legend layer={layer} overview={inOverview} explore={ix.explore} />}
        </div>
        <aside className="panel">
          <Panel
            ix={ix}
            selection={selection}
            focus={focus}
            expandedGroups={expandedGroups}
            onSelect={setSelection}
            onFocus={centerOn}
            onToggleGroup={(id) => {
              toggleGroup(id);
              setLayer(1);
            }}
            onLayer={openLayer}
            onOpenDiff={openDiff}
            nav={navControls}
          />
        </aside>
      </main>
      )}
      {diff && <DiffViewer key={diff.path} ix={ix} path={diff.path} fnId={diff.fnId} onClose={() => setDiff(null)} onOpen={(path) => setDiff({ path })} />}
    </div>
  );
}

// ---- where you are, as a history entry and a URL ----

interface Place {
  view: 'guide' | 'map';
  layer: Layer;
  focus: string;
  sel: string | null;
}

function encodeSelection(s: Selection): string | null {
  if (!s) return null;
  if (s.kind === 'invariant') return `inv:${s.index}:${s.fnId}`;
  return `${s.kind}:${s.id}`;
}

function decodeSelection(raw: string | null): Selection {
  if (!raw) return null;
  const i = raw.indexOf(':');
  const kind = raw.slice(0, i);
  const rest = raw.slice(i + 1);
  if (kind === 'inv') {
    const j = rest.indexOf(':');
    return { kind: 'invariant', index: Number(rest.slice(0, j)), fnId: rest.slice(j + 1) };
  }
  if (kind === 'fn' || kind === 'group' || kind === 'sink') return { kind, id: rest };
  return null;
}

/** The current URL with this place in it (other parameters, like ?graph=, are kept). */
function placeUrl(p: Place): string {
  const q = new URLSearchParams(location.search);
  q.set('view', p.view);
  q.set('layer', String(p.layer));
  if (p.focus === OVERVIEW) {
    q.delete('fn');
    q.set('ov', '1');
  } else {
    q.set('fn', p.focus);
    q.delete('ov');
  }
  if (p.sel) q.set('sel', p.sel);
  else q.delete('sel');
  return `${location.pathname}?${q.toString()}`;
}

function Stat({ value, label }: { value: number; label: string }) {
  return (
    <div className="stat">
      <span className="stat-value">{value}</span>
      <span className="stat-label">{label}</span>
    </div>
  );
}

function ImpactCanvas(props: {
  ix: Index;
  focus: string;
  lod: Lod;
  expandedGroups: Set<string>;
  expandedCols: Set<number>;
  selection: Selection;
  budget: number;
  onSelect: (s: Selection) => void;
  onFocus: (id: string) => void;
  onToggleGroup: (id: string) => void;
  onExpandCol: (col: number) => void;
}) {
  const { ix, focus, lod, expandedGroups, expandedCols, selection, budget, onSelect, onFocus, onToggleGroup, onExpandCol } = props;
  const view = useMemo(
    () => buildMap(ix, focus, lod, expandedGroups, expandedCols, selection, budget),
    [ix, focus, lod, expandedGroups, expandedCols, selection, budget],
  );

  const itemOf = (node: Node) => (node.data as { item?: MapItem }).item;
  const clicked = useRef<string | null>(null);
  const onNodeClick: NodeMouseHandler<Node> = (_, node) => {
    const item = itemOf(node);
    if (!item) return;
    clicked.current = node.id;
    if (item.kind === 'fn') onSelect({ kind: 'fn', id: item.fn!.id });
    else if (item.kind === 'group') onSelect({ kind: 'group', id: item.group!.id });
    else if (item.kind === 'sink') onSelect({ kind: 'sink', id: item.sink!.id });
    else if (item.kind === 'bundle') onExpandCol(item.col);
  };
  // Double-click is the progressive-disclosure gesture: center on a function, open a group.
  const onNodeDoubleClick: NodeMouseHandler<Node> = (_, node) => {
    const item = itemOf(node);
    if (item?.kind === 'fn' && item.fn!.id !== focus) onFocus(item.fn!.id);
    else if (item?.kind === 'group') onToggleGroup(item.group!.id);
  };

  return (
    <>
      <ReactFlow
        key={`${focus}|${lod}|${budget}|${[...expandedGroups].join(',')}|${[...expandedCols].join(',')}`}
        nodes={view.nodes}
        edges={view.edges}
        nodeTypes={nodeTypes}
        onNodeClick={onNodeClick}
        onNodeDoubleClick={onNodeDoubleClick}
        onPaneClick={() => onSelect(null)}
        nodesConnectable={false}
        nodesDraggable={false}
        zoomOnDoubleClick={false}
        fitView
        fitViewOptions={{ padding: 0.12, maxZoom: 1 }}
        minZoom={0.1}
        proOptions={{ hideAttribution: true }}
        colorMode="system"
      >
        <Background gap={24} size={1} />
        <Controls showInteractive={false} />
        <MiniMap pannable zoomable className="minimap" nodeClassName={(n) => `mm-${n.type}`} />
        <ZoomToSelection nodes={view.nodes} edges={view.edges} clicked={clicked} />
      </ReactFlow>
      <div className="map-stats">
        {view.stats.upstream} upstream · {view.stats.downstream} downstream
        {view.stats.hiddenHops && ' · more beyond 4 hops'}
      </div>
    </>
  );
}

const ZOOM_MS = 450;
/** Below this zoom cards are hard to read: frame the selected card alone instead of its neighbors. */
const READABLE_ZOOM = 0.6;
const MAX_ZOOM = 1.1;

/**
 * Brings the selected card into readable view: with its direct neighbors when they fit at a
 * readable zoom, else the card alone. Selections made by clicking the map leave the view alone,
 * so a click never moves what is under the pointer (or breaks a double-click).
 */
function ZoomToSelection({ nodes, edges, clicked }: { nodes: Node[]; edges: Edge[]; clicked: React.MutableRefObject<string | null> }) {
  const flow = useReactFlow();
  const width = useStore((s) => s.width);
  const height = useStore((s) => s.height);
  const target = nodes.find((n) => (n.data as { selected?: boolean }).selected)?.id;
  const shown = useRef<string | undefined>(undefined);
  useEffect(() => {
    // Cards carry explicit sizes, so their bounds are known without waiting for measurement.
    if (!target || !width || !height || shown.current === target) return;
    if (clicked.current === target) {
      clicked.current = null;
      shown.current = target;
      return;
    }
    const at = (ids: Set<string>) => [...ids].map((id) => flow.getNode(id)).filter((n): n is Node => !!n);
    const neighbors = new Set([target, ...edges.filter((e) => e.source === target || e.target === target).flatMap((e) => [e.source, e.target])]);
    const around = getNodesBounds(at(neighbors));
    const fit = Math.min(width / around.width, height / around.height) * 0.85;
    const frame = fit >= READABLE_ZOOM ? around : getNodesBounds(at(new Set([target])));
    const zoom = fit >= READABLE_ZOOM ? Math.min(fit, MAX_ZOOM) : 0.9;
    // After React Flow's own initial fit-to-view, which would otherwise undo this.
    // Marked done only when it runs: a re-render before then cancels and reschedules it.
    const timer = setTimeout(() => {
      shown.current = target;
      void flow.setCenter(frame.x + frame.width / 2, frame.y + frame.height / 2, { zoom, duration: ZOOM_MS });
    }, 80);
    return () => clearTimeout(timer);
  }, [target, width, height, flow, edges, clicked]);
  return null;
}

function OverviewCanvas(props: {
  ix: Index;
  lod: Lod;
  expandedGroups: Set<string>;
  selection: Selection;
  showTests: boolean;
  budget: number;
  opened: Set<string>;
  onOpen: (key: string) => void;
  onShowAll: () => void;
  onSelect: (s: Selection) => void;
  onFocus: (id: string) => void;
  onToggleGroup: (id: string) => void;
}) {
  const { ix, lod, expandedGroups, selection, showTests, budget, opened, onOpen, onShowAll, onSelect, onFocus, onToggleGroup } = props;
  const view = useMemo(
    () => buildOverview(ix, lod, expandedGroups, selection, { showTests, budget, opened }),
    [ix, lod, expandedGroups, selection, showTests, budget, opened],
  );
  const itemOf = (node: Node) => (node.data as { item?: MapItem }).item;
  const clicked = useRef<string | null>(null);
  return (
    <>
      <ReactFlow
        key={`overview|${lod}|${showTests}|${budget}|${[...opened].join(',')}|${[...expandedGroups].join(',')}`}
        nodes={view.nodes}
        edges={view.edges}
        nodeTypes={nodeTypes}
        onNodeClick={(_, node) => {
          const item = itemOf(node);
          clicked.current = node.id;
          if (item?.kind === 'fn') onSelect({ kind: 'fn', id: item.fn!.id });
          else if (item?.kind === 'group') onSelect({ kind: 'group', id: item.group!.id });
          else if (item?.kind === 'sink') onSelect({ kind: 'sink', id: item.sink!.id });
          else if (item?.kind === 'bundle' && item.group) onSelect({ kind: 'group', id: item.group.id });
        }}
        onNodeDoubleClick={(_, node) => {
          const item = itemOf(node);
          if (item?.kind === 'fn') onFocus(item.fn!.id);
          else if (item?.kind === 'group') onToggleGroup(item.group!.id);
          else if (item?.kind === 'bundle') onOpen(item.id.slice('rest|'.length));
        }}
        onPaneClick={() => onSelect(null)}
        nodesConnectable={false}
        nodesDraggable={false}
        zoomOnDoubleClick={false}
        fitView
        fitViewOptions={{ padding: 0.1, maxZoom: 1 }}
        minZoom={0.05}
        proOptions={{ hideAttribution: true }}
        colorMode="system"
      >
        <Background gap={24} size={1} />
        <Controls showInteractive={false} />
        <MiniMap pannable zoomable className="minimap" nodeClassName={(n) => `mm-${n.type}`} />
        <ZoomToSelection nodes={view.nodes} edges={view.edges} clicked={clicked} />
      </ReactFlow>
      <div className="map-stats">
        {view.stats.folded > 0 ? (
          <>
            {view.stats.total - view.stats.folded} of {view.stats.total} parts shown · {view.stats.edges} connections ·{' '}
            <button className="link" onClick={onShowAll}>
              show all
            </button>
          </>
        ) : (
          <>
            {view.stats.total} parts · {view.stats.edges} connections
          </>
        )}
      </div>
    </>
  );
}

function InvariantCanvas({ ix, selection, onSelect }: { ix: Index; selection: Selection; onSelect: (s: Selection) => void }) {
  const focusFn = selection?.kind === 'fn' ? selection.id : selection?.kind === 'invariant' ? selection.fnId : undefined;
  const { nodes, edges } = useMemo(() => invariantLayer(ix, selection, focusFn), [ix, selection, focusFn]);
  if (!nodes.length) return <div className="empty">No invariants detected in this change.</div>;
  return (
    <ReactFlow
      key={focusFn ?? 'all'}
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodeClick={(_, node) => {
        if (node.type === 'fn') onSelect({ kind: 'fn', id: node.id });
        else if (node.type === 'invariant') {
          const [, fnId, index] = node.id.match(/^inv:(.*):(\d+)$/)!;
          onSelect({ kind: 'invariant', fnId, index: Number(index) });
        }
      }}
      onPaneClick={() => onSelect(null)}
      nodesConnectable={false}
      fitView
      fitViewOptions={{ padding: 0.15, maxZoom: 1.1 }}
      minZoom={0.15}
      proOptions={{ hideAttribution: true }}
      colorMode="system"
    >
      <Background gap={24} size={1} />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}

function Legend({ layer, overview, explore }: { layer: Layer; overview?: boolean; explore?: boolean }) {
  const items: [string, string][] =
    overview || explore
      ? [
          ['ln-ok', 'calls (thicker = more)'],
          ['ln-effect', 'external effect'],
        ]
      : layer === 1
      ? [
          ['ln-breaking', 'call into broken contract'],
          ['ln-dangling', 'call to deleted function'],
          ['ln-effect', 'external effect'],
        ]
      : [
          ['sw-broken', 'broken'],
          ['sw-atrisk', 'at risk'],
          ['sw-preserved', 'preserved'],
        ];
  return (
    <div className="legend">
      {items.map(([cls, label]) => (
        <span key={cls}>
          <i className={cls} />
          {label}
        </span>
      ))}
      {layer === 1 && <span className="legend-tip">{overview ? 'double-click: open group / center on function' : 'double-click: center / open group'}</span>}
    </div>
  );
}
