import type { LanguageSpec } from './spec.ts';
import { dottedImport, hasWord, modifiers } from './util.ts';

export const csharp: LanguageSpec = {
  id: 'csharp',
  name: 'C#',
  extensions: ['.cs'],
  grammar: 'tree-sitter-c_sharp.wasm',
  query: `
(method_declaration name: (identifier) @fn.name) @fn
(constructor_declaration name: (identifier) @fn.name) @fn
(local_function_statement name: (identifier) @fn.name) @fn

(class_declaration name: (identifier) @scope.name) @scope
(struct_declaration name: (identifier) @scope.name) @scope
(interface_declaration name: (identifier) @scope.name) @scope
(record_declaration name: (identifier) @scope.name) @scope

(invocation_expression function: (identifier) @call.name) @call
(invocation_expression function: (member_access_expression expression: (_) @call.receiver name: (identifier) @call.name)) @call
(object_creation_expression type: (identifier) @call.name) @call

(using_directive (qualified_name) @import.source) @import
(using_directive (identifier) @import.source) @import

(throw_statement) @throw
(throw_expression) @throw
`,
  selfNames: ['this', 'base'],
  implicitThis: true,
  // A namespace spans many files and directories; same-directory is the closest syntactic proxy.
  sameDirectoryVisible: true,
  resolveImport: (_from, source) => ({ dirSuffixes: dottedImport(source).dirSuffixes }),
  hooks: {
    returnType: (fn) => (fn.childForFieldName('returns') ?? fn.childForFieldName('type'))?.text,
    exported: (fn) => fn.parent?.parent?.type === 'interface_declaration' || hasWord(modifiers(fn), 'public', 'protected'),
  },
  testFile: /Tests?\.cs$|(^|\/)[^/]*\.Tests?\//,
  sinkCalls: {
    database: /^(_?db|_?context|_?dbContext|_?connection|SqlCommand|NpgsqlCommand|_?repository)\./i,
    network: /^(_?httpClient|_?client|HttpClient|WebRequest|RestClient)\.(Get|Post|Put|Patch|Delete|Send)\w*Async$|^HttpClient\./,
    filesystem: /^(File|Directory|FileStream|Path)\.(Write|Read|Open|Create|Delete|Move|Copy|Append)/,
    process: /^Process\.Start$/,
  },
};
