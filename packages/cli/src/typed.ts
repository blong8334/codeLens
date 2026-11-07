// Type-aware call resolution for TypeScript and JavaScript, using the TypeScript compiler's checker.
// Name-based resolution guesses; the checker knows. For each call it answers one of:
//   • these functions in the repository   → exact edges
//   • something outside the repository    → no edge (still checked for external effects)
//   • unknown (any, untyped, interface)   → left to name-based resolution
// Repository files are read from the snapshot (any commit, not just the working tree); libraries
// and their type declarations come from disk (node_modules).
import { dirname, join, relative, resolve, sep } from 'node:path';
import ts from 'typescript5';
import type { ExtractedFile } from './parse.ts';
import { IGNORED_DIRS, type Snapshot } from './source.ts';
import type { FnNode } from './types.ts';

const TS_FAMILY = new Set(['typescript', 'tsx', 'javascript']);
/** Above this many files, type checking is skipped (it would dominate the run). */
const MAX_FILES = 4000;
/** Declaration files and JSON (tsconfigs, imported data) the checker may need from the repository. */
const SUPPORT_FILE = /\.d\.[mc]?ts$|\.json$/;
const MAX_SUPPORT_BYTES = 512 * 1024;

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
  const root = snapshot.root;
  const abs = (p: string) => resolve(root, p);

  // Everything the checker reads from the repository comes from the snapshot, so a review of any
  // commit checks that commit: the code, plus its declaration files and JSON (tsconfigs included).
  // Only what git does not track — node_modules, the standard library — comes from disk.
  const text = new Map<string, string>();
  for (const f of snapshot.files) {
    const code = files.has(f.path) && TS_FAMILY.has(files.get(f.path)!.language);
    const support = SUPPORT_FILE.test(f.path) && !IGNORED_DIRS.test(f.path) && (f.size ?? 0) <= MAX_SUPPORT_BYTES;
    if (!code && !support) continue;
    const src = await snapshot.read(f);
    if (src != null) text.set(abs(f.path), src);
  }
  const fromDisk = (p: string) => !p.startsWith(root + sep) || /[\\/]node_modules[\\/]/.test(p);
  const readText = (p: string) => text.get(resolve(p)) ?? (fromDisk(resolve(p)) ? ts.sys.readFile(p) : undefined);
  const exists = (p: string) => text.has(resolve(p)) || (fromDisk(resolve(p)) && ts.sys.fileExists(p));

  // Our functions by where they end: a key both parsers agree on.
  const byEnd = new Map<string, FnNode[]>();
  for (const n of nodes.values()) {
    // Deleted functions' lines are from the base revision, not the files checked here.
    if (!TS_FAMILY.has(n.language) || n.status === 'deleted') continue;
    const k = `${n.file}:${n.range.endLine}`;
    (byEnd.get(k) ?? byEnd.set(k, []).get(k)!).push(n);
  }
  const relPath = (sf: ts.SourceFile) => relative(root, sf.fileName).split('\\').join('/');
  /**
   * The tracked function a declaration is. Ending on the same line is not enough on its own (an
   * untracked callback can end where its enclosing function does): the start line or the name must
   * agree too, or the call is left to name matching rather than given a confident wrong edge.
   */
  const nodeFor = (fn: ts.Node, name: string | undefined): FnNode | undefined => {
    const sf = fn.getSourceFile();
    const end = sf.getLineAndCharacterOfPosition(fn.getEnd()).line + 1;
    const start = sf.getLineAndCharacterOfPosition(fn.getStart(sf)).line + 1;
    const candidates = byEnd.get(`${relPath(sf)}:${end}`) ?? [];
    const sameStart = candidates.filter((c) => c.range.startLine === start);
    if (sameStart.length === 1) return sameStart[0];
    return (sameStart.length ? sameStart : candidates).find((c) => c.name === name);
  };

  // One program per tsconfig: in a monorepo each package resolves imports with its own settings.
  const configs = snapshot.files
    .map((f) => f.path)
    .filter((p) => /(^|\/)tsconfig\.json$/.test(p) && !IGNORED_DIRS.test(p))
    .map((p) => dirname(p))
    .sort((a, b) => b.length - a.length);
  const configFor = (path: string) => configs.find((d) => d === '.' || path.startsWith(`${d}/`));
  const groups = new Map<string | undefined, string[]>();
  for (const f of ours) {
    const c = configFor(f.path);
    (groups.get(c) ?? groups.set(c, []).get(c)!).push(abs(f.path));
  }

  const calls: TypedCalls = new Map();
  const conflicts = new Set<string>();
  const stats: TypedStats = { files: ours.length, calls: 0, internal: 0, external: 0, ms: 0 };
  for (const [configDir, rootNames] of groups) {
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
      ...(configDir ? projectOptions(join(abs(configDir), 'tsconfig.json'), readText, exists) : {}),
    };
    const host = ts.createCompilerHost(options, true);
    host.fileExists = exists;
    host.readFile = readText;
    host.getSourceFile = (p, lang) => {
      const src = readText(p);
      return src === undefined ? undefined : ts.createSourceFile(p, src, lang, true);
    };
    const program = ts.createProgram(rootNames, options, host);
    const checker = program.getTypeChecker();
    const mine = new Set(rootNames);

    /** What a called name refers to; undefined when the checker cannot say for sure. */
    const resolveCall = (nameNode: ts.Identifier | ts.MemberName, isNew: boolean): string[] | null | undefined => {
      let symbol = checker.getSymbolAtLocation(nameNode);
      if (!symbol) return undefined;
      if (symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
      const decls = symbol.declarations ?? [];
      if (!decls.length) return undefined;
      const targets = new Set<string>();
      let external = false;
      for (const decl of decls) {
        const sf = decl.getSourceFile();
        // Declared in a library, the standard library, a .d.ts, or another package: not our code.
        if (!files.has(relPath(sf)) || !TS_FAMILY.has(files.get(relPath(sf))!.language)) {
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
    };

    for (const sf of program.getSourceFiles()) {
      if (!mine.has(resolve(sf.fileName))) continue;
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

/**
 * A tsconfig's resolution settings (paths, baseUrl, jsx…), following `extends` — within the
 * repository from the snapshot, shared configs from node_modules — so imports resolve as in the
 * project's own build. Everything else stays ours (no emit, no lib checks, JS allowed).
 */
function projectOptions(configPath: string, readFile: (p: string) => string | undefined, fileExists: (p: string) => boolean): ts.CompilerOptions {
  const raw = readFile(configPath);
  if (raw === undefined) return {};
  const json = ts.parseConfigFileTextToJson(configPath, raw);
  if (!json.config) return {};
  const parsed = ts.parseJsonConfigFileContent(
    json.config,
    { useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames, readDirectory: () => [], fileExists, readFile },
    dirname(configPath),
    undefined,
    configPath,
  );
  // pathsBasePath lets `paths` resolve without a baseUrl, as TypeScript does.
  const keep: (keyof ts.CompilerOptions)[] = ['baseUrl', 'paths', 'pathsBasePath', 'rootDirs', 'jsx', 'jsxImportSource', 'moduleSuffixes', 'customConditions'];
  const out: ts.CompilerOptions = {};
  for (const k of keep) if (parsed.options[k] !== undefined) (out as Record<string, unknown>)[k] = parsed.options[k];
  return out;
}
