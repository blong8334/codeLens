import { useCallback, useEffect, useMemo, useState } from 'react';
import { Background, Controls, MiniMap, ReactFlow, type Node, type NodeMouseHandler } from '@xyflow/react';
import { buildIndex, LAYERS, LODS, riskLevel, type CodeGraph, type Index, type Layer, type Lod, type Selection } from './data.ts';
import { buildMap, type MapItem } from './impact.ts';
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

function Review({ graph, onReset }: { graph: CodeGraph; onReset: () => void }) {
  const ix = useMemo(() => buildIndex(graph), [graph]);

  // Deep links: ?layer=1&fn=<node id>&lod=2
  const params = new URLSearchParams(location.search);
  const linked = params.get('fn');
  const initialFocus = linked && ix.fns.has(linked) ? linked : (ix.reviewOrder[0] ?? graph.nodes[0]?.id);

  const [layer, setLayer] = useState<Layer>(() => (Number(params.get('layer')) || 1) as Layer);
  const [history, setHistory] = useState<string[]>([initialFocus]);
  const focus = history.at(-1)!;
  const [lod, setLod] = useState<Lod>(() => (params.has('lod') ? (Number(params.get('lod')) as Lod) : 1));
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [expandedCols, setExpandedCols] = useState<Set<number>>(new Set());
  const [selection, setSelection] = useState<Selection>(linked ? { kind: 'fn', id: initialFocus } : null);

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
  const changeLod = useCallback((next: Lod) => {
    setLod(next);
    setExpandedGroups(new Set());
    setExpandedCols(new Set());
  }, []);
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
      const order = ix.reviewOrder;
      if (!order.length) return;
      const i = order.indexOf(focus);
      centerOn(order[(i + delta + order.length) % order.length], 'replace');
    },
    [ix, focus, centerOn],
  );
  const openLayer = useCallback((l: Layer, fnId?: string) => {
    setLayer(l);
    if (fnId) setSelection({ kind: 'fn', id: fnId });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.metaKey || e.ctrlKey || e.altKey) return;
      if (['1', '2', '3'].includes(e.key)) setLayer(Number(e.key) as Layer);
      else if (e.key === 'Escape') setSelection(null);
      else if (layer === 1 && (e.key === '-' || e.key === '_')) changeLod(Math.min(3, lod + 1) as Lod);
      else if (layer === 1 && (e.key === '=' || e.key === '+')) changeLod(Math.max(0, lod - 1) as Lod);
      else if (e.key === 'ArrowRight' || e.key === 'j') stepChange(1);
      else if (e.key === 'ArrowLeft' || e.key === 'k') stepChange(-1);
      else if (e.key === 'Backspace' && history.length > 1) setHistory((h) => h.slice(0, -1));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [layer, lod, history, changeLod, stepChange]);

  const { meta, enrichment } = graph;
  const risk = enrichment?.overallRisk ?? 0;
  const changeIndex = ix.reviewOrder.indexOf(focus);

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
          <span className="mono rev">
            {meta.base} → {meta.head === 'WORKING' ? 'working tree' : meta.head}
          </span>
        </div>
        <div className="stats">
          <Stat value={meta.stats.changedFunctions} label="changed" />
          <Stat value={meta.stats.impactedFunctions} label="impacted callers" />
          <Stat value={graph.groups.filter((g) => g.kind === 'system').length} label="systems" />
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

      <main className="workspace">
        <div className="stage">
          {layer === 1 && (
            <div className="map-toolbar">
              <div className="focus-bar">
                <button className="icon-btn" onClick={() => stepChange(-1)} title="Previous change (←)" disabled={!ix.reviewOrder.length}>
                  ‹
                </button>
                <span className="focus-count">
                  {changeIndex >= 0 ? `Change ${changeIndex + 1} of ${ix.reviewOrder.length}` : 'Exploring'}
                </span>
                <button className="icon-btn" onClick={() => stepChange(1)} title="Next change (→)" disabled={!ix.reviewOrder.length}>
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
                        {ix.fns.get(id)?.qualifiedName ?? id}
                      </button>
                    </span>
                  ))}
                </span>
              </div>
              <div className="lod" role="radiogroup" aria-label="Level of detail">
                <span className="lod-label">Detail</span>
                {LODS.map((l) => (
                  <button key={l.id} role="radio" aria-checked={lod === l.id} className={`lod-btn ${lod === l.id ? 'active' : ''}`} onClick={() => changeLod(l.id)}>
                    {l.name}
                  </button>
                ))}
              </div>
            </div>
          )}
          {layer === 1 && focus && (
            <ImpactCanvas
              ix={ix}
              focus={focus}
              lod={lod}
              expandedGroups={expandedGroups}
              expandedCols={expandedCols}
              selection={selection}
              onSelect={setSelection}
              onFocus={centerOn}
              onToggleGroup={toggleGroup}
              onExpandCol={(c) => setExpandedCols((s) => new Set(s).add(c))}
            />
          )}
          {layer === 2 && <InvariantCanvas ix={ix} selection={selection} onSelect={setSelection} />}
          {layer === 3 && <DiffView ix={ix} focusFn={selection?.kind === 'fn' ? selection.id : undefined} selection={selection} onSelect={setSelection} />}
          {layer !== 3 && <Legend layer={layer} />}
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
          />
        </aside>
      </main>
    </div>
  );
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
  onSelect: (s: Selection) => void;
  onFocus: (id: string) => void;
  onToggleGroup: (id: string) => void;
  onExpandCol: (col: number) => void;
}) {
  const { ix, focus, lod, expandedGroups, expandedCols, selection, onSelect, onFocus, onToggleGroup, onExpandCol } = props;
  const view = useMemo(() => buildMap(ix, focus, lod, expandedGroups, expandedCols, selection), [ix, focus, lod, expandedGroups, expandedCols, selection]);

  const itemOf = (node: Node) => (node.data as { item?: MapItem }).item;
  const onNodeClick: NodeMouseHandler<Node> = (_, node) => {
    const item = itemOf(node);
    if (!item) return;
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
        key={`${focus}|${lod}|${[...expandedGroups].join(',')}|${[...expandedCols].join(',')}`}
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
      </ReactFlow>
      <div className="map-stats">
        {view.stats.upstream} upstream · {view.stats.downstream} downstream
        {view.stats.hiddenHops && ' · more beyond 4 hops'}
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

function Legend({ layer }: { layer: Layer }) {
  const items: [string, string][] =
    layer === 1
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
      {layer === 1 && <span className="legend-tip">double-click: center / open group</span>}
    </div>
  );
}
