// Shared schema for the CodeLens graph JSON. The web canvas imports these types too.

/** A language id from `src/lang` (e.g. `typescript`, `java`, `go`). */
export type Language = string;
export type ChangeStatus = 'added' | 'modified' | 'deleted' | 'unchanged';
export type FnKind = 'function' | 'method' | 'arrow';

export interface Signature {
  params: Param[];
  returnType?: string;
  async: boolean;
  text: string;
}

export interface Param {
  name: string;
  type?: string;
  optional: boolean;
}

export interface FnNode {
  id: string; // `${file}#${qualifiedName}`
  name: string;
  qualifiedName: string;
  file: string;
  language: Language;
  kind: FnKind;
  exported: boolean;
  range: { startLine: number; endLine: number };
  signature: Signature;
  status: ChangeStatus;
  /** Shortest caller-distance to a changed function (0 = changed itself). */
  depth: number | null;
  /** Number of distinct transitive callers. */
  transitiveCallers: number;
  /** Shortest callee-distance from a changed function (0 = changed itself). */
  downDepth: number | null;
  before?: { signature: Signature; source: string; throws: string[] };
  after?: { source: string };
  /** Current source (base source for deleted functions), truncated for very long bodies. */
  source: string;
  /** Leading doc comment / docstring, if any. */
  doc?: string;
  /** Unified diff restricted to this function. */
  diff?: string;
  throws: string[];
  /** Ids of the file / module / system groups this function belongs to. */
  groups: { file: string; module: string; system: string };
  /** Set when this function is a way into the system (route, CLI, job, test, public API). */
  entry?: { kind: EntryKind; reason: string };
  /** Sink ids for external effects this function performs directly. */
  effects: string[];
  purpose?: Purpose;
  enrichment?: NodeEnrichment;
  /** Explore mode: outside the explored scope, kept as one hop of context. */
  outside?: boolean;
  /** Explore mode: new or changed since the previous explore of this scope. */
  since?: 'new' | 'changed';
}

export type EntryKind = 'route' | 'cli' | 'job' | 'test' | 'main' | 'public-api' | 'config';

export interface Purpose {
  what: string;
  why: string;
  source: 'doc' | 'heuristic' | 'llm';
}

export type GroupKind = 'file' | 'module' | 'system';

export interface Group {
  id: string; // `${kind}:...`
  kind: GroupKind;
  label: string;
  path?: string;
  parent?: string;
  /** All functions contained in this group (transitively). */
  fnIds: string[];
  changed: number;
  /** True when assigned by auto-detection rather than `.codelens.json`. */
  auto: boolean;
  summary?: string;
}

export type SinkCategory = 'database' | 'cache' | 'network' | 'filesystem' | 'process' | 'queue' | 'storage' | (string & {});

export interface Sink {
  id: string; // `sink:${category}`
  category: SinkCategory;
  label: string;
  /** A few representative call expressions, e.g. `gateway.post()`. */
  examples: string[];
}

export interface CallEdge {
  id: string;
  source: string; // caller
  target: string; // callee
  count: number;
  confidence: 'high' | 'low';
  /** The callee was deleted in this change but the call site remains. */
  dangling?: boolean;
}

export interface CodeGraph {
  version: 2;
  meta: {
    /** `review` (a diff, from `inspect`) or `explore` (a whole package). Absent means review. */
    mode?: 'review' | 'explore';
    repo: string;
    /** Explore mode: path of the explored package within the repository ('' = everything). */
    scope?: string;
    base: string;
    head: string;
    generatedAt: string;
    /** Config file that overrode auto-detection, if one was found. */
    config?: string;
    stats: {
      filesParsed: number;
      functions: number;
      changedFunctions: number;
      impactedFunctions: number;
    };
  };
  nodes: FnNode[];
  edges: CallEdge[];
  groups: Group[];
  sinks: Sink[];
  enrichment?: GraphEnrichment;
  explore?: ExploreData;
}

// ---- Explore mode ----

export interface Hotspot {
  id: string;
  score: number;
  fanIn: number;
  fanOut: number;
  /** Distinct modules among its callers and callees. */
  modules: number;
  /** Transitive callers. */
  reach: number;
}

export interface ExploreData {
  /** Entry points in reading order: routes, CLIs, jobs, mains, public API, then tests. */
  entries: string[];
  /** The functions that hold the package together, most central first. */
  hotspots: Hotspot[];
  snapshot: {
    commit: string | null;
    dirty: boolean;
    /** Store snapshot id, when the store recorded this run. */
    id?: number;
  };
  /** Compared with the previous explore of the same scope, if there was one. */
  since?: {
    commit: string | null;
    at: string;
    added: number;
    changed: number;
    removed: number;
    /** Nothing in scope changed: everything came from the store. */
    identical: boolean;
  };
}

// ---- Enrichment ----

export type ContractChangeKind =
  | 'none'
  | 'added'
  | 'removed'
  | 'param-added'
  | 'param-removed'
  | 'param-type-changed'
  | 'return-type-changed'
  | 'async-changed'
  | 'throws-changed'
  | 'behavioral';

export interface ContractChange {
  breaking: boolean;
  kinds: ContractChangeKind[];
  before?: string;
  after?: string;
  description: string;
}

export interface Invariant {
  statement: string;
  status: 'preserved' | 'at-risk' | 'broken';
  risk: 'low' | 'medium' | 'high';
  evidence?: string;
}

export interface NodeEnrichment {
  summary: string;
  contract: ContractChange;
  invariants: Invariant[];
  blastRadius: number; // 0.0 – 1.0
  reasons: string[];
  source: 'heuristic' | 'llm';
}

export interface GraphEnrichment {
  summary: string;
  overallRisk: number; // 0.0 – 1.0
  reviewOrder: string[]; // node ids, highest risk first
  provider: string;
}
