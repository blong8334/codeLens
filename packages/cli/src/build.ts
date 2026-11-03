// Graph-building steps shared by `inspect` (review a diff) and `explore` (understand a package).
import { DirectedGraph } from 'graphology';
import { dirname } from 'node:path/posix';
import { matches, type CodeLensConfig } from './config.ts';
import { findPackages, Grouper, SinkClassifier } from './hierarchy.ts';
import type { ExtractedFile, ExtractedFn, LoadStats } from './parse.ts';
import { CallResolver, FileIndex } from './resolve.ts';
import { IGNORED_DIRS } from './source.ts';
import type { CallEdge, ChangeStatus, FnNode, Group } from './types.ts';

const MAX_SOURCE_CHARS = 6000;

export const fnId = (file: string, qualifiedName: string) => `${file}#${qualifiedName}`;

export function ignoreFilter(config: CodeLensConfig): (path: string) => boolean {
  return (p) => IGNORED_DIRS.test(p) || !!config.ignore?.some((g) => matches(g, p));
}

export function logParsed(log: (m: string) => void, files: Map<string, ExtractedFile>, stats: LoadStats) {
  const perLanguage = new Map<string, number>();
  for (const f of files.values()) perLanguage.set(f.language, (perLanguage.get(f.language) ?? 0) + 1);
  const langs = [...perLanguage].sort((a, b) => b[1] - a[1]).map(([l, n]) => `${l} ${n}`).join(', ');
  const cache = stats.cached ? ` — ${stats.cached} from cache, ${stats.parsed} parsed` : '';
  log(`Parsed ${files.size} source files (${langs || 'none'})${cache}`);
}

export function makeNode(file: ExtractedFile, fn: ExtractedFn, status: ChangeStatus): FnNode {
  return {
    id: fnId(file.path, fn.qualifiedName),
    name: fn.name,
    qualifiedName: fn.qualifiedName,
    file: file.path,
    language: file.language,
    kind: fn.kind,
    exported: fn.exported,
    range: { startLine: fn.startLine, endLine: fn.endLine },
    signature: fn.signature,
    status,
    depth: null,
    downDepth: null,
    transitiveCallers: 0,
    source: fn.source.length > MAX_SOURCE_CHARS ? `${fn.source.slice(0, MAX_SOURCE_CHARS)}\n/* … truncated … */` : fn.source,
    doc: fn.doc,
    throws: fn.throws,
    groups: { file: '', module: '', system: '' },
    effects: [],
  };
}

/** Resolve every call in `files` to a node (an edge) or an external effect (a sink). */
export function linkCalls(nodes: Map<string, FnNode>, files: Map<string, ExtractedFile>, config: CodeLensConfig) {
  const graph = new DirectedGraph({ allowSelfLoops: false });
  for (const id of nodes.keys()) graph.mergeNode(id);
  const dirFiles = new Map<string, string[]>();
  for (const p of files.keys()) (dirFiles.get(dirname(p)) ?? dirFiles.set(dirname(p), []).get(dirname(p))!).push(p);
  const resolver = new CallResolver([...nodes.values()], files, new FileIndex(files.keys()), dirFiles);
  const sinks = new SinkClassifier(config);
  const edges = new Map<string, CallEdge>();
  for (const file of files.values()) {
    for (const fn of file.functions) {
      const callerId = fnId(file.path, fn.qualifiedName);
      const caller = nodes.get(callerId);
      if (!caller) continue;
      for (const call of fn.calls) {
        const hit = resolver.resolve(caller, call, file, fn.self);
        if (!hit) {
          // Not our code: maybe an external effect (database, network, filesystem, …).
          const sink = sinks.classify(call, file);
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
  return { graph, edges, sinks };
}

/** File → module → system groups (auto-detected, overridable via .codelens.json). */
export async function assignGroups(
  nodes: FnNode[],
  allPaths: string[],
  readText: (path: string) => Promise<string | null>,
  config: CodeLensConfig,
): Promise<Group[]> {
  const manifestNames = new Map<string, string>();
  for (const p of allPaths.filter((p) => p.endsWith('/package.json')).filter((p) => !IGNORED_DIRS.test(p)).slice(0, 300)) {
    try {
      const name = JSON.parse((await readText(p)) ?? '{}').name;
      if (typeof name === 'string') manifestNames.set(dirname(p), name);
    } catch {
      // Unparseable manifest: fall back to the directory name.
    }
  }
  return new Grouper(config, findPackages(allPaths, manifestNames)).assign(nodes);
}

export function countAncestors(graph: DirectedGraph, id: string): number {
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
