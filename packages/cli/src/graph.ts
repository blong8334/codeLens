import { DirectedGraph } from 'graphology';
import { createPatch } from 'diff';
import { dirname, join, normalize as normalizePath } from 'node:path/posix';
import { Repo, WORKING_TREE } from './git.ts';
import { languageFor, parseFile, type ExtractedCall, type ExtractedFile, type ExtractedFn } from './parse.ts';
import { loadConfig, matches } from './config.ts';
import { detectEntry, findPackages, Grouper, SinkClassifier } from './hierarchy.ts';
import type { CallEdge, ChangeStatus, CodeGraph, FnNode } from './types.ts';

export interface InspectOptions {
  base: string;
  head: string;
  /** How many caller and callee hops to include around changed functions. */
  maxDepth: number;
  /** Emit the entire repository graph instead of just the impacted subgraph. */
  full: boolean;
  log?: (msg: string) => void;
}

const IGNORED_DIRS = /(^|\/)(node_modules|dist|build|out|vendor|coverage|\.next|__pycache__|\.venv|venv)\//;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_SOURCE_CHARS = 6000;

export async function inspect(dir: string, opts: InspectOptions): Promise<CodeGraph> {
  const log = opts.log ?? (() => {});
  const repo = await Repo.open(dir);
  const base = await repo.resolve(opts.base);
  const head = await repo.resolve(opts.head);
  log(`Repository ${repo.root} — comparing ${base} → ${head === WORKING_TREE ? 'working tree' : head}`);

  const { config, path: configPath } = await loadConfig(repo.root);
  if (configPath) log(`Using ${configPath}`);
  const ignored = (p: string) => IGNORED_DIRS.test(p) || !!config.ignore?.some((g) => matches(g, p));

  // 1. Parse every source file at head.
  const allPaths = await repo.listFiles(head);
  const paths = allPaths.filter((p) => languageFor(p) && !ignored(p));
  const headFiles = new Map<string, ExtractedFile>();
  for (const path of paths) {
    const source = await repo.readAt(head, path);
    if (source == null || source.length > MAX_FILE_BYTES) continue;
    const parsed = await parseFile(path, source);
    if (parsed) headFiles.set(path, parsed);
  }
  log(`Parsed ${headFiles.size} source files`);

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
  const graph = new DirectedGraph({ allowSelfLoops: false });
  const nodes = new Map<string, FnNode>();
  const decorators = new Map<string, string[]>();
  const addFn = (file: ExtractedFile, fn: ExtractedFn, st: ChangeStatus) => {
    const id = fnId(file.path, fn.qualifiedName);
    const before = beforeFns.get(id);
    const node: FnNode = {
      id,
      name: fn.name,
      qualifiedName: fn.qualifiedName,
      file: file.path,
      language: file.language,
      kind: fn.kind,
      exported: fn.exported,
      range: { startLine: fn.startLine, endLine: fn.endLine },
      signature: fn.signature,
      status: st,
      depth: null,
      downDepth: null,
      transitiveCallers: 0,
      source: fn.source.length > MAX_SOURCE_CHARS ? `${fn.source.slice(0, MAX_SOURCE_CHARS)}\n/* … truncated … */` : fn.source,
      doc: fn.doc,
      throws: fn.throws,
      groups: { file: '', module: '', system: '' },
      effects: [],
    };
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
    graph.mergeNode(id);
  };
  for (const file of headFiles.values()) {
    for (const fn of file.functions) addFn(file, fn, status.get(fnId(file.path, fn.qualifiedName)) ?? 'unchanged');
  }
  for (const { file, fn } of deleted) addFn(file, fn, 'deleted');

  const resolver = new CallResolver([...nodes.values()], headFiles);
  const sinks = new SinkClassifier(config);
  const edges = new Map<string, CallEdge>();
  for (const file of headFiles.values()) {
    for (const fn of file.functions) {
      const callerId = fnId(file.path, fn.qualifiedName);
      const caller = nodes.get(callerId)!;
      for (const call of fn.calls) {
        const hit = resolver.resolve(caller, call, file.importNames);
        if (!hit) {
          // Not our code: maybe an external effect (database, network, filesystem, …).
          const sink = sinks.classify(call, file.importNames);
          if (sink && !caller.effects.includes(sink)) caller.effects.push(sink);
          continue;
        }
        if (hit.id === callerId) continue;
        const key = `${callerId}->${hit.id}`;
        const existing = edges.get(key);
        if (existing) existing.count++;
        else {
          edges.set(key, {
            id: key,
            source: callerId,
            target: hit.id,
            count: 1,
            confidence: hit.confidence,
            dangling: nodes.get(hit.id)!.status === 'deleted' || undefined,
          });
          graph.mergeEdge(callerId, hit.id);
        }
      }
    }
  }

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
    n.entry = detectEntry(n, decorators.get(n.id) ?? [], graph.inDegree(n.id), config);
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
  const manifestNames = new Map<string, string>();
  for (const p of allPaths.filter((p) => p.endsWith('/package.json')).slice(0, 300)) {
    try {
      const name = JSON.parse((await repo.readAt(head, p)) ?? '{}').name;
      if (typeof name === 'string') manifestNames.set(dirname(p), name);
    } catch {
      // Unparseable manifest: fall back to the directory name.
    }
  }
  const groups = new Grouper(config, findPackages(allPaths, manifestNames)).assign(keptNodes);
  const usedSinks = new Set(keptNodes.flatMap((n) => n.effects));

  log(`${changedIds.length} changed functions, ${keptNodes.filter((n) => (n.depth ?? 0) > 0).length} impacted callers`);

  return {
    version: 2,
    meta: {
      repo: repo.root,
      base,
      head,
      generatedAt: new Date().toISOString(),
      config: configPath,
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

const fnId = (file: string, qualifiedName: string) => `${file}#${qualifiedName}`;

function functionDiff(file: string, before: string, after: string): string {
  const patch = createPatch(file, before ? before + '\n' : '', after ? after + '\n' : '', '', '', { context: 3 });
  // Drop the `Index:` / `===` / `---` / `+++` header; keep hunks.
  return patch.split('\n').slice(4).join('\n').trimEnd();
}

function countAncestors(graph: DirectedGraph, id: string): number {
  const seen = new Set<string>();
  const stack = [id];
  while (stack.length) {
    graph.forEachInNeighbor(stack.pop()!, (caller) => {
      if (!seen.has(caller) && caller !== id) {
        seen.add(caller);
        stack.push(caller);
      }
    });
  }
  return seen.size;
}

/**
 * Name-based call resolution. Tree-sitter gives us syntax, not types, so we rank candidates by
 * locality: same class → same file → imported files → globally unique name.
 */
class CallResolver {
  private byName = new Map<string, FnNode[]>();

  constructor(
    nodes: FnNode[],
    private files: Map<string, ExtractedFile>,
  ) {
    for (const n of nodes) {
      const list = this.byName.get(n.name) ?? [];
      list.push(n);
      this.byName.set(n.name, list);
    }
  }

  resolve(caller: FnNode, call: ExtractedCall, importNames: Record<string, string>): { id: string; confidence: 'high' | 'low' } | null {
    const { name, member, object } = call;
    const all = this.byName.get(name);
    if (!all) return null;
    // Live functions win over deleted ones; a deleted match means the call site now dangles.
    const live = all.filter((n) => n.status !== 'deleted');
    const pool = live.length ? live : all;
    const unique = (list: FnNode[], confidence: 'high' | 'low') => (list.length === 1 ? { id: list[0].id, confidence } : null);
    const imported = this.importedFiles(caller.file);

    if (!member) {
      const fns = pool.filter((n) => n.kind !== 'method');
      return (
        unique(fns.filter((n) => n.file === caller.file), 'high') ??
        unique(fns.filter((n) => imported.has(n.file) && n.exported), 'high') ??
        unique(fns, 'low')
      );
    }

    // `ns.fn()` where `ns` is a namespace import of one of our modules.
    const spec = object ? importNames[object] : undefined;
    if (spec?.startsWith('.')) {
      const stems = importStems(caller.file, spec, caller.language === 'python');
      const hit = unique(pool.filter((n) => stems.has(stripExt(n.file)) && n.kind !== 'method'), 'high');
      if (hit) return hit;
    }
    // `this.m()` / `self.m()`: a method on the caller's own class.
    const callerClass = caller.qualifiedName.split('.').slice(0, -1).join('.');
    if (callerClass && (object === 'this' || object === 'self' || object === 'cls')) {
      const hit = unique(pool.filter((n) => n.file === caller.file && n.qualifiedName === `${callerClass}.${name}`), 'high');
      if (hit) return hit;
    }
    // Any other receiver: without types we can only match methods, never free functions.
    const methods = pool.filter((n) => n.kind === 'method');
    return (
      unique(methods.filter((n) => n.file === caller.file), 'high') ??
      unique(methods.filter((n) => imported.has(n.file)), 'low') ??
      unique(methods, 'low')
    );
  }

  private importCache = new Map<string, Set<string>>();

  private importedFiles(path: string): Set<string> {
    let set = this.importCache.get(path);
    if (set) return set;
    set = new Set();
    const file = this.files.get(path);
    for (const spec of file?.imports ?? []) {
      const stems = importStems(path, spec, file!.language === 'python');
      for (const candidate of this.files.keys()) {
        if (stems.has(stripExt(candidate))) set.add(candidate);
      }
    }
    this.importCache.set(path, set);
    return set;
  }
}

const stripExt = (p: string) => p.replace(/\.(d\.)?[mc]?[jt]sx?$|\.py$/, '');

function importStems(from: string, spec: string, python: boolean): Set<string> {
  const stems = new Set<string>();
  if (python) {
    const dots = spec.match(/^\.*/)![0].length;
    const rest = spec.slice(dots).replace(/\./g, '/');
    if (dots) {
      let dir = dirname(from);
      for (let i = 1; i < dots; i++) dir = dirname(dir);
      stems.add(normalizePath(join(dir, rest)));
    } else {
      stems.add(rest);
      stems.add(normalizePath(join(dirname(from), rest)));
    }
    for (const s of [...stems]) stems.add(`${s}/__init__`);
  } else if (spec.startsWith('.')) {
    const target = stripExt(normalizePath(join(dirname(from), spec)));
    stems.add(target);
    stems.add(`${target}/index`);
  }
  return stems;
}
