import type { Param } from '../types.ts';
import type { LanguageSpec, SyntaxNode } from './spec.ts';
import { hasWord, modifiers } from './util.ts';

const TYPE = /^(user_type|optional_type|array_type|dictionary_type|tuple_type|function_type)$/;

function swiftParams(fn: SyntaxNode): Param[] {
  const out: Param[] = [];
  for (const p of fn.namedChildren) {
    if (p.type !== 'parameter') continue;
    // `func f(with url: URL)`: the last identifier before the type is the internal name.
    const ids = p.namedChildren.filter((c) => c.type === 'simple_identifier');
    const type = p.namedChildren.find((c) => TYPE.test(c.type));
    out.push({ name: ids.at(-1)?.text ?? p.text, type: type?.text, optional: /=/.test(p.nextSibling?.type ?? '') });
  }
  return out;
}

function swiftReturnType(fn: SyntaxNode): string | undefined {
  const kids = fn.children;
  const arrow = kids.findIndex((c) => c.type === '->');
  if (arrow === -1) return undefined;
  return kids.slice(arrow + 1).find((c) => c.isNamed)?.text;
}

export const swift: LanguageSpec = {
  id: 'swift',
  name: 'Swift',
  extensions: ['.swift'],
  grammar: 'tree-sitter-swift.wasm',
  query: `
(function_declaration name: (simple_identifier) @fn.name) @fn

(class_declaration name: (type_identifier) @scope.name) @scope
(protocol_declaration name: (type_identifier) @scope.name) @scope

(call_expression (simple_identifier) @call.name) @call
(call_expression (navigation_expression target: (_) @call.receiver suffix: (navigation_suffix suffix: (simple_identifier) @call.name))) @call

(import_declaration (identifier) @import.source) @import

(control_transfer_statement (throw_keyword)) @throw
`,
  selfNames: ['self', 'super', 'Self'],
  implicitThis: true,
  // A Swift module sees all of its files; same-directory is the closest syntactic proxy.
  sameDirectoryVisible: true,
  hooks: {
    params: swiftParams,
    returnType: swiftReturnType,
    body: (fn) => fn.childForFieldName('body'),
    isAsync: (fn) => fn.children.some((c) => c.type === 'async' || (c.type === 'modifiers' && /\basync\b/.test(c.text))),
    exported: (fn, { nestedInFunction }) => !nestedInFunction && !hasWord(modifiers(fn), 'private', 'fileprivate'),
  },
  testFile: /Tests?\.swift$|(^|\/)Tests\//,
  sinkCalls: {
    network: /^(URLSession|AF|Alamofire|session)\b/,
    filesystem: /^(FileManager|FileHandle)\b|\.write\(to/,
    database: /^(CoreData|NSPersistentContainer|context|managedObjectContext|db)\.(save|fetch|execute)/,
    process: /^(Process|NSTask)\b/,
  },
};
