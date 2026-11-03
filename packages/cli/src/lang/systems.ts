// Go, Rust, C and C++.
import { dirname, join, normalize as normalizePath } from 'node:path/posix';
import type { Param } from '../types.ts';
import type { LanguageSpec, SyntaxNode } from './spec.ts';
import { modifiers, trailingPaths } from './util.ts';

// ---------------- Go ----------------

function goParams(fn: SyntaxNode): Param[] {
  const out: Param[] = [];
  for (const p of fn.childForFieldName('parameters')?.namedChildren ?? []) {
    const type = p.childForFieldName('type')?.text;
    const names = p.childrenForFieldName('name');
    const variadic = p.type === 'variadic_parameter_declaration';
    if (!names.length) out.push({ name: '_', type, optional: variadic });
    for (const n of names) out.push({ name: n.text, type, optional: variadic });
  }
  return out;
}

const GO_ROUTE_TYPES = /http\.ResponseWriter|\*?gin\.Context|echo\.Context|\*?fiber\.Ctx|\*?chi\.Mux/;

export const go: LanguageSpec = {
  id: 'go',
  name: 'Go',
  extensions: ['.go'],
  grammar: 'tree-sitter-go.wasm',
  query: `
(function_declaration name: (identifier) @fn.name) @fn
(method_declaration
  receiver: (parameter_list (parameter_declaration name: (identifier) @fn.self type: [(type_identifier) @fn.scope (pointer_type (type_identifier) @fn.scope)]))
  name: (field_identifier) @fn.name) @fn
(method_declaration
  receiver: (parameter_list (parameter_declaration !name type: [(type_identifier) @fn.scope (pointer_type (type_identifier) @fn.scope)]))
  name: (field_identifier) @fn.name) @fn

(call_expression function: (identifier) @call.name) @call
(call_expression function: (selector_expression operand: (_) @call.receiver field: (field_identifier) @call.name)) @call

(import_spec path: (_) @import.source) @import
(import_spec name: (package_identifier) @import.name path: (_) @import.source) @import

((call_expression function: (identifier) @_p) @throw (#eq? @_p "panic"))
`,
  sameDirectoryVisible: true,
  resolveImport: (_from, source) => ({ dirSuffixes: trailingPaths(source.split('/')) }),
  hooks: {
    params: goParams,
    exported: (_fn, { name }) => /^[A-Z]/.test(name),
    // The last path element, minus a major-version suffix: `github.com/x/y/v2` binds `y`.
    defaultImportName: (source) => source.split('/').filter((s) => !/^v\d+$/.test(s)).at(-1)?.replace(/^go-|-go$/g, '').replace(/[^\w]/g, ''),
    entry: ({ name, params }) => {
      if (/^(Test|Benchmark|Fuzz)[A-Z_]/.test(name) && params.some((p) => /\*testing\.[TBF]\b/.test(p.type ?? ''))) return { kind: 'test', reason: 'Go test function' };
      if (params.some((p) => GO_ROUTE_TYPES.test(p.type ?? ''))) return { kind: 'route', reason: 'HTTP handler signature' };
      return undefined;
    },
  },
  testFile: /_test\.go$/,
  sinks: {
    database: /^(database\/sql|github\.com\/jmoiron\/sqlx|gorm\.io\/gorm|github\.com\/jackc\/pgx.*|github\.com\/lib\/pq|go\.mongodb\.org\/mongo-driver.*|github\.com\/aws\/aws-sdk-go-v2\/service\/dynamodb|entgo\.io\/ent)$/,
    cache: /^(github\.com\/(go-redis|redis)\/go-redis.*|github\.com\/redis\/rueidis|github\.com\/bradfitz\/gomemcache.*)$/,
    network: /^(net\/http|net|google\.golang\.org\/grpc|github\.com\/go-resty\/resty.*)$/,
    storage: /^(github\.com\/aws\/aws-sdk-go-v2\/service\/s3|cloud\.google\.com\/go\/storage|github\.com\/minio\/minio-go.*)$/,
    queue: /^(github\.com\/segmentio\/kafka-go|github\.com\/IBM\/sarama|github\.com\/Shopify\/sarama|github\.com\/confluentinc\/confluent-kafka-go.*|cloud\.google\.com\/go\/pubsub|github\.com\/aws\/aws-sdk-go-v2\/service\/(sqs|sns|kinesis)|github\.com\/nats-io\/nats\.go|github\.com\/rabbitmq\/amqp091-go)$/,
    filesystem: /^os\.(WriteFile|ReadFile|Create|Open|OpenFile|Remove|RemoveAll|Mkdir|MkdirAll|Rename|ReadDir)$|^io\/ioutil/,
    process: /^os\/exec$/,
  },
};

// ---------------- Rust ----------------

export const rust: LanguageSpec = {
  id: 'rust',
  name: 'Rust',
  extensions: ['.rs'],
  grammar: 'tree-sitter-rust.wasm',
  query: `
(function_item name: (identifier) @fn.name) @fn

(impl_item type: (type_identifier) @scope.name) @scope
(impl_item type: (generic_type type: (type_identifier) @scope.name)) @scope
(trait_item name: (type_identifier) @scope.name) @scope

(call_expression function: (identifier) @call.name) @call
(call_expression function: (field_expression value: (_) @call.receiver field: (field_identifier) @call.name)) @call
(call_expression function: (scoped_identifier path: (_) @call.receiver name: (identifier) @call.name)) @call

(use_declaration argument: (scoped_identifier name: (identifier) @import.name) @import.source) @import
(use_declaration argument: (identifier) @import.name @import.source) @import
(use_declaration argument: (use_as_clause path: (_) @import.source alias: (identifier) @import.name)) @import
(use_declaration argument: (scoped_use_list path: (_) @import.source list: (use_list (identifier) @import.name))) @import

((macro_invocation macro: (identifier) @_m) @throw (#match? @_m "^(panic|unreachable|todo|unimplemented)$"))
`,
  selfNames: ['self', 'Self'],
  resolveImport(_from, source) {
    const segs = source.split('::').filter((s) => !['crate', 'self', 'super'].includes(s));
    if (source.startsWith('std::') || source.startsWith('core::') || source.startsWith('alloc::')) return null;
    // `crate::billing::charge` may live in billing/charge.rs, billing.rs, or billing/mod.rs.
    const suffixes: string[] = [];
    for (let k = segs.length; k > 0; k--) {
      const p = segs.slice(0, k).join('/');
      suffixes.push(p, `${p}/mod`);
    }
    return { suffixes };
  },
  hooks: {
    exported: (fn) => fn.namedChildren.some((c) => c.type === 'visibility_modifier' && c.text.startsWith('pub')),
    bindImport: (source, local) => (source === local || source.endsWith(`::${local}`) ? source : `${source}::${local}`),
    entry: ({ name, decorators }) => {
      if (name === 'main' && decorators.some((d) => /#\[(tokio|async_std|actix_web)::main\]/.test(d))) return { kind: 'main', reason: 'async runtime entry' };
      return undefined;
    },
  },
  testFile: /(^|\/)tests\/.*\.rs$|(^|\/)benches\//,
  sinks: {
    database: /^(sqlx|diesel|tokio_postgres|postgres|rusqlite|mongodb|sea_orm|aws_sdk_dynamodb)(::|$)/,
    cache: /^(redis|deadpool_redis|memcache)(::|$)/,
    network: /^(reqwest|hyper|ureq|surf|tonic|isahc|awc)(::|$)/,
    storage: /^(aws_sdk_s3|rusoto_s3|object_store)(::|$)/,
    queue: /^(rdkafka|lapin|async_nats|aws_sdk_sqs|aws_sdk_sns|aws_sdk_kinesis)(::|$)/,
    filesystem: /^(std::fs|tokio::fs|async_std::fs)(::|$)/,
    process: /^(std::process|tokio::process)(::|$)/,
  },
};

// ---------------- C / C++ ----------------

const includeTarget = (from: string, source: string) => {
  const stem = source.replace(/\.(h|hh|hpp|hxx|h\+\+|inc)$/, '');
  return { stems: [normalizePath(join(dirname(from), stem))], suffixes: [stem, ...trailingPaths(stem.split('/')).slice(1)] };
};

const C_SINK_CALLS = {
  network: /^(curl_|socket$|connect$|send$|recv$|getaddrinfo$)/,
  filesystem: /^(fopen|fwrite|fread|fputs|fprintf|open|unlink|remove|mkdir|rename|opendir)$/,
  process: /^(system|popen|fork|execv|execvp|execve|execl|execlp|posix_spawn)$/,
  database: /^(sqlite3_(exec|prepare|step)|PQexec|PQconnectdb|mysql_query|mysql_real_query|mysql_real_connect)/,
};

const notStatic = (fn: SyntaxNode) => !/\bstatic\b/.test(modifiers(fn));

export const c: LanguageSpec = {
  id: 'c',
  name: 'C',
  extensions: ['.c'],
  grammar: 'tree-sitter-c.wasm',
  query: `
(function_definition declarator: (function_declarator declarator: (identifier) @fn.name)) @fn
(function_definition declarator: (pointer_declarator declarator: (function_declarator declarator: (identifier) @fn.name))) @fn

(call_expression function: (identifier) @call.name) @call
(call_expression function: (field_expression argument: (_) @call.receiver field: (field_identifier) @call.name)) @call

(preproc_include path: (_) @import.source) @import
`,
  resolveImport: includeTarget,
  hooks: { exported: notStatic, returnType: (fn) => fn.childForFieldName('type')?.text },
  testFile: /(^|\/)tests?\/|_test\.c$|test_[^/]*\.c$/,
  sinkCalls: C_SINK_CALLS,
};

export const cpp: LanguageSpec = {
  id: 'cpp',
  name: 'C++',
  extensions: ['.cpp', '.cc', '.cxx', '.c++', '.hpp', '.hh', '.hxx', '.h'],
  grammar: 'tree-sitter-cpp.wasm',
  query: `
(function_definition declarator: (function_declarator declarator: (identifier) @fn.name)) @fn
(function_definition declarator: (function_declarator declarator: (field_identifier) @fn.name)) @fn
(function_definition declarator: (function_declarator declarator: (qualified_identifier scope: (_) @fn.scope name: (identifier) @fn.name))) @fn
(function_definition declarator: (pointer_declarator declarator: (function_declarator declarator: (identifier) @fn.name))) @fn
(function_definition declarator: (reference_declarator (function_declarator declarator: (identifier) @fn.name))) @fn

(class_specifier name: (type_identifier) @scope.name) @scope
(struct_specifier name: (type_identifier) @scope.name) @scope
(namespace_definition name: (_) @namespace.name) @namespace

(call_expression function: (identifier) @call.name) @call
(call_expression function: (field_expression argument: (_) @call.receiver field: (field_identifier) @call.name)) @call
(call_expression function: (qualified_identifier scope: (_) @call.receiver name: (identifier) @call.name)) @call

(preproc_include path: (_) @import.source) @import

(throw_statement) @throw
`,
  selfNames: ['this'],
  implicitThis: true,
  resolveImport: includeTarget,
  hooks: { exported: notStatic, returnType: (fn) => fn.childForFieldName('type')?.text },
  testFile: /(^|\/)tests?\/|_test\.(cc|cpp)$|_unittest\.(cc|cpp)$/,
  sinkCalls: C_SINK_CALLS,
};
