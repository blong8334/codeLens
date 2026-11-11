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
  /** Set when this function was moved or renamed: its id in the base revision, and whether the body is otherwise unchanged. */
  moved?: { from: string; renamed: boolean; exact: boolean };
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
  /** Resolved by a type checker rather than by name. */
  typed?: boolean;
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
    /** Set when the graph reviews a GitHub pull request (`codelens pr`). */
    pr?: PullRequestInfo;
    /** Set when the graph reviews a patch file (`codelens diff`): a change from any review tool. */
    change?: { title?: string; description?: string; source: string };
    /** False when written with --no-source: nodes carry no code or diffs. */
    sourceIncluded?: boolean;
    /** Where the code can be browsed online, for links from the canvas. */
    remote?: { web: string; host: 'github' | 'gitlab' | 'bitbucket' | 'other'; commit: string };
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
  /** Review mode: what is being reviewed, file by file (for "reviewed" marks). */
  review?: ReviewData;
}

export interface ReviewData {
  /** Stable id of this review across pushes: `github.com/owner/repo#12`, or `local:<root>:<branch>`. */
  key: string;
  files: ReviewFile[];
  /** Changed function id → fingerprint of its own changes: an "accept change" mark holds while it matches. */
  functions: Record<string, string>;
  /** The reviewer's preferences, when they have any (`~/.config/codelens/preferences.md`). */
  preferences?: ReviewPreferences;
  /** Functions (ids) and files (paths) the preferences skip: shown apart, not counted as left to review. */
  skipped?: string[];
}

export interface ReviewPreferences {
  /** Where they were read from. */
  source: string;
  /** The reviewer's own words: what they care about and what they skip. */
  text: string;
  skipTests: boolean;
  skipMoves: boolean;
}

export interface ReviewFile {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  additions: number;
  deletions: number;
  /** Hash of this file's changed lines: a mark is valid while it matches. */
  fingerprint: string;
  /** Changed functions in this file (0 for non-code files). */
  functions: number;
  /** Unified diff hunks with context, for the diff viewer (absent with --no-source, or when huge). */
  patch?: string;
}

export interface PullRequestInfo {
  number: number;
  title: string;
  url: string;
  author: string;
  state: 'open' | 'draft' | 'closed' | 'merged';
  baseRef: string;
  headRef: string;
  /** `owner/repo` the head branch lives in (differs from `repo` for forks). */
  headRepo?: string;
  repo: string;
  /** The commit reviewed; comments and reviews are posted against it. */
  headSha: string;
  body: string;
  /** Threads, reviews and conversation, as of `discussion.fetchedAt`. */
  discussion?: PrDiscussion;
  additions?: number;
  deletions?: number;
  changedFiles?: number;
}

export interface PrComment {
  id: number;
  author: string;
  body: string;
  createdAt: string;
  url: string;
}

/** A line-comment thread: the first comment and its replies. */
export interface PrThread {
  /** Id of the first comment (replies go to it). */
  id: number;
  path: string;
  /** Line in the reviewed head, or null when the code has changed since (outdated). */
  line: number | null;
  originalLine: number | null;
  side: 'LEFT' | 'RIGHT';
  outdated: boolean;
  /** The function the thread is about, when it could be located. */
  fnId?: string;
  comments: PrComment[];
}

export interface PrReview {
  id: number;
  author: string;
  state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING';
  body: string;
  submittedAt: string;
  url: string;
}

export interface PrDiscussion {
  fetchedAt: string;
  threads: PrThread[];
  reviews: PrReview[];
  /** General pull request comments. */
  conversation: PrComment[];
}

// ---- Explore mode ----

export interface Guide {
  /** A few sentences: what this package is and does. */
  summary: string;
  /** Short points on how it is organized and how work flows through it. */
  architecture: string[];
  /** Suggested reading order, each with why to start there. */
  startHere: { id: string; reason: string }[];
  source: 'llm' | 'readme' | 'heuristic';
}

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
  /** The package's README (opening part), used for the guide. */
  readme?: { path: string; text: string };
  /** The landing page: what this is, how it is organized, where to start. */
  guide?: Guide;
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
  /**
   * A signature change the compiler enforces: a statically typed language, and every direct caller
   * is updated in the same change. If it builds, the callers match, so `breaking` is false.
   */
  compilerChecked?: boolean;
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
  /** Notes on what the reviewer cares about (performance, duplication, structure…), from the model. */
  concerns?: { topic: string; note: string }[];
  source: 'heuristic' | 'llm';
}

/** The page a code review opens on. */
export interface ReviewBrief {
  /** What the change does and why. */
  overview: string;
  /** How it does it. */
  approach: string[];
  /** Concrete risks, most serious first. */
  risks: { title: string; detail: string; fnIds: string[] }[];
  /** What a reviewer should check. */
  watch: string[];
  /** Where to start reading, and why. */
  readingOrder: { id: string; reason: string }[];
  /** How the change is tested. */
  testing: string;
  source: 'llm' | 'heuristic';
}

export interface GraphEnrichment {
  summary: string;
  overallRisk: number; // 0.0 – 1.0
  reviewOrder: string[]; // node ids, highest risk first
  brief?: ReviewBrief;
  provider: string;
}
