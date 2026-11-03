import type { Param } from '../types.ts';
import type { LanguageSpec, SyntaxNode } from './spec.ts';
import { dottedImport, hasWord, JVM_SINKS, JVM_TEST_FILE, modifiers } from './util.ts';

const inInterface = (fn: SyntaxNode) => fn.parent?.parent?.type === 'interface_declaration';

export const java: LanguageSpec = {
  id: 'java',
  name: 'Java',
  extensions: ['.java'],
  grammar: 'tree-sitter-java.wasm',
  query: `
(method_declaration name: (identifier) @fn.name) @fn
(constructor_declaration name: (identifier) @fn.name) @fn

(class_declaration name: (identifier) @scope.name) @scope
(interface_declaration name: (identifier) @scope.name) @scope
(enum_declaration name: (identifier) @scope.name) @scope
(record_declaration name: (identifier) @scope.name) @scope

(method_invocation object: (_) @call.receiver name: (identifier) @call.name) @call
(method_invocation !object name: (identifier) @call.name) @call
(object_creation_expression type: (type_identifier) @call.name) @call

(import_declaration (scoped_identifier name: (identifier) @import.name) @import.source) @import
(import_declaration (scoped_identifier) @import.source (asterisk)) @import

(throw_statement) @throw
`,
  selfNames: ['this', 'super'],
  implicitThis: true,
  sameDirectoryVisible: true,
  resolveImport: (_from, source) => dottedImport(source),
  hooks: {
    mapImport: (node, source) => (node.namedChildren.some((c) => c.type === 'asterisk') ? `${source}.*` : source),
    returnType: (fn) => fn.childForFieldName('type')?.text,
    exported: (fn) => inInterface(fn) || hasWord(modifiers(fn), 'public', 'protected'),
  },
  testFile: JVM_TEST_FILE,
  sinks: JVM_SINKS,
};

function kotlinParams(fn: SyntaxNode): Param[] {
  const list = fn.namedChildren.find((c) => c.type === 'function_value_parameters');
  const out: Param[] = [];
  for (const p of list?.namedChildren ?? []) {
    if (p.type !== 'parameter') continue;
    const name = p.namedChildren.find((c) => c.type === 'simple_identifier');
    const type = p.namedChildren.find((c) => /type/.test(c.type));
    // A default value follows the parameter as `= expr` inside the list.
    const next = p.nextSibling;
    out.push({ name: name?.text ?? p.text, type: type?.text, optional: next?.type === '=' });
  }
  return out;
}

export const kotlin: LanguageSpec = {
  id: 'kotlin',
  name: 'Kotlin',
  extensions: ['.kt', '.kts'],
  grammar: 'tree-sitter-kotlin.wasm',
  query: `
(function_declaration (simple_identifier) @fn.name) @fn

(class_declaration (type_identifier) @scope.name) @scope
(object_declaration (type_identifier) @scope.name) @scope

(call_expression (simple_identifier) @call.name) @call
(call_expression (navigation_expression (_) @call.receiver (navigation_suffix (simple_identifier) @call.name))) @call

(import_header (identifier (simple_identifier) @import.name .) @import.source) @import

((jump_expression) @throw (#match? @throw "^throw"))
`,
  selfNames: ['this', 'super'],
  implicitThis: true,
  sameDirectoryVisible: true,
  resolveImport: (_from, source) => dottedImport(source),
  hooks: {
    params: kotlinParams,
    body: (fn) => fn.namedChildren.find((c) => c.type === 'function_body') ?? null,
    returnType: (fn) => {
      const kids = fn.namedChildren;
      const i = kids.findIndex((c) => c.type === 'function_value_parameters');
      const r = kids.slice(i + 1).find((c) => /type$/.test(c.type));
      return r?.text;
    },
    exported: (fn, { nestedInFunction }) => !nestedInFunction && !hasWord(modifiers(fn), 'private', 'internal', 'protected'),
  },
  testFile: JVM_TEST_FILE,
  sinks: JVM_SINKS,
};

export const scala: LanguageSpec = {
  id: 'scala',
  name: 'Scala',
  extensions: ['.scala', '.sc'],
  grammar: 'tree-sitter-scala.wasm',
  query: `
(function_definition name: (identifier) @fn.name) @fn

(class_definition name: (identifier) @scope.name) @scope
(object_definition name: (identifier) @scope.name) @scope
(trait_definition name: (identifier) @scope.name) @scope

(call_expression function: (identifier) @call.name) @call
(call_expression function: (field_expression value: (_) @call.receiver field: (identifier) @call.name)) @call

(import_declaration path: (stable_identifier (identifier) @import.name .) @import.source) @import
(import_declaration path: (identifier) @import.name @import.source) @import

((infix_expression left: (identifier) @_t) @throw (#eq? @_t "throw"))
`,
  selfNames: ['this', 'super'],
  implicitThis: true,
  sameDirectoryVisible: true,
  resolveImport: (_from, source) => dottedImport(source),
  hooks: {
    exported: (fn, { nestedInFunction }) => !nestedInFunction && !hasWord(modifiers(fn), 'private', 'protected'),
  },
  testFile: JVM_TEST_FILE,
  sinks: JVM_SINKS,
};
