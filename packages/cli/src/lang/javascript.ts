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
(assignment_expression left: (identifier) @fn.name right: VALUE)
; CommonJS exports stay plain functions: exports.x = …, module.exports.x = …
((assignment_expression left: (member_expression object: (identifier) @_o property: (property_identifier) @fn.name) right: VALUE) (#match? @_o "^(exports|module)$"))
((assignment_expression left: (member_expression object: (member_expression object: (identifier) @_m property: (property_identifier) @_e) property: (property_identifier) @fn.name) right: VALUE) (#eq? @_m "module") (#eq? @_e "exports"))
; obj.method = function …  and  Ctor.prototype.method = function …  are methods of obj / Ctor
((assignment_expression left: (member_expression object: (identifier) @fn.scope property: (property_identifier) @fn.name) right: VALUE) (#not-match? @fn.scope "^(exports|module)$"))
((assignment_expression left: (member_expression object: (member_expression object: (identifier) @fn.scope property: (property_identifier) @_p) property: (property_identifier) @fn.name) right: VALUE) (#eq? @_p "prototype"))
(assignment_expression left: (member_expression object: (this) property: (property_identifier) @fn.name) right: VALUE)

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

const CJS = /\bmodule\.exports\b|\bexports\.\w+\s*=/;
const cjsNames = new WeakMap<object, Set<string> | null>();

/** Names a CommonJS module exports (`module.exports = x`, `= { a, b }`, `exports.y = z`), or null if it is not CommonJS. */
function commonJsExports(fn: SyntaxNode): Set<string> | null {
  const tree = fn.tree;
  if (cjsNames.has(tree)) return cjsNames.get(tree)!;
  const text = tree.rootNode.text;
  let names: Set<string> | null = null;
  if (CJS.test(text)) {
    names = new Set();
    for (const m of text.matchAll(/module\.exports\s*=\s*(\w+)\s*[;\n]/g)) names.add(m[1]);
    for (const m of text.matchAll(/module\.exports\s*=\s*\{([^}]*)\}/g)) for (const n of m[1].matchAll(/(\w+)\s*(?:,|$|\n)|:\s*(\w+)/g)) names.add(n[2] ?? n[1]);
    for (const m of text.matchAll(/exports\.\w+\s*=\s*(\w+)\s*[;\n]/g)) names.add(m[1]);
  }
  cjsNames.set(tree, names);
  return names;
}

function jsExported(fn: SyntaxNode, name: string): boolean {
  for (let n: SyntaxNode | null = fn; n; n = n.parent) {
    if (n.type === 'export_statement') return true;
    if (n.type === 'program') break;
    // Methods of exported classes count as exported surface; locals inside blocks do not.
    if (n.type === 'statement_block' && n !== fn) return false;
  }
  const cjs = commonJsExports(fn);
  if (!cjs) return false;
  // CommonJS: `exports.x = …`, members hung off exported objects (`app.use = …`,
  // `Foo.prototype.bar = …`), and functions named in a `module.exports` assignment.
  const assign = fn.parent?.type === 'assignment_expression' ? fn.parent : null;
  if (assign?.childForFieldName('left')?.type === 'member_expression') return true;
  const decl = fn.type === 'function_declaration' ? fn : fn.parent?.type === 'variable_declarator' ? fn.parent : null;
  return !!decl && cjs.has(name);
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
    exported: (fn: SyntaxNode, { name }: { name: string }) => jsExported(fn, name),
    kind: (fn: SyntaxNode, isMethod: boolean) => (fn.type === 'method_definition' || isMethod ? 'method' : fn.type === 'arrow_function' ? 'arrow' : 'function') as 'method' | 'arrow' | 'function',
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
