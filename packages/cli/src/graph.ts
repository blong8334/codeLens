import { createPatch } from 'diff';
import { assignGroups, countAncestors, fnId, ignoreFilter, linkCalls, logParsed, makeNode, productionCallers, typeCheck } from './build.ts';
import { loadConfig } from './config.ts';
import { remoteInfo, Repo, WORKING_TREE } from './git.ts';
import { detectEntry } from './hierarchy.ts';
import { languageFor, loadFiles, parseFile, type ExtractedFile, type ExtractedFn } from './parse.ts';
import { openSnapshot } from './source.ts';
import type { Store } from './store/index.ts';
import type { ChangeStatus, CodeGraph, FnNode } from './types.ts';

export interface InspectOptions {
  base: string;
  head: string;
  /** How many caller and callee hops to include around changed functions. */
  maxDepth: number;
  /** Emit the entire repository graph instead of just the impacted subgraph. */
  full: boolean;
  /** Type-aware resolution for TypeScript/JavaScript (default on). */
  types?: boolean;
  /** Parse cache; omit to parse everything from scratch. */
  store?: Store;
  log?: (msg: string) => void;
}


export async function inspect(dir: string, opts: InspectOptions): Promise<CodeGraph> {
  const log = opts.log ?? (() => {});
  const repo = await Repo.open(dir);
  const base = await repo.resolve(opts.base);
  const head = await repo.resolve(opts.head);
  log(`Repository ${repo.root} — comparing ${base} → ${head === WORKING_TREE ? 'working tree' : head}`);

  const { config, path: configPath } = await loadConfig(repo.root);
  if (configPath) log(`Using ${configPath}`);
  const ignored = ignoreFilter(config);

  // 1. Parse every source file at head (cached by content in the store).
  const snapshot = await openSnapshot(repo.root, head === WORKING_TREE ? WORKING_TREE : head);
  const remote = await remoteInfo(repo.root, snapshot.commit);
  const allPaths = snapshot.files.map((f) => f.path);
  const { files: headFiles, stats: loadStats } = await loadFiles(snapshot, { include: (p) => !ignored(p), store: opts.store });
  logParsed(log, headFiles, loadStats);

  // 2. Classify function-level changes by diffing the base and head versions of each changed file.
  const status = new Map<string, ChangeStatus>();
  const beforeFns = new Map<string, ExtractedFn>();
  const deleted: { file: ExtractedFile; fn: ExtractedFn }[] = [];
  for (const change of await repo.changedFiles(base, head)) {
    if (!languageFor(change.path) || ignored(change.path)) continue;
    const headFile = headFiles.get(change.path);
    const baseSource = change.status === 'added' ? null : await repo.readAt(base, change.basePath);
    const baseFile = baseSource != null ? await parseFile(change.basePath, baseSource) : null;
    const baseByName = new Map(baseFile?.functions.map((f) => [f.qualifiedName, f]));
    const headNames = new Set(headFile?.functions.map((f) => f.qualifiedName));

    for (const fn of headFile?.functions ?? []) {
      const prev = baseByName.get(fn.qualifiedName);
      const id = fnId(change.path, fn.qualifiedName);
      if (!prev) status.set(id, 'added');
      else if (prev.fingerprint !== fn.fingerprint) {
        status.set(id, 'modified');
        beforeFns.set(id, prev);
      }
    }
    if (baseFile) {
      for (const fn of baseFile.functions) {
        if (!headNames.has(fn.qualifiedName)) deleted.push({ file: { ...baseFile, path: change.path }, fn });
      }
    }
  }

  // 3. Build the full call graph.
  const nodes = new Map<string, FnNode>();
  const decorators = new Map<string, string[]>();
  const addFn = (file: ExtractedFile, fn: ExtractedFn, st: ChangeStatus) => {
    const id = fnId(file.path, fn.qualifiedName);
    const before = beforeFns.get(id);
    const node = makeNode(file, fn, st);
    if (st === 'modified' && before) {
      node.before = { signature: before.signature, source: before.source, throws: before.throws };
      node.after = { source: fn.source };
      node.diff = functionDiff(file.path, before.source, fn.source);
    } else if (st === 'added') {
      node.after = { source: fn.source };
      node.diff = functionDiff(file.path, '', fn.source);
    } else if (st === 'deleted') {
      node.before = { signature: fn.signature, source: fn.source, throws: fn.throws };
      node.diff = functionDiff(file.path, fn.source, '');
    }
    nodes.set(id, node);
    decorators.set(id, fn.decorators);
  };
  for (const file of headFiles.values()) {
    for (const fn of file.functions) addFn(file, fn, status.get(fnId(file.path, fn.qualifiedName)) ?? 'unchanged');
  }
  for (const { file, fn } of deleted) addFn(file, fn, 'deleted');

  const typed = opts.types === false ? undefined : await typeCheck(snapshot, headFiles, nodes, log);
  snapshot.close();
  const { graph, edges, sinks } = linkCalls(nodes, headFiles, config, typed);

  // 4. Blast radius traversal: walk callers outward from every changed function.
  const changedIds = [...nodes.values()].filter((n) => n.status !== 'unchanged').map((n) => n.id);
  const queue = changedIds.map((id) => ({ id, depth: 0 }));
  for (const { id } of queue) nodes.get(id)!.depth = 0;
  while (queue.length) {
    const { id, depth } = queue.shift()!;
    graph.forEachInNeighbor(id, (caller) => {
      const n = nodes.get(caller)!;
      if (n.depth === null || n.depth > depth + 1) {
        n.depth = depth + 1;
        queue.push({ id: caller, depth: depth + 1 });
      }
    });
  }
  for (const id of changedIds) nodes.get(id)!.transitiveCallers = countAncestors(graph, id);

  // ...and callees outward, so the downstream side of each change is available too.
  const down = changedIds.map((id) => ({ id, depth: 0 }));
  for (const { id } of down) nodes.get(id)!.downDepth = 0;
  while (down.length) {
    const { id, depth } = down.shift()!;
    graph.forEachOutNeighbor(id, (callee) => {
      const n = nodes.get(callee)!;
      if (n.downDepth === null || n.downDepth > depth + 1) {
        n.downDepth = depth + 1;
        down.push({ id: callee, depth: depth + 1 });
      }
    });
  }

  for (const n of nodes.values()) {
    n.entry = detectEntry(n, decorators.get(n.id) ?? [], productionCallers(graph, n.id), config);
  }

  // 5. Prune to the impacted subgraph: changes plus callers and callees within maxDepth.
  const within = (d: number | null) => d !== null && d <= opts.maxDepth;
  const keep = opts.full ? new Set(nodes.keys()) : new Set([...nodes.values()].filter((n) => within(n.depth) || within(n.downDepth)).map((n) => n.id));
  if (!opts.full) {
    // One hop of callee context for every kept function, so re-centering anywhere shows what it touches.
    for (const id of [...keep]) graph.forEachOutNeighbor(id, (callee) => keep.add(callee));
  }
  const keptNodes = [...nodes.values()].filter((n) => keep.has(n.id));
  const keptEdges = [...edges.values()].filter((e) => keep.has(e.source) && keep.has(e.target));

  // 6. Hierarchy: file → module → system (auto-detected, overridable via .codelens.json).
  const groups = await assignGroups(keptNodes, allPaths, (p) => repo.readAt(head, p), config);
  const usedSinks = new Set(keptNodes.flatMap((n) => n.effects));

  log(`${changedIds.length} changed functions, ${keptNodes.filter((n) => (n.depth ?? 0) > 0).length} impacted callers`);

  return {
    version: 2,
    meta: {
      mode: 'review',
      repo: repo.root,
      base,
      head,
      generatedAt: new Date().toISOString(),
      config: configPath,
      remote,
      stats: {
        filesParsed: headFiles.size,
        functions: nodes.size,
        changedFunctions: changedIds.length,
        impactedFunctions: keptNodes.filter((n) => (n.depth ?? 0) > 0).length,
      },
    },
    nodes: keptNodes,
    edges: keptEdges,
    groups,
    sinks: [...sinks.sinks.values()].filter((s) => usedSinks.has(s.id)),
  };
}

function functionDiff(file: string, before: string, after: string): string {
  const patch = createPatch(file, before ? before + '\n' : '', after ? after + '\n' : '', '', '', { context: 3 });
  // Drop the `Index:` / `===` / `---` / `+++` header; keep hunks.
  return patch.split('\n').slice(4).join('\n').trimEnd();
}

