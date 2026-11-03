// Explore mode: the whole call graph of a package (or repository) at one snapshot, with entry
// points, hotspots and — through the store — what changed since the last time you explored it.
import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import { assignGroups, countAncestors, fnId, ignoreFilter, linkCalls, logParsed, makeNode } from './build.ts';
import { loadConfig } from './config.ts';
import { WORKING_TREE } from './git.ts';
import { detectEntry } from './hierarchy.ts';
import { loadFiles } from './parse.ts';
import { openSnapshot } from './source.ts';
import type { SnapshotRecord, Store } from './store.ts';
import type { CodeGraph, EntryKind, FnNode, Hotspot } from './types.ts';

export interface ExploreOptions {
  /** Revision to explore, or `WORKING` for the files on disk. */
  ref?: string;
  store?: Store;
  /**
   * Parse only the explored scope instead of the whole repository. Faster on huge monorepos,
   * but calls into the rest of the repository then show as unresolved.
   */
  scopeOnly?: boolean;
  log?: (msg: string) => void;
}

export interface ExploreResult {
  graph: CodeGraph;
  /** Remember this run in the store so the next explore can say what changed. */
  record(provider: string): SnapshotRecord | undefined;
}

const ENTRY_ORDER: EntryKind[] = ['main', 'route', 'cli', 'job', 'config', 'public-api', 'test'];
const MAX_HOTSPOTS = 25;

export async function explore(dir: string, opts: ExploreOptions = {}): Promise<ExploreResult> {
  const log = opts.log ?? (() => {});
  const snapshot = await openSnapshot(dir, opts.ref ?? WORKING_TREE);
  // Compare real paths: git reports the resolved root (macOS /var → /private/var, symlinked homes).
  const scope = relative(await realpath(snapshot.root), await realpath(resolve(dir))).split(sep).join('/');
  if (scope.startsWith('..')) throw new Error(`${dir} is outside ${snapshot.root}`);
  const inScope = (p: string) => !scope || p === scope || p.startsWith(`${scope}/`);
  const label = snapshot.isGit ? (snapshot.ref === WORKING_TREE ? `working tree${snapshot.dirty ? ' (uncommitted changes)' : ''}` : snapshot.ref) : 'directory';
  log(`Exploring ${scope || snapshot.root} — ${label}${snapshot.commit ? ` @ ${snapshot.commit.slice(0, 7)}` : ''}`);

  const { config, path: configPath } = await loadConfig(snapshot.root);
  if (configPath) log(`Using ${configPath}`);
  const ignored = ignoreFilter(config);
  const include = (p: string) => !ignored(p) && (!opts.scopeOnly || inScope(p));
  const { files, stats } = await loadFiles(snapshot, { include, store: opts.store });
  logParsed(log, files, stats);
  if (![...files.keys()].some(inScope)) {
    snapshot.close();
    throw new Error(`no supported source files under ${scope || snapshot.root} (run \`codelens languages\` for the list)`);
  }

  // ---- call graph over everything parsed ----
  const nodes = new Map<string, FnNode>();
  const decorators = new Map<string, string[]>();
  const fingerprints = new Map<string, string>();
  for (const file of files.values()) {
    for (const fn of file.functions) {
      const node = makeNode(file, fn, 'unchanged');
      nodes.set(node.id, node);
      decorators.set(node.id, fn.decorators);
      if (inScope(file.path)) fingerprints.set(node.id, fn.fingerprint);
    }
  }
  const { graph, edges, sinks } = linkCalls(nodes, files, config);
  for (const n of nodes.values()) n.entry = detectEntry(n, decorators.get(n.id) ?? [], graph.inDegree(n.id), config);

  // ---- keep the scope, plus one hop of context on either side ----
  const keep = new Set([...nodes.values()].filter((n) => inScope(n.file)).map((n) => n.id));
  for (const id of [...keep]) {
    graph.forEachInNeighbor(id, (o) => keep.add(o));
    graph.forEachOutNeighbor(id, (o) => keep.add(o));
  }
  const kept = [...nodes.values()].filter((n) => keep.has(n.id));
  for (const n of kept) if (!inScope(n.file)) n.outside = true;
  const keptEdges = [...edges.values()].filter((e) => keep.has(e.source) && keep.has(e.target));
  const allPaths = snapshot.files.map((f) => f.path);
  const byPath = new Map(snapshot.files.map((f) => [f.path, f]));
  const groups = await assignGroups(kept, allPaths, async (p) => (byPath.has(p) ? snapshot.read(byPath.get(p)!) : null), config);
  snapshot.close();

  // ---- entry points and hotspots ----
  const scoped = kept.filter((n) => !n.outside);
  const entries = scoped
    .filter((n) => n.entry)
    .sort((a, b) => ENTRY_ORDER.indexOf(a.entry!.kind) - ENTRY_ORDER.indexOf(b.entry!.kind) || graph.outDegree(b.id) - graph.outDegree(a.id) || a.id.localeCompare(b.id))
    .map((n) => n.id);
  const moduleOf = new Map(kept.map((n) => [n.id, n.groups.module]));
  const candidates = scoped
    .filter((n) => n.entry?.kind !== 'test')
    .map((n) => {
      const neighbors = new Set<string>();
      graph.forEachNeighbor(n.id, (o) => neighbors.add(moduleOf.get(o) ?? ''));
      neighbors.delete('');
      return { n, fanIn: graph.inDegree(n.id), fanOut: graph.outDegree(n.id), modules: neighbors.size };
    })
    .filter((c) => c.fanIn + c.fanOut > 0)
    .sort((a, b) => b.fanIn * 2 + b.fanOut - (a.fanIn * 2 + a.fanOut))
    .slice(0, MAX_HOTSPOTS * 4);
  const hotspots: Hotspot[] = candidates
    .map(({ n, fanIn, fanOut, modules }) => {
      const reach = countAncestors(graph, n.id);
      n.transitiveCallers = reach;
      let score = fanIn * 2 + fanOut + Math.max(0, modules - 1) * 3 + Math.log2(1 + reach) * 2 + (n.entry ? 2 : 0);
      // A private helper used inside one module is plumbing, not structure.
      if (!n.exported && modules <= 1) score *= 0.5;
      return { id: n.id, score: Math.round(score * 10) / 10, fanIn, fanOut, modules, reach };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_HOTSPOTS);

  // ---- what changed since the last explore of this scope ----
  const tree = createHash('sha1');
  for (const f of snapshot.files.filter((f) => inScope(f.path) && files.has(f.path)).sort((a, b) => a.path.localeCompare(b.path))) tree.update(`${f.path}\0${f.blob}\n`);
  const treeHash = tree.digest('hex');
  const prev = opts.store?.lastSnapshot(snapshot.root, scope);
  let since: NonNullable<CodeGraph['explore']>['since'];
  if (prev && opts.store) {
    const before = opts.store.snapshotFunctions(prev.id);
    let added = 0;
    let changed = 0;
    for (const n of scoped) {
      const fp = before.get(n.id);
      if (fp === undefined) {
        n.since = 'new';
        added++;
      } else if (fp !== fingerprints.get(n.id)) {
        n.since = 'changed';
        changed++;
      }
    }
    const removed = [...before.keys()].filter((id) => !fingerprints.has(id)).length;
    since = { commit: prev.commit, at: prev.createdAt, added, changed, removed, identical: prev.tree === treeHash };
    const ago = prev.commit ? `${prev.commit.slice(0, 7)}${prev.dirty ? '+changes' : ''}` : prev.createdAt.slice(0, 16).replace('T', ' ');
    log(since.identical ? `Unchanged since your last explore (${ago})` : `Since your last explore (${ago}): ${added} new, ${changed} changed, ${removed} removed functions`);
  }

  const used = new Set(kept.flatMap((n) => n.effects));
  log(`${scoped.length} functions in scope (+${kept.length - scoped.length} context), ${entries.length} entry points, ${groups.filter((g) => g.kind === 'module').length} modules`);

  const graphOut: CodeGraph = {
    version: 2,
    meta: {
      mode: 'explore',
      repo: snapshot.root,
      scope,
      base: snapshot.commit?.slice(0, 7) ?? 'directory',
      head: snapshot.ref === WORKING_TREE ? WORKING_TREE : snapshot.ref,
      generatedAt: new Date().toISOString(),
      config: configPath,
      stats: { filesParsed: files.size, functions: scoped.length, changedFunctions: 0, impactedFunctions: 0 },
    },
    nodes: kept,
    edges: keptEdges,
    groups,
    sinks: [...sinks.sinks.values()].filter((s) => used.has(s.id)),
    explore: { entries, hotspots, snapshot: { commit: snapshot.commit, dirty: snapshot.dirty }, since },
  };

  return {
    graph: graphOut,
    record(provider) {
      if (!opts.store) return undefined;
      const rec = opts.store.recordSnapshot(
        {
          repo: snapshot.root,
          scope,
          commit: snapshot.commit,
          dirty: snapshot.dirty,
          tree: treeHash,
          provider,
          files: [...files.keys()].filter(inScope).length,
          functions: fingerprints.size,
        },
        fingerprints,
      );
      graphOut.explore!.snapshot.id = rec.id;
      return rec;
    },
  };
}

