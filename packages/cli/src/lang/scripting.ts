// Ruby and PHP.
import { dirname, join, normalize as normalizePath } from 'node:path/posix';
import type { LanguageSpec } from './spec.ts';
import { hasWord, modifiers, trailingPaths } from './util.ts';

export const ruby: LanguageSpec = {
  id: 'ruby',
  name: 'Ruby',
  extensions: ['.rb', '.rake'],
  grammar: 'tree-sitter-ruby.wasm',
  query: `
(method name: (_) @fn.name) @fn
(singleton_method name: (_) @fn.name) @fn

(class name: (constant) @scope.name) @scope
(class name: (scope_resolution name: (constant) @scope.name)) @scope
(module name: (constant) @scope.name) @scope
(module name: (scope_resolution name: (constant) @scope.name)) @scope

(call receiver: (_) @call.receiver method: (identifier) @call.name) @call
(call !receiver method: (identifier) @call.name) @call

((call method: (identifier) @_m arguments: (argument_list (string (string_content) @import.source))) @import
  (#match? @_m "^(require|require_relative|load)$"))

((call method: (identifier) @_m) @throw (#eq? @_m "raise"))
`,
  selfNames: ['self'],
  implicitThis: true,
  resolveImport(from, source) {
    if (source.startsWith('.')) return { stems: [normalizePath(join(dirname(from), source.replace(/\.rb$/, '')))] };
    const stem = source.replace(/\.rb$/, '');
    return { suffixes: [`lib/${stem}`, ...trailingPaths(stem.split('/'))] };
  },
  hooks: {
    mapImport: (node, source) => (/^require_relative\b/.test(node.text) && !source.startsWith('.') ? `./${source}` : source),
  },
  testFile: /_spec\.rb$|_test\.rb$|(^|\/)(spec|test)\//,
  sinkCalls: {
    network: /^(Net::HTTP|Faraday|HTTParty|RestClient|Excon|Typhoeus|HTTP)\b/,
    database: /^(ActiveRecord::Base|PG|Mysql2|Sequel|SQLite3|Mongo::Client)\b|^(db|connection|conn)\./,
    cache: /^(Redis|Rails\.cache|Dalli)\b/,
    filesystem: /^(File|FileUtils|Dir|IO)\.(write|read|open|delete|rm|mkdir|mv|cp|binwrite|foreach)/,
    process: /^(system|spawn|exec|Open3|Process\.spawn)\b/,
    queue: /^(Sidekiq|Resque|Kafka|Bunny|Aws::SQS)\b|\.perform_(async|later)$/,
    storage: /^Aws::S3\b/,
  },
};

export const php: LanguageSpec = {
  id: 'php',
  name: 'PHP',
  extensions: ['.php'],
  grammar: 'tree-sitter-php.wasm',
  query: `
(function_definition name: (name) @fn.name) @fn
(method_declaration name: (name) @fn.name) @fn

(class_declaration name: (name) @scope.name) @scope
(interface_declaration name: (name) @scope.name) @scope
(trait_declaration name: (name) @scope.name) @scope

(function_call_expression function: (name) @call.name) @call
(member_call_expression object: (_) @call.receiver name: (name) @call.name) @call
(scoped_call_expression scope: (_) @call.receiver name: (name) @call.name) @call
(object_creation_expression (name) @call.name) @call

(namespace_use_clause (qualified_name (name) @import.name .) @import.source) @import

(throw_expression) @throw
`,
  selfNames: ['$this', 'self', 'static', 'parent'],
  resolveImport: (_from, source) => ({ suffixes: trailingPaths(source.replace(/^\\/, '').split('\\')) }),
  hooks: {
    exported: (fn, { nestedInFunction }) => !nestedInFunction && !hasWord(modifiers(fn), 'private', 'protected'),
  },
  testFile: /Test\.php$|(^|\/)tests?\//,
  sinks: {
    network: /^(GuzzleHttp|Symfony\\Component\\HttpClient|Illuminate\\Support\\Facades\\Http)/,
    database: /^(PDO|Doctrine|Illuminate\\Database|Illuminate\\Support\\Facades\\DB|MongoDB)/,
    cache: /^(Predis|Redis|Illuminate\\Support\\Facades\\(Cache|Redis))/,
    storage: /^(Aws\\S3|Illuminate\\Support\\Facades\\Storage|League\\Flysystem)/,
    queue: /^(Illuminate\\Support\\Facades\\Queue|PhpAmqpLib|RdKafka)/,
  },
  sinkCalls: {
    network: /^(curl_exec|curl_init|file_get_contents|fsockopen|Http::)/,
    filesystem: /^(fopen|fwrite|file_put_contents|unlink|mkdir|rename|Storage::)/,
    process: /^(exec|shell_exec|system|passthru|proc_open|popen)$/,
    database: /^(mysqli_query|pg_query|DB::|\$(pdo|db|conn)\.)/,
  },
};
