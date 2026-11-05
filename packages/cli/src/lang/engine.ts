import Parser from 'web-tree-sitter';
import type { FnKind, Param, Signature } from '../types.ts';
import type { LanguageSpec, SyntaxNode } from './spec.ts';

export interface ExtractedCall {
  name: string;
  /** `obj.method()` style call — resolution is less certain. */
  member: boolean;
  /** Receiver expression for member calls, e.g. `this.db` in `this.db.query()`. */
  object?: string;
  /** 1-based line of the called name, to match calls with a type checker's view of them. */
  line?: number;
}

export interface ExtractedFn {
  name: string;
  qualifiedName: string;
  kind: FnKind;
  exported: boolean;
  startLine: number; // 1-based
  endLine: number;
  signature: Signature;
  source: string;
  /** Whitespace-normalized text used for change detection. */
  fingerprint: string;
  calls: ExtractedCall[];
  throws: string[];
  doc?: string;
  decorators: string[];
  /** Receiver variable for methods that name it (Go). */
  self?: string;
}

export interface ExtractedFile {
  path: string;
  language: string;
  functions: ExtractedFn[];
  /** Module specifiers this file imports. */
  imports: string[];
  /** Local binding name → module specifier it was imported from. */
  importNames: Record<string, string>;
}

export const normalize = (s: string) => s.replace(/\s+/g, ' ').trim();
export const unquote = (s: string) => s.replace(/^[<'"`]|[>'"`]$/g, '');

export function cleanComment(text: string): string | undefined {
  const body = text
    .replace(/^\/\*[*!]?|\*\/$/g, '')
    .replace(/<\/?(summary|remarks|returns|value|para|param[^>]*|typeparam[^>]*)>/g, ' ')
    .split('\n')
    .map((l) => l.replace(/^\s*(\*|\/\/[/!]?|#+|--|;+)\s?/, ''))
    .filter((l) => !/^\s*[@\\](param|returns?|throws|see|since|author|example|type|arg)\b/.test(l))
    .join(' ');
  const out = normalize(body);
  return out ? out.slice(0, 400) : undefined;
}

const queries = new WeakMap<LanguageSpec, Parser.Query>();

function compiled(spec: LanguageSpec, language: Parser.Language): Parser.Query {
  let q = queries.get(spec);
  if (!q) {
    try {
      q = language.query(spec.query);
    } catch (err) {
      throw new Error(`${spec.name} query does not compile against ${spec.grammar}: ${(err as Error).message}`);
    }
    queries.set(spec, q);
  }
  return q;
}

/** Wrappers that carry a definition's doc comment or decorators (`export`, `@decorator`, templates). */
const WRAPPERS = new Set(['export_statement', 'decorated_definition', 'template_declaration', 'variable_declarator', 'lexical_declaration', 'variable_declaration']);
/** Wrappers whose text belongs to the definition's source (`const f = () => …`). */
const SOURCE_WRAPPERS = new Set(['variable_declarator', 'lexical_declaration', 'variable_declaration']);
const ATTRIBUTE = /^(decorator|annotation|marker_annotation|attribute_item|attribute_list|attribute)$/;
const COMMENT = /comment/;

interface FnMatch {
  node: SyntaxNode;
  name: string;
  scope?: string;
  self?: string;
}

export function extract(spec_: LanguageSpec, language: Parser.Language, root: SyntaxNode): Omit<ExtractedFile, 'path' | 'language'> {
  const spec = spec_;
  const query = compiled(spec, language);
  const fns = new Map<number, FnMatch>();
  const scopes = new Map<number, string>();
  const namespaces = new Map<number, string>();
  const calls: { node: SyntaxNode; call: ExtractedCall }[] = [];
  const throwNodes: SyntaxNode[] = [];
  const imports: string[] = [];
  const importNames: Record<string, string> = {};

  for (const match of query.matches(root)) {
    const cap = (name: string) => match.captures.find((c) => c.name === name)?.node;
    const fn = cap('fn');
    if (fn) {
      const name = cap('fn.name');
      if (name && !fns.has(fn.id)) fns.set(fn.id, { node: fn, name: name.text, scope: cap('fn.scope')?.text, self: cap('fn.self')?.text });
      continue;
    }
    const scope = cap('scope');
    if (scope) {
      const name = cap('scope.name');
      if (name && !scopes.has(scope.id)) scopes.set(scope.id, name.text);
      continue;
    }
    const ns = cap('namespace');
    if (ns) {
      const name = cap('namespace.name');
      if (name && !namespaces.has(ns.id)) namespaces.set(ns.id, name.text);
      continue;
    }
    const call = cap('call');
    if (call) {
      const name = cap('call.name');
      const receiver = cap('call.receiver');
      if (name) calls.push({ node: call, call: { name: name.text, member: !!receiver, object: receiver?.text.slice(0, 80), line: name.startPosition.row + 1 } });
      continue;
    }
    const imp = cap('import');
    if (imp) {
      const source = cap('import.source');
      if (!source) continue;
      const raw = unquote(source.text.trim());
      const spec = spec_.hooks?.mapImport ? spec_.hooks.mapImport(imp, raw) : raw;
      if (!imports.includes(spec)) imports.push(spec);
      const names = match.captures.filter((c) => c.name === 'import.name');
      for (const c of names) importNames[c.node.text] = spec_.hooks?.bindImport ? spec_.hooks.bindImport(spec, c.node.text) : spec;
      if (!names.length) {
        const local = spec_.hooks?.defaultImportName?.(spec);
        if (local && !(local in importNames)) importNames[local] = spec;
      }
      continue;
    }
    const thr = cap('throw');
    if (thr) throwNodes.push(thr);
  }

  // Innermost enclosing named function for any node.
  const ownerOf = (node: SyntaxNode): FnMatch | undefined => {
    for (let n = node.parent; n; n = n.parent) {
      const f = fns.get(n.id);
      if (f) return f;
    }
    return undefined;
  };

  const out = new Map<number, ExtractedFn>();
  for (const f of fns.values()) out.set(f.node.id, buildFn(spec, f, fns, scopes, namespaces));
  // Calls outside any named function (CLI wiring, route registration, `test(...)` blocks,
  // `if __name__ == "__main__"`) belong to the file's top level, so they are not lost.
  const orphanCalls: { node: SyntaxNode; call: ExtractedCall }[] = [];
  const orphanThrows: string[] = [];
  for (const { node, call } of calls) {
    // A call that *is* a definition (e.g. Kotlin/Swift edge cases) or sits in the header belongs to the owner.
    const owner = ownerOf(node);
    if (owner) out.get(owner.node.id)!.calls.push(call);
    else orphanCalls.push({ node, call });
  }
  for (const t of throwNodes) {
    const owner = ownerOf(t);
    if (owner) out.get(owner.node.id)!.throws.push(normalize(t.text).slice(0, 160));
    else orphanThrows.push(normalize(t.text).slice(0, 160));
  }
  if (orphanCalls.length) out.set(-1, topLevelFn(root, orphanCalls, orphanThrows));
  const functions = [...out.values()].sort((a, b) => a.startLine - b.startLine);
  return { functions, imports, importNames };
}

export const TOP_LEVEL = '(top level)';
const MAX_TOP_LEVEL_CHARS = 4000;

function topLevelFn(root: SyntaxNode, calls: { node: SyntaxNode; call: ExtractedCall }[], throws: string[]): ExtractedFn {
  // Source: the top-level statements that contain those calls.
  const parts: string[] = [];
  let size = 0;
  for (const child of root.namedChildren) {
    if (size > MAX_TOP_LEVEL_CHARS) break;
    if (!calls.some(({ node }) => node.startIndex >= child.startIndex && node.endIndex <= child.endIndex)) continue;
    parts.push(child.text);
    size += child.text.length;
  }
  const source = parts.join('\n').slice(0, MAX_TOP_LEVEL_CHARS);
  return {
    name: TOP_LEVEL,
    qualifiedName: TOP_LEVEL,
    kind: 'function',
    exported: false,
    startLine: 1,
    endLine: root.endPosition.row + 1,
    signature: { params: [], async: false, text: 'top-level code of this file' },
    source,
    fingerprint: normalize(source),
    calls: calls.map((c) => c.call),
    throws,
    decorators: [],
  };
}

function buildFn(spec: LanguageSpec, f: FnMatch, fns: Map<number, FnMatch>, scopes: Map<number, string>, namespaces: Map<number, string>): ExtractedFn {
  const node = f.node;
  const hooks = spec.hooks ?? {};

  // Qualified name: enclosing scopes and functions, outermost first.
  const chain: string[] = [];
  let isMethod = false;
  let nestedInFunction = false;
  let sawContainer = false;
  for (let n = node.parent; n; n = n.parent) {
    const scopeName = scopes.get(n.id);
    const outer = fns.get(n.id);
    const nsName = namespaces.get(n.id);
    if (nsName !== undefined) {
      chain.unshift(nsName);
    } else if (scopeName !== undefined) {
      chain.unshift(scopeName);
      if (!sawContainer) isMethod = true;
      sawContainer = true;
    } else if (outer) {
      chain.unshift(outer.name);
      if (!sawContainer) nestedInFunction = true;
      sawContainer = true;
    }
  }
  if (f.scope) {
    chain.push(f.scope.replace(/^\*|::$/g, ''));
    isMethod = true;
  }
  const qualifiedName = [...chain, f.name].join('.');

  const params = (hooks.params ?? genericParams)(node).filter((p) => !(isMethod && spec.selfNames?.includes(p.name)));
  const body = hooks.body ? hooks.body(node) : node.childForFieldName('body');
  const headerEnd = body && body.startIndex > node.startIndex ? body.startIndex - node.startIndex : node.text.length;
  const header = normalize(node.text.slice(0, headerEnd)).replace(/\s*(=>|=|:|\{|->)\s*$/, '');

  let sourceNode = node;
  while (sourceNode.parent && SOURCE_WRAPPERS.has(sourceNode.parent.type) && sourceNode.parent.namedChildCount <= 2) sourceNode = sourceNode.parent;

  return {
    name: f.name,
    qualifiedName,
    kind: hooks.kind ? hooks.kind(node, isMethod) : isMethod ? 'method' : 'function',
    exported: hooks.exported ? hooks.exported(node, { name: f.name, isMethod, nestedInFunction }) : !nestedInFunction,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    signature: {
      params,
      returnType: (hooks.returnType ?? genericReturnType)(node),
      async: (hooks.isAsync ?? genericAsync)(node),
      text: header.length > 300 ? `${header.slice(0, 300)}…` : header,
    },
    source: sourceNode.text,
    fingerprint: normalize(node.text),
    calls: [],
    throws: [],
    doc: hooks.innerDoc?.(node) ?? leadingDoc(node),
    decorators: decoratorsOf(node),
    self: f.self,
  };
}

// ---------------- generic helpers (overridable per language) ----------------

/** The node whose siblings carry this definition's comments and attributes. */
function anchor(node: SyntaxNode): SyntaxNode {
  let n = node;
  // Climb only while the definition is the wrapper's main content, not one of several declarators.
  while (n.parent && WRAPPERS.has(n.parent.type) && n.parent.namedChildren.filter((c) => !COMMENT.test(c.type) && !ATTRIBUTE.test(c.type)).length <= 2) {
    n = n.parent;
  }
  return n;
}

export function leadingDoc(node: SyntaxNode): string | undefined {
  const a = anchor(node);
  const parts: string[] = [];
  let expectedRow = a.startPosition.row;
  let prev = a.previousNamedSibling;
  // Some grammars attach the comment elsewhere: Ruby puts the first method's comment before the
  // enclosing body node; Kotlin tucks it inside the preceding import list.
  if (!prev && a.parent) prev = a.parent.previousNamedSibling;
  for (; prev; prev = prev.previousNamedSibling) {
    if (ATTRIBUTE.test(prev.type)) {
      expectedRow = prev.startPosition.row;
      continue;
    }
    if (!COMMENT.test(prev.type)) {
      const tail = trailingComment(prev);
      if (tail && expectedRow - tail.endPosition.row <= 1) parts.unshift(tail.text);
      break;
    }
    if (expectedRow - prev.endPosition.row > 1) break;
    parts.unshift(prev.text);
    expectedRow = prev.startPosition.row;
  }
  return parts.length ? cleanComment(parts.join('\n')) : undefined;
}

function trailingComment(node: SyntaxNode): SyntaxNode | null {
  let last = node.lastNamedChild;
  for (let depth = 0; last && depth < 2; depth++) {
    if (COMMENT.test(last.type)) return last;
    last = last.lastNamedChild;
  }
  return null;
}

function decoratorsOf(node: SyntaxNode): string[] {
  const found: string[] = [];
  const take = (n: SyntaxNode) => found.push(normalize(n.text).slice(0, 120));
  const a = anchor(node);
  for (const c of a.parent?.type === 'decorated_definition' ? a.parent.namedChildren : []) if (ATTRIBUTE.test(c.type)) take(c);
  for (let prev = a.previousNamedSibling; prev && (ATTRIBUTE.test(prev.type) || COMMENT.test(prev.type)); prev = prev.previousNamedSibling) {
    if (ATTRIBUTE.test(prev.type)) take(prev);
  }
  for (const c of node.namedChildren) {
    if (ATTRIBUTE.test(c.type)) take(c);
    if (c.type === 'modifiers' || c.type === 'modifier_list') for (const m of c.namedChildren) if (ATTRIBUTE.test(m.type)) take(m);
  }
  return found;
}

const PARAM_LIST_FIELDS = ['parameters', 'parameter', 'params'];
const PARAM_LIST_TYPES = /^(formal_parameters|parameters|parameter_list|function_value_parameters|method_parameters|lambda_parameters|parameter_clause)$/;
const NAME_TYPES = /^(identifier|simple_identifier|variable_name|name|field_identifier|shorthand_property_identifier_pattern)$/;
const SKIP_PARAM = /^(comment|self_parameter|this|attribute_item|attribute_list|annotation)$/;

function paramList(fn: SyntaxNode): SyntaxNode | null {
  for (const f of PARAM_LIST_FIELDS) {
    const p = fn.childForFieldName(f);
    if (p) return p;
  }
  // C / C++: the parameter list lives inside the declarator.
  const decl = fn.childForFieldName('declarator');
  if (decl) {
    const inner = findDescendant(decl, (n) => n.type === 'parameter_list');
    if (inner) return inner;
  }
  return fn.namedChildren.find((c) => PARAM_LIST_TYPES.test(c.type)) ?? null;
}

export function genericParams(fn: SyntaxNode): Param[] {
  const list = paramList(fn);
  if (!list) return [];
  if (NAME_TYPES.test(list.type)) return [{ name: list.text, optional: false }];
  const out: Param[] = [];
  for (const p of list.namedChildren) {
    if (SKIP_PARAM.test(p.type)) continue;
    const nameNode =
      p.childForFieldName('name') ??
      p.childForFieldName('pattern') ??
      p.childForFieldName('left') ??
      (p.childForFieldName('declarator') && findDescendant(p.childForFieldName('declarator')!, (n) => NAME_TYPES.test(n.type))) ??
      (NAME_TYPES.test(p.type) ? p : findDescendant(p, (n) => NAME_TYPES.test(n.type)));
    if (!nameNode) continue;
    const type = p.childForFieldName('type');
    out.push({
      name: nameNode.text.replace(/^[$&*]+/, ''),
      type: type ? type.text.replace(/^:\s*/, '') : undefined,
      optional:
        !!(p.childForFieldName('value') ?? p.childForFieldName('default_value') ?? p.childForFieldName('default')) ||
        /optional|default|splat|rest|variadic|spread/.test(p.type),
    });
  }
  return out;
}

function genericReturnType(fn: SyntaxNode): string | undefined {
  const r = fn.childForFieldName('return_type') ?? fn.childForFieldName('result') ?? fn.childForFieldName('returns');
  return r ? r.text.replace(/^[:\s]+|^->\s*/, '') : undefined;
}

function genericAsync(fn: SyntaxNode): boolean {
  if (fn.children.some((c) => c.type === 'async')) return true;
  return /\b(async|suspend)\b/.test(modifiersText(fn));
}

export function findDescendant(node: SyntaxNode, pred: (n: SyntaxNode) => boolean): SyntaxNode | null {
  const stack = [...node.namedChildren].reverse();
  while (stack.length) {
    const n = stack.pop()!;
    if (pred(n)) return n;
    for (let i = n.namedChildCount - 1; i >= 0; i--) stack.push(n.namedChild(i)!);
  }
  return null;
}

/** Text of the modifiers / visibility attached to a declaration (`public static`, `pub`). */
export function modifiersText(fn: SyntaxNode): string {
  return fn.namedChildren
    .filter((c) => /modifier|visibility/.test(c.type))
    .map((c) => c.text)
    .join(' ');
}
