// Type-aware call resolution for TypeScript and JavaScript, using the TypeScript compiler's checker.
// Name-based resolution guesses; the checker knows. For each call it answers one of:
//   • these functions in the repository   → exact edges
//   • something outside the repository    → no edge (still checked for external effects)
//   • unknown (any, untyped, interface)   → left to name-based resolution
// Files are read from the snapshot (any commit, not just the working tree); libraries and their
// type declarations come from disk.
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript5';
import type { ExtractedFile } from './parse.ts';
import type { Snapshot } from './source.ts';
import type { FnNode } from './types.ts';

const TS_FAMILY = new Set(['typescript', 'tsx', 'javascript']);
/** Above this many files, type checking is skipped (it would dominate the run). */
const MAX_FILES = 4000;

import { typedKey, type TypedCalls } from './build.ts';

export interface TypedStats {
  files: number;
  calls: number;
  internal: number;
  external: number;
  ms: number;
}

export async function typeCheckCalls(
  snapshot: Snapshot,
  files: Map<string, ExtractedFile>,
  nodes: Map<string, FnNode>,
): Promise<{ calls: TypedCalls; stats: TypedStats } | undefined> {
  const started = Date.now();
  const ours = [...files.values()].filter((f) => TS_FAMILY.has(f.language));
  if (!ours.length || ours.length > MAX_FILES) return undefined;

  // Sources from the snapshot, so a review of any commit type-checks that commit.
  const byPath = new Map(snapshot.files.map((f) => [f.path, f]));
  const text = new Map<string, string>();
  for (const f of ours) {
    const src = await snapshot.read(byPath.get(f.path)!);
    if (src != null) text.set(resolve(snapshot.root, f.path), src);
  }
  const tsconfig = byPath.get('tsconfig.json') ? await snapshot.read(byPath.get('tsconfig.json')!) : null;
  const options: ts.CompilerOptions = {
    allowJs: true,
    checkJs: false,
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowImportingTsExtensions: true,
    jsx: ts.JsxEmit.Preserve,
    types: [],
    ...projectOptions(tsconfig, snapshot.root),
  };
  const host = ts.createCompilerHost(options, true);
  const disk = { getSourceFile: host.getSourceFile, fileExists: host.fileExists, readFile: host.readFile };
  host.fileExists = (p) => text.has(resolve(p)) || disk.fileExists(p);
  host.readFile = (p) => text.get(resolve(p)) ?? disk.readFile(p);
  host.getSourceFile = (p, lang, onError) => {
    const src = text.get(resolve(p));
    return src !== undefined ? ts.createSourceFile(p, src, lang, true) : disk.getSourceFile(p, lang, onError);
  };
  const program = ts.createProgram([...text.keys()], options, host);
  const checker = program.getTypeChecker();

  // Our functions by where they end: a key both parsers agree on.
  const byEnd = new Map<string, FnNode[]>();
  for (const n of nodes.values()) {
    // Deleted functions' lines are from the base revision, not the files checked here.
    if (!TS_FAMILY.has(n.language) || n.status === 'deleted') continue;
    const k = `${n.file}:${n.range.endLine}`;
    (byEnd.get(k) ?? byEnd.set(k, []).get(k)!).push(n);
  }
  const relPath = (sf: ts.SourceFile) => relative(snapshot.root, sf.fileName).split('\\').join('/');
  const nodeFor = (fn: ts.Node, name: string | undefined): FnNode | undefined => {
    const sf = fn.getSourceFile();
    const end = sf.getLineAndCharacterOfPosition(fn.getEnd()).line + 1;
    const candidates = byEnd.get(`${relPath(sf)}:${end}`) ?? [];
    return candidates.length === 1 ? candidates[0] : candidates.find((c) => c.name === name);
  };

  const calls: TypedCalls = new Map();
  const conflicts = new Set<string>();
  const stats: TypedStats = { files: text.size, calls: 0, internal: 0, external: 0, ms: 0 };
  for (const sf of program.getSourceFiles()) {
    if (!text.has(resolve(sf.fileName))) continue;
    const file = relPath(sf);
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        const callee = node.expression;
        const nameNode = ts.isPropertyAccessExpression(callee) ? callee.name : ts.isIdentifier(callee) ? callee : undefined;
        if (nameNode) {
          stats.calls++;
          const answer = resolveCall(nameNode, ts.isNewExpression(node));
          if (answer !== undefined) {
            const line = sf.getLineAndCharacterOfPosition(nameNode.getStart(sf)).line + 1;
            const key = typedKey(file, line, nameNode.text);
            // Same name called twice on one line with different meanings (`walk(tree.walk())`):
            // the line-and-name key cannot tell them apart, so leave both to name matching.
            if (calls.has(key) && JSON.stringify(calls.get(key)) !== JSON.stringify(answer)) conflicts.add(key);
            calls.set(key, answer);
            if (answer === null) stats.external++;
            else stats.internal++;
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

  /** What a called name refers to; undefined when the checker cannot say for sure. */
  function resolveCall(nameNode: ts.Identifier | ts.MemberName, isNew: boolean): string[] | null | undefined {
    let symbol = checker.getSymbolAtLocation(nameNode);
    if (!symbol) return undefined;
    if (symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    const decls = symbol.declarations ?? [];
    if (!decls.length) return undefined;
    const targets = new Set<string>();
    let external = false;
    for (const decl of decls) {
      const sf = decl.getSourceFile();
      if (!text.has(resolve(sf.fileName))) {
        // Declared in a library, the standard library, or another package: not our code.
        external = true;
        continue;
      }
      if (isNew && (ts.isClassDeclaration(decl) || ts.isClassExpression(decl))) {
        const ctor = decl.members.find(ts.isConstructorDeclaration);
        const n = ctor && nodeFor(ctor, 'constructor');
        if (n) targets.add(n.id);
        continue;
      }
      const fn = functionOf(decl);
      if (fn === 'ambiguous') return undefined;
      if (!fn) continue;
      const n = nodeFor(fn, nameNode.text);
      if (!n) return undefined;
      targets.add(n.id);
    }
    if (targets.size) return [...targets];
    return external ? null : [];
  }

  for (const key of conflicts) calls.delete(key);
  stats.ms = Date.now() - started;
  return { calls, stats };
}

/**
 * The function a declaration defines: itself, or the function assigned to it. 'ambiguous' when the
 * declaration only describes a shape (interfaces, abstract members, parameters, overload lists).
 */
function functionOf(decl: ts.Declaration): ts.Node | 'ambiguous' | undefined {
  const isFn = (n: ts.Node | undefined): n is ts.FunctionLikeDeclaration =>
    !!n && (ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isConstructorDeclaration(n) || ts.isGetAccessor(n) || ts.isSetAccessor(n));
  if (isFn(decl)) return decl.body ? decl : 'ambiguous';
  if (ts.isMethodSignature(decl) || ts.isPropertySignature(decl) || ts.isParameter(decl) || ts.isIndexSignatureDeclaration(decl)) return 'ambiguous';
  if ((ts.isVariableDeclaration(decl) || ts.isPropertyAssignment(decl) || ts.isPropertyDeclaration(decl)) && decl.initializer) {
    const init = skipParens(decl.initializer);
    return isFn(init) ? init : 'ambiguous';
  }
  // JavaScript: `app.use = function use() {…}` / `exports.x = …` declare through the assignment.
  if ((ts.isPropertyAccessExpression(decl) || ts.isElementAccessExpression(decl)) && ts.isBinaryExpression(decl.parent) && decl.parent.left === decl) {
    const right = skipParens(decl.parent.right);
    return isFn(right) ? right : 'ambiguous';
  }
  if (ts.isClassDeclaration(decl) || ts.isModuleDeclaration(decl) || ts.isEnumDeclaration(decl)) return undefined;
  return 'ambiguous';
}

const skipParens = (n: ts.Expression): ts.Expression => (ts.isParenthesizedExpression(n) ? skipParens(n.expression) : n);

/** The project's own compiler options (paths, baseUrl, jsx…), so its imports resolve as in its build. */
function projectOptions(tsconfig: string | null, root: string): ts.CompilerOptions {
  if (!tsconfig) return {};
  const parsed = ts.parseConfigFileTextToJson(join(root, 'tsconfig.json'), tsconfig);
  const raw = (parsed.config?.compilerOptions ?? {}) as Record<string, unknown>;
  const { options } = ts.convertCompilerOptionsFromJson(raw, root);
  // Keep resolution-related settings; ours govern the rest (no emit, no lib checks, JS allowed).
  const keep: (keyof ts.CompilerOptions)[] = ['baseUrl', 'paths', 'rootDirs', 'jsx', 'jsxImportSource', 'moduleSuffixes', 'customConditions'];
  const out: ts.CompilerOptions = {};
  for (const k of keep) if (options[k] !== undefined) (out as Record<string, unknown>)[k] = options[k];
  if (out.baseUrl) out.baseUrl = resolve(root, dirname('tsconfig.json'), String(out.baseUrl));
  return out;
}
