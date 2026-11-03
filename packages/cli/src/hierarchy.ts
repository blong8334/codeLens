import { basename, dirname } from 'node:path/posix';
import { firstMatch, matches, type CodeLensConfig } from './config.ts';
import { specForId, specForPath } from './lang/index.ts';
import type { ExtractedCall, ExtractedFn } from './parse.ts';
import { TOP_LEVEL } from './lang/engine.ts';
import type { EntryKind, FnNode, Group, Sink, SinkCategory } from './types.ts';

// ---------------- Grouping: file → module → system ----------------

/** Directory names that organize code without naming a subsystem. */
const GENERIC_DIRS = new Set([
  'src', 'lib', 'libs', 'app', 'apps', 'packages', 'source', 'sources', 'internal', 'pkg', 'modules', 'code', 'main',
  'java', 'kotlin', 'scala', 'python', 'go', 'cmd', 'include', 'Sources', 'csharp', 'ruby', 'php',
]);
/** Reverse-DNS package roots (`com/acme/...`): skip both the TLD and the organization. */
const REVERSE_DNS = new Set(['com', 'org', 'net', 'io', 'dev', 'co', 'edu', 'gov', 'uk', 'de']);
const MANIFESTS =
  /(^|\/)(package\.json|pyproject\.toml|setup\.py|go\.mod|Cargo\.toml|pom\.xml|build\.gradle(\.kts)?|[^/]+\.csproj|Gemfile|composer\.json|Package\.swift|build\.sbt|mix\.exs|pubspec\.yaml)$/;

export interface PackageInfo {
  dir: string;
  name: string;
}

/** Nested package roots (workspaces, monorepo packages) found from manifest files. */
export function findPackages(allPaths: string[], manifestNames: Map<string, string>): PackageInfo[] {
  const pkgs: PackageInfo[] = [];
  for (const p of allPaths) {
    if (!MANIFESTS.test(p)) continue;
    const dir = dirname(p);
    if (dir === '.' || IGNORED.test(`${p}/`)) continue;
    if (pkgs.some((x) => x.dir === dir)) continue;
    pkgs.push({ dir, name: manifestNames.get(dir) ?? basename(dir) });
  }
  // Longest prefix first so nested packages win.
  return pkgs.sort((a, b) => b.dir.length - a.dir.length);
}

const IGNORED = /(^|\/)(node_modules|dist|build|vendor|\.venv|venv)\//;

export class Grouper {
  constructor(
    private config: CodeLensConfig,
    private packages: PackageInfo[],
  ) {}

  private packageFor(path: string): PackageInfo | undefined {
    return this.packages.find((p) => path.startsWith(`${p.dir}/`));
  }

  system(path: string): { name: string; auto: boolean } {
    const configured = firstMatch(this.config.systems, path);
    if (configured) return { name: configured, auto: false };
    const pkg = this.packageFor(path);
    if (pkg) return { name: pkg.name, auto: true };
    const segments = dirname(path).split('/').filter((s) => s && s !== '.');
    let meaningful: string | undefined;
    for (let i = 0; i < segments.length; i++) {
      if (GENERIC_DIRS.has(segments[i]) || segments[i] === 'test' || segments[i] === 'tests') continue;
      if (REVERSE_DNS.has(segments[i])) {
        i++; // skip the organization too
        continue;
      }
      meaningful = segments[i];
      break;
    }
    return { name: meaningful ?? segments.at(-1) ?? '(root)', auto: true };
  }

  module(path: string): { name: string; auto: boolean } {
    const configured = firstMatch(this.config.modules, path);
    if (configured) return { name: configured, auto: false };
    const pkg = this.packageFor(path);
    const dir = dirname(path);
    let rel = pkg ? dir.slice(pkg.dir.length + 1) || '.' : dir;
    // Tests, fixtures and test data form one module per test root, not one per folder.
    const t = rel.match(/^(.*?(?:^|\/)(?:__tests__|tests?|spec))(\/|$)/);
    if (t) rel = t[1];
    return { name: rel === '.' ? '(root)' : rel, auto: true };
  }

  /** Assign each kept function to groups and return the group list. */
  assign(nodes: FnNode[]): Group[] {
    const groups = new Map<string, Group>();
    const ensure = (id: string, init: () => Omit<Group, 'id' | 'fnIds' | 'changed'>) => {
      let g = groups.get(id);
      if (!g) {
        g = { id, fnIds: [], changed: 0, ...init() };
        groups.set(id, g);
      }
      return g;
    };
    for (const n of nodes) {
      const sys = this.system(n.file);
      const mod = this.module(n.file);
      const systemId = `system:${sys.name}`;
      const moduleId = `module:${sys.name}::${mod.name}`;
      const fileId = `file:${n.file}`;
      const touched = [
        ensure(systemId, () => ({ kind: 'system', label: sys.name, auto: sys.auto })),
        ensure(moduleId, () => ({ kind: 'module', label: mod.name, parent: systemId, auto: mod.auto })),
        ensure(fileId, () => ({ kind: 'file', label: basename(n.file), path: n.file, parent: moduleId, auto: true })),
      ];
      for (const g of touched) {
        g.fnIds.push(n.id);
        if (n.status !== 'unchanged') g.changed++;
      }
      n.groups = { file: fileId, module: moduleId, system: systemId };
    }
    return [...groups.values()];
  }
}

// ---------------- Entry points ----------------

/** Generic test-directory conventions; each language adds its own file patterns. */
const TEST_DIR = /(^|\/)(__tests__|tests?|spec)\//;
const ROUTE_DIR = /(^|\/)(routes?|api|handlers?|controllers?|endpoints?|views|pages)\//;
/** Route / handler annotations across ecosystems: Python, Spring, JAX-RS, ASP.NET, Rust web frameworks, NestJS. */
const ROUTE_DECORATOR =
  /@\w*\.?(route|get|post|put|patch|delete|api_view|websocket)\b|@(Get|Post|Put|Delete|Patch|Request)Mapping\b|@(GET|POST|PUT|DELETE|PATCH|Path)\b|\[(Http(Get|Post|Put|Delete|Patch)|Route)\b|#\[(actix_web::)?(get|post|put|delete|patch|route)\b/i;
const TEST_DECORATOR = /@(Test|ParameterizedTest|RepeatedTest)\b|\[(Test|Fact|Theory|TestMethod|TestCase)\b|#\[(tokio::)?test\b|@pytest\./;
const CLI_DECORATOR = /@\w*\.?(command|group|cli)\b|@Command\b/i;
const JOB_DECORATOR = /@\w*\.?(task|shared_task|cron|schedule|scheduled_job|periodic_task)\b|@Scheduled\b|@SqsListener\b|@KafkaListener\b|\[FunctionName\b/i;

/** Files that are run rather than imported: CLIs, servers, scripts. */
const SCRIPT_FILE = /(^|\/)(bin|scripts?|cmd|tools?)\/|(^|\/)(main|cli|server|app|manage|__main__|run)\.[^/]+$|\.(sh|bash)$/;

export function isTestFile(path: string): boolean {
  return TEST_DIR.test(path) || !!specForPath(path)?.testFile?.test(path);
}

export function detectEntry(
  fn: Pick<FnNode, 'file' | 'qualifiedName' | 'name' | 'exported' | 'signature' | 'kind' | 'source'>,
  decorators: string[],
  callerCount: number,
  config: CodeLensConfig,
): FnNode['entry'] {
  const e = (kind: EntryKind, reason: string) => ({ kind, reason });
  if (config.entryPoints?.some((p) => matches(p, fn.file, fn.qualifiedName))) return e('config', 'listed in .codelens.json');
  const deco = decorators.join(' ');
  if (isTestFile(fn.file) || TEST_DECORATOR.test(deco)) return e('test', TEST_DECORATOR.test(deco) ? `annotated ${decorators[0]}` : 'test file');
  const hinted = specForPath(fn.file)?.hooks?.entry?.({ name: fn.name, params: fn.signature.params, decorators, file: fn.file });
  if (hinted) return hinted;
  if (ROUTE_DECORATOR.test(deco)) return e('route', `decorated ${decorators[0]}`);
  if (CLI_DECORATOR.test(deco)) return e('cli', `decorated ${decorators[0]}`);
  if (JOB_DECORATOR.test(deco)) return e('job', `decorated ${decorators[0]}`);
  if (fn.name === TOP_LEVEL) {
    // Top-level code runs on import; it is an entry only in files meant to be run.
    if (SCRIPT_FILE.test(fn.file) || /__name__\s*==\s*['"]__main__['"]/.test(fn.source)) return e('main', 'top-level code of a script');
    return undefined;
  }
  if (callerCount > 0) return undefined;
  if (fn.name === 'main' || fn.name === 'Main' || fn.name === '__main__') return e('main', 'program entry');
  if (/(^|\/)(bin|cmd|commands?)\//.test(fn.file) && fn.kind !== 'method') return e('cli', 'lives in a CLI directory');
  if (/(^|\/)(jobs?|workers?|cron|tasks?)\//.test(fn.file)) return e('job', 'uncalled function in a job/worker directory');
  if ((ROUTE_DIR.test(fn.file) || /^handle[A-Z_]|Handler$|^on[A-Z]/.test(fn.name)) && fn.exported) return e('route', 'exported handler');
  if (fn.exported) return e('public-api', 'exported and not called inside the repo');
  return undefined;
}

// ---------------- Sinks (external effects) ----------------

/** Receiver / callee names that signal an effect in any language (when not bound to a known import). */
const SINK_IDENTS: { category: SinkCategory; label: string; idents: RegExp }[] = [
  { category: 'database', label: 'Database', idents: /^(db|database|prisma|knex|pool|sql|orm|mongo|collection|cursor|conn|connection|jdbcTemplate|entityManager|dbContext|pdo)$/i },
  { category: 'cache', label: 'Cache', idents: /^(redis|cache|memcache)$/i },
  { category: 'network', label: 'Network / HTTP', idents: /^(fetch|axios|http|https|gateway|httpClient|requests|httpx|stripe|webhook|apiClient|restTemplate|webClient|reqwest)$/i },
  { category: 'storage', label: 'Object storage', idents: /^(s3|s3Client|bucket|storage|blob)$/i },
  { category: 'queue', label: 'Queue / events', idents: /^(queue|producer|publisher|kafka|kafkaTemplate|sqs|sns|pubsub|eventBus)$/i },
  { category: 'filesystem', label: 'Filesystem', idents: /^(fs|open|shutil|aiofiles|os\.WriteFile|ioutil)$/ },
  { category: 'process', label: 'Subprocess', idents: /^(subprocess|execa|exec)$/ },
];

const IN_MEMORY_OPS =
  /^(push|pop|shift|unshift|slice|splice|map|filter|forEach|reduce|includes|indexOf|join|concat|sort|reverse|find|some|every|at|length|size|isEmpty|peek|poll|offer|append|appendleft|popleft|extend|goto\w*|current\w*|next|prev|reset|toString)$/;

const SINK_LABELS: Record<string, string> = Object.fromEntries(SINK_IDENTS.map((s) => [s.category, s.label]));

/** Leftmost identifier of a receiver: `this.db.pool` → `db`, `$this->repo` → `repo`, `std::fs` → `std`. */
function rootIdent(call: ExtractedCall): string {
  if (!call.member || !call.object) return call.name;
  const obj = call.object.replace(/^(await\s+)?(this|self|\$this|@)(\.|->|::)?/, '').replace(/^[$@]+/, '');
  return obj.split(/::|->|[.([\s]/)[0];
}

export class SinkClassifier {
  readonly sinks = new Map<string, Sink>();

  constructor(private config: CodeLensConfig) {}

  /** Classify a call that did not resolve to a function in the repo. */
  classify(call: ExtractedCall, file: { language: string; importNames: Record<string, string> }): string | undefined {
    // `a.b().c()`: the inner call is classified on its own; skip the chained one.
    if (call.object?.includes('(')) return undefined;
    const root = rootIdent(call);
    if (!root || root === 'this' || root === 'self') return undefined;
    const spec = file.importNames[root] ?? (call.object && /::|\\/.test(call.object) ? call.object : undefined);
    const pkg = spec && !spec.startsWith('.') && !spec.startsWith('/') ? spec : undefined;

    for (const [category, names] of Object.entries(this.config.sinks ?? {})) {
      if (names.includes(root) || (pkg && names.some((n) => pkg === n || pkg.startsWith(`${n}.`) || pkg.startsWith(`${n}/`) || pkg.startsWith(`${n}::`)))) {
        return this.record(category, SINK_LABELS[category] ?? capitalize(category), call);
      }
    }
    const lang = specForId(file.language);
    if (pkg) {
      for (const [category, re] of Object.entries(lang?.sinks ?? {})) {
        if (re && (re.test(pkg) || re.test(`${pkg}.${call.name}`))) return this.record(category, SINK_LABELS[category] ?? capitalize(category), call);
      }
    }
    const written = call.object ? `${call.object}.${call.name}` : call.name;
    for (const [category, re] of Object.entries(lang?.sinkCalls ?? {})) {
      if (re && re.test(written)) return this.record(category, SINK_LABELS[category] ?? capitalize(category), call);
    }
    // Guessing from a variable's name alone: `queue.push()` on a local array or `cursor.gotoParent()`
    // on a syntax-tree cursor is not I/O, so in-memory operations never count.
    if (!spec && !(call.member && IN_MEMORY_OPS.test(call.name))) {
      for (const rule of SINK_IDENTS) if (rule.idents.test(root)) return this.record(rule.category, rule.label, call);
    }
    return undefined;
  }

  private record(category: string, label: string, call: ExtractedCall): string {
    const id = `sink:${category}`;
    let sink = this.sinks.get(id);
    if (!sink) {
      sink = { id, category, label, examples: [] };
      this.sinks.set(id, sink);
    }
    const example = `${call.member && call.object ? `${call.object}.` : ''}${call.name}()`;
    if (sink.examples.length < 6 && !sink.examples.includes(example)) sink.examples.push(example);
    return id;
  }
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export type { ExtractedFn };
