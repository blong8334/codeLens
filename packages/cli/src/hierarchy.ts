import { basename, dirname } from 'node:path/posix';
import { firstMatch, matches, type CodeLensConfig } from './config.ts';
import type { ExtractedCall, ExtractedFn } from './parse.ts';
import type { EntryKind, FnNode, Group, Sink, SinkCategory } from './types.ts';

// ---------------- Grouping: file → module → system ----------------

/** Directory names that organize code without naming a subsystem. */
const GENERIC_DIRS = new Set(['src', 'lib', 'libs', 'app', 'apps', 'packages', 'source', 'internal', 'pkg', 'modules', 'code', 'main', 'java', 'python']);
const MANIFESTS = /(^|\/)(package\.json|pyproject\.toml|setup\.py|go\.mod|Cargo\.toml)$/;

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
    const meaningful = segments.find((s) => !GENERIC_DIRS.has(s));
    return { name: meaningful ?? segments.at(-1) ?? '(root)', auto: true };
  }

  module(path: string): { name: string; auto: boolean } {
    const configured = firstMatch(this.config.modules, path);
    if (configured) return { name: configured, auto: false };
    const pkg = this.packageFor(path);
    const dir = dirname(path);
    const rel = pkg ? dir.slice(pkg.dir.length + 1) || '.' : dir;
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

const TEST_FILE = /(\.|_)(test|spec)\.[cm]?[jt]sx?$|(^|\/)(__tests__|tests?)\/|(^|\/)test_[^/]*\.py$|_test\.py$/;
const ROUTE_DIR = /(^|\/)(routes?|api|handlers?|controllers?|endpoints?|views|pages)\//;
const ROUTE_DECORATOR = /@\w*\.?(route|get|post|put|patch|delete|api_view|websocket)\b/i;
const CLI_DECORATOR = /@\w*\.?(command|group|cli)\b/i;
const JOB_DECORATOR = /@\w*\.?(task|shared_task|cron|schedule|scheduled_job|periodic_task)\b/i;

export function detectEntry(
  fn: Pick<FnNode, 'file' | 'qualifiedName' | 'name' | 'exported'>,
  decorators: string[],
  callerCount: number,
  config: CodeLensConfig,
): FnNode['entry'] {
  const e = (kind: EntryKind, reason: string) => ({ kind, reason });
  if (config.entryPoints?.some((p) => matches(p, fn.file, fn.qualifiedName))) return e('config', 'listed in .codelens.json');
  if (TEST_FILE.test(fn.file)) return e('test', 'test file');
  const deco = decorators.join(' ');
  if (ROUTE_DECORATOR.test(deco)) return e('route', `decorated ${decorators[0]}`);
  if (CLI_DECORATOR.test(deco)) return e('cli', `decorated ${decorators[0]}`);
  if (JOB_DECORATOR.test(deco)) return e('job', `decorated ${decorators[0]}`);
  if (callerCount > 0) return undefined;
  if (fn.name === 'main' || fn.name === '__main__') return e('main', 'program entry');
  if (/(^|\/)(bin|cli|commands?)\//.test(fn.file)) return e('cli', 'lives in a CLI directory');
  if (/(^|\/)(jobs?|workers?|cron|tasks?)\//.test(fn.file)) return e('job', 'uncalled function in a job/worker directory');
  if ((ROUTE_DIR.test(fn.file) || /^handle[A-Z_]|Handler$|^on[A-Z]/.test(fn.name)) && fn.exported) return e('route', 'exported handler');
  if (fn.exported) return e('public-api', 'exported and not called inside the repo');
  return undefined;
}

// ---------------- Sinks (external effects) ----------------

interface SinkRule {
  category: SinkCategory;
  label: string;
  packages: RegExp;
  idents: RegExp;
}

const SINK_RULES: SinkRule[] = [
  {
    category: 'database',
    label: 'Database',
    packages: /^(pg|postgres|mysql2?|sqlite3?|better-sqlite3|mongodb|mongoose|@prisma\/client|prisma|knex|typeorm|sequelize|drizzle-orm|kysely|sqlalchemy|psycopg2?|pymongo|asyncpg|peewee|django\.db)$/,
    idents: /^(db|database|prisma|knex|pool|sql|orm|mongo|collection|cursor|conn|connection)$/i,
  },
  { category: 'cache', label: 'Cache', packages: /^(redis|ioredis|memcached|node-cache|keyv|@upstash\/redis)$/, idents: /^(redis|cache|memcache)$/i },
  {
    category: 'network',
    label: 'Network / HTTP',
    packages: /^(axios|node-fetch|got|undici|ky|superagent|requests|httpx|aiohttp|urllib3?|https?|node:https?|@grpc\/.*|grpc|stripe|twilio|@sendgrid\/.*|openai|@anthropic-ai\/sdk)$/,
    idents: /^(fetch|axios|http|https|gateway|httpClient|requests|httpx|stripe|webhook|apiClient)$/i,
  },
  {
    category: 'storage',
    label: 'Object storage',
    packages: /^(@aws-sdk\/client-s3|@google-cloud\/storage|@azure\/storage-blob|boto3|minio)$/,
    idents: /^(s3|bucket|storage|blob)$/i,
  },
  {
    category: 'queue',
    label: 'Queue / events',
    packages: /^(kafkajs|amqplib|bullmq?|@aws-sdk\/client-sqs|@aws-sdk\/client-sns|@google-cloud\/pubsub|celery|kombu|pika|nats)$/,
    idents: /^(queue|producer|publisher|kafka|sqs|sns|pubsub|eventBus)$/i,
  },
  {
    category: 'filesystem',
    label: 'Filesystem',
    packages: /^(node:)?(fs|fs\/promises)$|^(fs-extra|shutil|pathlib|aiofiles)$/,
    idents: /^(fs|open|shutil|aiofiles)$/,
  },
  { category: 'process', label: 'Subprocess', packages: /^(node:)?child_process$|^(execa|subprocess)$/, idents: /^(subprocess|execa)$/ },
];

/** Leftmost identifier of a receiver: `this.db.pool` → `db`, `fs.promises` → `fs`. */
function rootIdent(call: ExtractedCall): string {
  if (!call.member || !call.object) return call.name;
  const obj = call.object.replace(/^(await\s+)?(this|self)\./, '');
  return obj.split(/[.([\s]/)[0];
}

export class SinkClassifier {
  readonly sinks = new Map<string, Sink>();

  constructor(private config: CodeLensConfig) {}

  /** Classify a call that did not resolve to a function in the repo. */
  classify(call: ExtractedCall, importNames: Record<string, string>): string | undefined {
    // `a.b().c()`: the inner call is classified on its own; skip the chained one.
    if (call.object?.includes('(')) return undefined;
    const root = rootIdent(call);
    if (!root || root === 'this' || root === 'self') return undefined;
    const spec = importNames[root];
    const pkg = spec && !spec.startsWith('.') && !spec.startsWith('/') ? spec : undefined;

    for (const [category, names] of Object.entries(this.config.sinks ?? {})) {
      if (names.includes(root) || (pkg && names.includes(pkg))) return this.record(category, capitalize(category), call);
    }
    for (const rule of SINK_RULES) {
      if ((pkg && rule.packages.test(pkg)) || (!spec && rule.idents.test(root))) return this.record(rule.category, rule.label, call);
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
