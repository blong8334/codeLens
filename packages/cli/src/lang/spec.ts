import type Parser from 'web-tree-sitter';
import type { EntryKind, FnKind, Param, SinkCategory } from '../types.ts';

export type SyntaxNode = Parser.SyntaxNode;

/**
 * Everything CodeLens knows about one programming language. Adding a language means writing
 * one of these (see `src/lang/*.ts` and the "Adding a language" section of the README).
 *
 * The `query` is a Tree-sitter query. The engine understands these captures:
 *
 *   @fn            a function / method / constructor definition (the whole node)
 *   @fn.name       its name                                  (required with @fn)
 *   @fn.scope      explicit qualifier, e.g. a Go receiver type or C++ `Foo::`
 *   @fn.self       the variable naming the receiver, e.g. `s` in Go `func (s *Svc) Run()`
 *
 *   @scope         a class / struct / impl / trait whose functions are methods
 *   @scope.name    its name
 *   @namespace     a namespace / package block that qualifies names without making methods
 *   @namespace.name its name
 *
 *   @call          a call expression
 *   @call.name     the called function or method name
 *   @call.receiver the object a method is called on (`client` in `client.post()`)
 *
 *   @import        an import / use / require / include statement
 *   @import.source the module, package or path imported
 *   @import.name   a local name the import binds (repeat the pattern per binding)
 *
 *   @throw         a throw / raise / panic
 *
 * Captures starting with `_` are ignored (use them with predicates like `#eq?`).
 * Calls and throws are attributed to the innermost enclosing @fn, so anonymous callbacks
 * (`items.map(x => f(x))`) count towards the named function they appear in.
 */
export interface LanguageSpec {
  id: string;
  name: string;
  extensions: string[];
  /** Grammar file inside `tree-sitter-wasms/out/`. */
  grammar: string;
  /** Paths matching this are skipped even though the extension matches (e.g. `.d.ts`). */
  exclude?: RegExp;
  /** Markdown code-fence language tag, when it differs from `id`. */
  fence?: string;
  query: string;

  /** Words that mean "the current instance" in a receiver (`this`, `self`, `$this`). */
  selfNames?: string[];
  /** A bare call inside a method may target a sibling method (Java, C#, Kotlin, Ruby, …). */
  implicitThis?: boolean;
  /** Files in the same directory can call each other without imports (Go, Java packages). */
  sameDirectoryVisible?: boolean;

  /** How an import statement's source maps onto files in the repository. */
  resolveImport?(fromFile: string, source: string): ImportTarget | null;

  /** File-name conventions for tests in this ecosystem. */
  testFile?: RegExp;
  /**
   * Imported packages that perform external effects, by sink category. Each pattern is tested
   * against the package a call's receiver was imported from, and against `package.callName`
   * (so `/^os\.(WriteFile|Remove)$/` can single out a few functions of a broad package).
   */
  sinks?: Partial<Record<SinkCategory, RegExp>>;
  /**
   * Calls that perform external effects without a telltale import, tested against the call
   * as written: `fopen`, `curl_easy_perform`, `Net::HTTP.post`, `URLSession.shared.dataTask`.
   */
  sinkCalls?: Partial<Record<SinkCategory, RegExp>>;

  hooks?: LanguageHooks;
}

export interface LanguageHooks {
  params?(fn: SyntaxNode): Param[];
  returnType?(fn: SyntaxNode): string | undefined;
  isAsync?(fn: SyntaxNode): boolean;
  /** Whether the function is part of the module's public surface. */
  exported?(fn: SyntaxNode, info: { name: string; isMethod: boolean; nestedInFunction: boolean }): boolean;
  kind?(fn: SyntaxNode, isMethod: boolean): FnKind;
  /** Body node, used to compute the signature header. Defaults to the `body` field. */
  body?(fn: SyntaxNode): SyntaxNode | null;
  /** Doc text found inside the function (Python docstrings). Leading comments are automatic. */
  innerDoc?(fn: SyntaxNode): string | undefined;
  /** Rewrite an import's source using its statement (Ruby `require_relative 'x'` → `./x`). */
  mapImport?(node: SyntaxNode, source: string): string;
  /** The module a local import name refers to (Rust `use std::{fs}` binds `fs` → `std::fs`). */
  bindImport?(source: string, localName: string): string;
  /** Local name an import binds when the statement names none (Go: last path segment). */
  defaultImportName?(source: string): string | undefined;
  /** Language-specific entry-point signals, checked before the generic ones. */
  entry?(fn: { name: string; params: Param[]; decorators: string[]; file: string }): { kind: EntryKind; reason: string } | undefined;
}

/**
 * Where an import points. Paths are repo-relative and compared without extensions.
 *  - stems:       exact file paths (`src/lib/money` for `./money` imported from `src/lib/x.ts`)
 *  - suffixes:    files whose path ends with this (`com/acme/Payments` for a Java import)
 *  - dirSuffixes: every file in a directory ending with this (Go packages, C# namespaces)
 */
export interface ImportTarget {
  stems?: string[];
  suffixes?: string[];
  dirSuffixes?: string[];
}
