import { dirname, join, normalize as normalizePath } from 'node:path/posix';
import type { Param } from '../types.ts';
import type { LanguageSpec, SyntaxNode } from './spec.ts';

const fnValue = (types: string[]) => `[${types.map((t) => `(${t})`).join(' ')}] @fn`;

/** JavaScript, TypeScript and TSX share one grammar family; only a few node names differ. */
function jsQuery(dialect: 'js' | 'ts'): string {
  const values = fnValue(dialect === 'ts' ? ['arrow_function', 'function_expression'] : ['arrow_function', 'function_expression']);
  const field = dialect === 'ts' ? '(public_field_definition name: (_) @fn.name value: VALUE)' : '(field_definition property: (_) @fn.name value: VALUE)';
  return `
(function_declaration name: (identifier) @fn.name) @fn
(generator_function_declaration name: (identifier) @fn.name) @fn
(method_definition name: (_) @fn.name) @fn
(variable_declarator name: (identifier) @fn.name value: VALUE)
(pair key: (_) @fn.name value: VALUE)
${field}
(assignment_expression left: (member_expression property: (property_identifier) @fn.name) right: VALUE)
(assignment_expression left: (identifier) @fn.name right: VALUE)

(class_declaration name: (_) @scope.name) @scope
(class name: (_) @scope.name) @scope
${dialect === 'ts' ? '(abstract_class_declaration name: (_) @scope.name) @scope' : ''}

(call_expression function: (identifier) @call.name) @call
(call_expression function: (member_expression object: (_) @call.receiver property: (property_identifier) @call.name)) @call
(new_expression constructor: (identifier) @call.name) @call
(new_expression constructor: (member_expression object: (_) @call.receiver property: (property_identifier) @call.name)) @call

(import_statement source: (string) @import.source) @import
(import_statement (import_clause (identifier) @import.name) source: (string) @import.source) @import
(import_statement (import_clause (namespace_import (identifier) @import.name)) source: (string) @import.source) @import
(import_statement (import_clause (named_imports (import_specifier name: (identifier) @import.name !alias))) source: (string) @import.source) @import
(import_statement (import_clause (named_imports (import_specifier alias: (identifier) @import.name))) source: (string) @import.source) @import
(export_statement source: (string) @import.source) @import
(variable_declarator
  name: (identifier) @import.name
  value: (call_expression function: (identifier) @_req arguments: (arguments (string) @import.source))
  (#eq? @_req "require")) @import
(variable_declarator
  name: (object_pattern (shorthand_property_identifier_pattern) @import.name)
  value: (call_expression function: (identifier) @_req arguments: (arguments (string) @import.source))
  (#eq? @_req "require")) @import

(throw_statement) @throw
`.replaceAll('VALUE', values);
}

function jsParams(fn: SyntaxNode): Param[] {
  const list = fn.childForFieldName('parameters') ?? fn.childForFieldName('parameter');
  if (!list) return [];
  if (list.type === 'identifier') return [{ name: list.text, optional: false }];
  const out: Param[] = [];
  for (const p of list.namedChildren) {
    if (p.type === 'comment') continue;
    const pattern = p.childForFieldName('pattern') ?? p;
    const type = p.childForFieldName('type');
    const hasDefault = !!p.childForFieldName('value') || p.type === 'assignment_pattern';
    out.push({
      name: (p.type === 'assignment_pattern' ? p.childForFieldName('left') : pattern)?.text ?? p.text,
      type: type ? type.text.replace(/^:\s*/, '') : undefined,
      optional: p.type === 'optional_parameter' || hasDefault || pattern.type === 'rest_pattern',
    });
  }
  return out;
}

function jsExported(fn: SyntaxNode): boolean {
  for (let n: SyntaxNode | null = fn; n; n = n.parent) {
    if (n.type === 'export_statement') return true;
    if (n.type === 'program') return false;
    // Methods of exported classes count as exported surface; locals inside blocks do not.
    if (n.type === 'statement_block' && n !== fn) return false;
  }
  return false;
}

const stripExt = (p: string) => p.replace(/\.(d\.)?[mc]?[jt]sx?$/, '');

const jsFamily = {
  selfNames: ['this'],
  resolveImport(from: string, source: string) {
    if (!source.startsWith('.')) return null;
    const target = stripExt(normalizePath(join(dirname(from), source)));
    return { stems: [target, `${target}/index`] };
  },
  testFile: /(\.|_)(test|spec)\.[cm]?[jt]sx?$|(^|\/)__tests__\//,
  sinks: {
    database: /^(pg|postgres|mysql2?|sqlite3?|better-sqlite3|mongodb|mongoose|@prisma\/client|prisma|knex|typeorm|sequelize|drizzle-orm|kysely|@planetscale\/database|@neondatabase\/serverless)$/,
    cache: /^(redis|ioredis|memcached|node-cache|keyv|@upstash\/redis)$/,
    network: /^(axios|node-fetch|got|undici|ky|superagent|https?|node:https?|@grpc\/.*|stripe|twilio|@sendgrid\/.*|openai|@anthropic-ai\/sdk)$/,
    storage: /^(@aws-sdk\/client-s3|@google-cloud\/storage|@azure\/storage-blob|minio)$/,
    queue: /^(kafkajs|amqplib|bullmq?|@aws-sdk\/client-sqs|@aws-sdk\/client-sns|@google-cloud\/pubsub|nats)$/,
    filesystem: /^(node:)?(fs|fs\/promises)$|^fs-extra$/,
    process: /^(node:)?child_process$|^execa$/,
  },
  hooks: {
    params: jsParams,
    exported: (fn: SyntaxNode) => jsExported(fn),
    kind: (fn: SyntaxNode) => (fn.type === 'method_definition' ? 'method' : fn.type === 'arrow_function' ? 'arrow' : 'function') as 'method' | 'arrow' | 'function',
  },
} satisfies Partial<LanguageSpec>;

export const javascript: LanguageSpec = {
  id: 'javascript',
  name: 'JavaScript',
  extensions: ['.js', '.mjs', '.cjs', '.jsx'],
  grammar: 'tree-sitter-javascript.wasm',
  query: jsQuery('js'),
  ...jsFamily,
};

export const typescript: LanguageSpec = {
  id: 'typescript',
  name: 'TypeScript',
  extensions: ['.ts', '.mts', '.cts'],
  exclude: /\.d\.[mc]?ts$/,
  grammar: 'tree-sitter-typescript.wasm',
  query: jsQuery('ts'),
  ...jsFamily,
};

export const tsx: LanguageSpec = {
  id: 'tsx',
  name: 'TSX',
  extensions: ['.tsx'],
  grammar: 'tree-sitter-tsx.wasm',
  query: jsQuery('ts'),
  ...jsFamily,
};
