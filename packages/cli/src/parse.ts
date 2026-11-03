import Parser from 'web-tree-sitter';
import { createRequire } from 'node:module';
import type { FnKind, Language, Param, Signature } from './types.ts';

type SyntaxNode = Parser.SyntaxNode;

const require = createRequire(import.meta.url);

const GRAMMARS: Record<Language, string> = {
  typescript: 'tree-sitter-typescript.wasm',
  tsx: 'tree-sitter-tsx.wasm',
  javascript: 'tree-sitter-javascript.wasm',
  python: 'tree-sitter-python.wasm',
};

const EXTENSIONS: Record<string, Language> = {
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.jsx': 'javascript',
  '.py': 'python',
};

export function languageFor(path: string): Language | null {
  if (path.endsWith('.d.ts')) return null;
  const dot = path.lastIndexOf('.');
  return dot === -1 ? null : (EXTENSIONS[path.slice(dot)] ?? null);
}

let initialized: Promise<void> | null = null;
const parsers = new Map<Language, Parser>();

async function parserFor(lang: Language): Promise<Parser> {
  initialized ??= Parser.init();
  await initialized;
  let parser = parsers.get(lang);
  if (!parser) {
    const language = await Parser.Language.load(require.resolve(`tree-sitter-wasms/out/${GRAMMARS[lang]}`));
    parser = new Parser();
    parser.setLanguage(language);
    parsers.set(lang, parser);
  }
  return parser;
}

export interface ExtractedCall {
  name: string;
  /** `obj.method()` style call — resolution is less certain. */
  member: boolean;
  /** Receiver expression for member calls, e.g. `this.db` in `this.db.query()`. */
  object?: string;
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
  /** Whitespace-normalized body used for change detection. */
  fingerprint: string;
  calls: ExtractedCall[];
  throws: string[];
  doc?: string;
  decorators: string[];
}

export interface ExtractedFile {
  path: string;
  language: Language;
  functions: ExtractedFn[];
  /** Module specifiers this file imports. */
  imports: string[];
  /** Local binding name → module specifier it was imported from. */
  importNames: Record<string, string>;
}

export async function parseFile(path: string, source: string): Promise<ExtractedFile | null> {
  const language = languageFor(path);
  if (!language) return null;
  const parser = await parserFor(language);
  const tree = parser.parse(source);
  try {
    const extractor = language === 'python' ? extractPython : extractJs;
    return { path, language, ...extractor(tree.rootNode) };
  } finally {
    tree.delete();
  }
}

const normalize = (s: string) => s.replace(/\s+/g, ' ').trim();
const unquote = (s: string) => s.replace(/^['"`]|['"`]$/g, '');

function cleanComment(text: string): string | undefined {
  const body = text
    .replace(/^\/\*\*?|\*\/$/g, '')
    .split('\n')
    .map((l) => l.replace(/^\s*(\*|\/\/|#)\s?/, ''))
    .filter((l) => !/^\s*@/.test(l))
    .join(' ');
  const out = normalize(body);
  return out ? out.slice(0, 400) : undefined;
}

// ---------------- JavaScript / TypeScript ----------------

const JS_FN_TYPES = new Set([
  'function_declaration',
  'generator_function_declaration',
  'method_definition',
  'arrow_function',
  'function_expression',
  'function',
]);

function extractJs(root: SyntaxNode): Omit<ExtractedFile, 'path' | 'language'> {
  const functions: ExtractedFn[] = [];
  const imports: string[] = [];
  const importNames: Record<string, string> = {};

  const visit = (node: SyntaxNode, scope: string[]) => {
    if (node.type === 'import_statement' || node.type === 'export_statement') {
      const src = node.childForFieldName('source');
      if (src) {
        const spec = unquote(src.text);
        imports.push(spec);
        const clause = node.namedChildren.find((c) => c.type === 'import_clause');
        for (const c of clause?.namedChildren ?? []) {
          if (c.type === 'identifier') importNames[c.text] = spec;
          else if (c.type === 'namespace_import') {
            const id = c.namedChildren.find((n) => n.type === 'identifier');
            if (id) importNames[id.text] = spec;
          } else if (c.type === 'named_imports') {
            for (const sp of c.namedChildren) {
              const local = sp.childForFieldName('alias') ?? sp.childForFieldName('name');
              if (local) importNames[local.text] = spec;
            }
          }
        }
      }
    }
    if (node.type === 'call_expression' && node.childForFieldName('function')?.text === 'require') {
      const arg = node.childForFieldName('arguments')?.namedChildren[0];
      if (arg?.type === 'string') {
        const spec = unquote(arg.text);
        imports.push(spec);
        const binding = node.parent?.type === 'variable_declarator' ? node.parent.childForFieldName('name') : null;
        if (binding?.type === 'identifier') importNames[binding.text] = spec;
        else if (binding?.type === 'object_pattern') {
          for (const p of binding.namedChildren) if (p.type === 'shorthand_property_identifier_pattern') importNames[p.text] = spec;
        }
      }
    }

    let nextScope = scope;
    if (node.type === 'class_declaration' || node.type === 'class') {
      const name = node.childForFieldName('name')?.text;
      if (name) nextScope = [...scope, name];
    }

    if (JS_FN_TYPES.has(node.type)) {
      const name = jsFunctionName(node);
      if (name) {
        const qualifiedName = [...scope, name].join('.');
        functions.push(buildJsFn(node, name, qualifiedName));
        nextScope = [...scope, name];
      }
    }

    for (const child of node.namedChildren) visit(child, nextScope);
  };
  visit(root, []);
  return { functions, imports, importNames };
}

/** The leading comment attached to a declaration (or to its `export` / `const` wrapper). */
function jsDoc(node: SyntaxNode): string | undefined {
  let decl: SyntaxNode = node;
  if (decl.parent?.type === 'variable_declarator') decl = decl.parent.parent ?? decl;
  if (decl.parent?.type === 'export_statement') decl = decl.parent;
  const prev = decl.previousNamedSibling;
  if (prev?.type === 'comment' && decl.startPosition.row - prev.endPosition.row <= 1) return cleanComment(prev.text);
  return undefined;
}

function jsFunctionName(node: SyntaxNode): string | null {
  const own = node.childForFieldName('name');
  if (own) return own.text;
  // const foo = () => {} / const foo = function () {}
  const parent = node.parent;
  if (!parent) return null;
  if (parent.type === 'variable_declarator') return parent.childForFieldName('name')?.text ?? null;
  if (parent.type === 'pair') return parent.childForFieldName('key')?.text ?? null;
  if (parent.type === 'public_field_definition' || parent.type === 'field_definition') {
    return (parent.childForFieldName('name') ?? parent.childForFieldName('property'))?.text ?? null;
  }
  if (parent.type === 'assignment_expression') {
    const left = parent.childForFieldName('left');
    if (left?.type === 'member_expression') return left.childForFieldName('property')?.text ?? null;
    return left?.text ?? null;
  }
  return null;
}

function isJsExported(node: SyntaxNode): boolean {
  for (let n: SyntaxNode | null = node; n; n = n.parent) {
    if (n.type === 'export_statement') return true;
    if (n.type === 'program') return false;
    // Methods of exported classes count as exported surface.
    if (n.type === 'statement_block' && n !== node) return false;
  }
  return false;
}

function buildJsFn(node: SyntaxNode, name: string, qualifiedName: string): ExtractedFn {
  const paramsNode = node.childForFieldName('parameters') ?? node.childForFieldName('parameter');
  const params: Param[] = [];
  if (paramsNode?.type === 'identifier') {
    params.push({ name: paramsNode.text, optional: false });
  } else if (paramsNode) {
    for (const p of paramsNode.namedChildren) {
      if (p.type === 'comment') continue;
      const pattern = p.childForFieldName('pattern') ?? p;
      const typeNode = p.childForFieldName('type');
      const hasDefault = !!p.childForFieldName('value') || p.type === 'assignment_pattern';
      params.push({
        name: (p.type === 'assignment_pattern' ? p.childForFieldName('left') : pattern)?.text ?? p.text,
        type: typeNode ? typeNode.text.replace(/^:\s*/, '') : undefined,
        optional: p.type === 'optional_parameter' || hasDefault || pattern.type === 'rest_pattern',
      });
    }
  }
  const returnNode = node.childForFieldName('return_type');
  const isAsync = node.children.some((c) => c.type === 'async');
  const body = node.childForFieldName('body');
  const headerEnd = body ? body.startIndex - node.startIndex : node.text.length;
  const signatureText = normalize(node.text.slice(0, headerEnd)).replace(/\s*=>\s*$/, '');

  const calls: ExtractedCall[] = [];
  const throws: string[] = [];
  if (body) {
    walkOwnBody(body, (n) => JS_FN_TYPES.has(n.type) && jsFunctionName(n) !== null, (n) => {
      if (n.type === 'call_expression' || n.type === 'new_expression') {
        const fn = n.childForFieldName('function') ?? n.childForFieldName('constructor');
        if (fn?.type === 'identifier') calls.push({ name: fn.text, member: false });
        else if (fn?.type === 'member_expression') {
          const prop = fn.childForFieldName('property');
          const obj = fn.childForFieldName('object');
          if (prop) calls.push({ name: prop.text, member: true, object: obj?.text.slice(0, 80) });
        }
      } else if (n.type === 'throw_statement') {
        throws.push(normalize(n.text).slice(0, 160));
      }
    });
  }

  return {
    name,
    qualifiedName,
    kind: node.type === 'method_definition' ? 'method' : node.type === 'arrow_function' ? 'arrow' : 'function',
    exported: isJsExported(node),
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    signature: {
      params,
      returnType: returnNode ? returnNode.text.replace(/^:\s*/, '') : undefined,
      async: isAsync,
      text: signatureText,
    },
    source: (node.parent?.type === 'variable_declarator' ? node.parent.parent ?? node : node).text,
    fingerprint: normalize(node.text),
    calls,
    throws,
    doc: jsDoc(node),
    decorators: [],
  };
}

/**
 * Walk a function body without descending into nested *named* functions (they get their own
 * node). Anonymous callbacks like `items.map((x) => f(x))` are walked: their calls belong here.
 */
function walkOwnBody(body: SyntaxNode, isOwnFunction: (n: SyntaxNode) => boolean, cb: (n: SyntaxNode) => void) {
  const stack = [body];
  while (stack.length) {
    const n = stack.pop()!;
    cb(n);
    for (const c of n.namedChildren) if (!isOwnFunction(c)) stack.push(c);
  }
}

// ---------------- Python ----------------

const PY_FN_TYPES = new Set(['function_definition']);

function extractPython(root: SyntaxNode): Omit<ExtractedFile, 'path' | 'language'> {
  const functions: ExtractedFn[] = [];
  const imports: string[] = [];
  const importNames: Record<string, string> = {};

  const visit = (node: SyntaxNode, scope: string[], inClass: boolean) => {
    if (node.type === 'import_from_statement') {
      const mod = node.childForFieldName('module_name');
      if (mod) {
        imports.push(mod.text);
        for (const n of node.childrenForFieldName('name')) {
          const local = n.type === 'aliased_import' ? n.childForFieldName('alias') : n;
          if (local) importNames[local.text.split('.').pop()!] = mod.text;
        }
      }
    } else if (node.type === 'import_statement') {
      for (const n of node.childrenForFieldName('name')) {
        if (n.type === 'aliased_import') {
          const alias = n.childForFieldName('alias');
          const name = n.childForFieldName('name');
          if (alias && name) importNames[alias.text] = name.text;
        } else importNames[n.text.split('.')[0]] = n.text;
      }
    }
    let nextScope = scope;
    let nextInClass = false;
    if (node.type === 'class_definition') {
      const name = node.childForFieldName('name')?.text;
      if (name) nextScope = [...scope, name];
      nextInClass = true;
    } else if (node.type === 'function_definition') {
      const name = node.childForFieldName('name')!.text;
      const qualifiedName = [...scope, name].join('.');
      functions.push(buildPyFn(node, name, qualifiedName, inClass, scope.length === 0 || inClass));
      nextScope = [...scope, name];
    } else {
      nextInClass = inClass && (node.type === 'block' || node.type === 'decorated_definition');
    }
    for (const child of node.namedChildren) visit(child, nextScope, nextInClass);
  };
  visit(root, [], false);
  return { functions, imports, importNames };
}

function buildPyFn(node: SyntaxNode, name: string, qualifiedName: string, isMethod: boolean, topLevel: boolean): ExtractedFn {
  const params: Param[] = [];
  for (const p of node.childForFieldName('parameters')?.namedChildren ?? []) {
    const pname = (p.childForFieldName('name') ?? p.namedChildren[0] ?? p).text;
    if (isMethod && (pname === 'self' || pname === 'cls')) continue;
    params.push({
      name: pname,
      type: p.childForFieldName('type')?.text,
      optional: p.type.startsWith('default') || p.type.startsWith('typed_default') || p.type.includes('splat'),
    });
  }
  const body = node.childForFieldName('body');
  const header = body ? node.text.slice(0, body.startIndex - node.startIndex) : node.text;
  const calls: ExtractedCall[] = [];
  const throws: string[] = [];
  if (body) {
    walkOwnBody(body, (n) => PY_FN_TYPES.has(n.type), (n) => {
      if (n.type === 'call') {
        const fn = n.childForFieldName('function');
        if (fn?.type === 'identifier') calls.push({ name: fn.text, member: false });
        else if (fn?.type === 'attribute') {
          const attr = fn.childForFieldName('attribute');
          const obj = fn.childForFieldName('object');
          if (attr) calls.push({ name: attr.text, member: true, object: obj?.text.slice(0, 80) });
        }
      } else if (n.type === 'raise_statement') {
        throws.push(normalize(n.text).slice(0, 160));
      }
    });
  }
  return {
    name,
    qualifiedName,
    kind: isMethod ? 'method' : 'function',
    exported: topLevel && !name.startsWith('_'),
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    signature: {
      params,
      returnType: node.childForFieldName('return_type')?.text,
      async: node.children.some((c) => c.type === 'async'),
      text: normalize(header).replace(/:$/, ''),
    },
    source: node.text,
    fingerprint: normalize(node.text),
    calls,
    throws,
    doc: pyDocstring(body),
    decorators:
      node.parent?.type === 'decorated_definition'
        ? node.parent.namedChildren.filter((c) => c.type === 'decorator').map((c) => normalize(c.text).slice(0, 120))
        : [],
  };
}

function pyDocstring(body: SyntaxNode | null): string | undefined {
  const first = body?.namedChildren[0];
  const str = first?.type === 'expression_statement' ? first.namedChildren[0] : null;
  if (str?.type !== 'string') return undefined;
  return cleanComment(str.text.replace(/^[rubf]*(?:"{3}|'{3}|"|')|(?:"{3}|'{3}|"|')$/gi, ''));
}
