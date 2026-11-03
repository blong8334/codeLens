import { dirname, join, normalize as normalizePath } from 'node:path/posix';
import type { Param } from '../types.ts';
import { cleanComment } from './engine.ts';
import type { LanguageSpec, SyntaxNode } from './spec.ts';

function pyParams(fn: SyntaxNode): Param[] {
  const out: Param[] = [];
  for (const p of fn.childForFieldName('parameters')?.namedChildren ?? []) {
    if (p.type === 'comment') continue;
    out.push({
      name: (p.childForFieldName('name') ?? p.namedChildren[0] ?? p).text,
      type: p.childForFieldName('type')?.text,
      optional: p.type.startsWith('default') || p.type.startsWith('typed_default') || p.type.includes('splat'),
    });
  }
  return out;
}

function docstring(fn: SyntaxNode): string | undefined {
  const first = fn.childForFieldName('body')?.namedChildren[0];
  const str = first?.type === 'expression_statement' ? first.namedChildren[0] : null;
  if (str?.type !== 'string') return undefined;
  return cleanComment(str.text.replace(/^[rubf]*(?:"{3}|'{3}|"|')|(?:"{3}|'{3}|"|')$/gi, ''));
}

export const python: LanguageSpec = {
  id: 'python',
  name: 'Python',
  extensions: ['.py', '.pyi'],
  grammar: 'tree-sitter-python.wasm',
  query: `
(function_definition name: (identifier) @fn.name) @fn
(class_definition name: (identifier) @scope.name) @scope

(call function: (identifier) @call.name) @call
(call function: (attribute object: (_) @call.receiver attribute: (identifier) @call.name)) @call

(import_from_statement module_name: (_) @import.source) @import
(import_from_statement module_name: (_) @import.source name: (dotted_name) @import.name) @import
(import_from_statement module_name: (_) @import.source name: (aliased_import alias: (identifier) @import.name)) @import
(import_statement name: (dotted_name . (identifier) @import.name) @import.source) @import
(import_statement name: (aliased_import name: (dotted_name) @import.source alias: (identifier) @import.name)) @import

(raise_statement) @throw
`,
  selfNames: ['self', 'cls'],
  resolveImport(from, source) {
    const dots = source.match(/^\.*/)![0].length;
    const rest = source.slice(dots).replace(/\./g, '/');
    const stems: string[] = [];
    if (dots) {
      let dir = dirname(from);
      for (let i = 1; i < dots; i++) dir = dirname(dir);
      stems.push(normalizePath(join(dir, rest)));
    } else {
      stems.push(rest, normalizePath(join(dirname(from), rest)));
    }
    return { stems: stems.flatMap((s) => [s, `${s}/__init__`]), suffixes: dots ? undefined : [rest] };
  },
  testFile: /(^|\/)test_[^/]*\.py$|_test\.py$|(^|\/)tests?\/.*\.py$/,
  sinks: {
    database: /^(sqlalchemy|psycopg2?|psycopg|pymongo|asyncpg|peewee|sqlite3|pymysql|django\.db.*|motor)$/,
    cache: /^(redis|pymemcache|aiocache)$/,
    network: /^(requests|httpx|aiohttp|urllib3?|urllib\.request|http\.client|grpc|stripe|twilio|openai|anthropic|boto3)$/,
    storage: /^(google\.cloud\.storage|azure\.storage\.blob|minio)$/,
    queue: /^(celery|kombu|pika|kafka|confluent_kafka|aiokafka)$/,
    filesystem: /^(shutil|pathlib|aiofiles)$/,
    process: /^subprocess$/,
  },
  hooks: {
    params: pyParams,
    exported: (_fn, { name, nestedInFunction }) => !nestedInFunction && !name.startsWith('_'),
    innerDoc: docstring,
  },
};
