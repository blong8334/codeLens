import { dirname } from 'node:path/posix';
import { specForId } from './lang/index.ts';
import type { ImportTarget } from './lang/spec.ts';
import type { ExtractedCall, ExtractedFile } from './parse.ts';
import type { FnNode } from './types.ts';

const stripExt = (p: string) => p.replace(/\.[^./]+$/, '');
const lastSegment = (p: string) => p.slice(p.lastIndexOf('/') + 1);

/** Lookup tables for mapping import targets onto repository files without scanning every file. */
export class FileIndex {
  private byStem = new Map<string, string[]>();
  private byBase = new Map<string, string[]>();
  private byDirBase = new Map<string, string[]>();

  constructor(paths: Iterable<string>) {
    for (const p of paths) {
      const stem = stripExt(p);
      push(this.byStem, stem, p);
      push(this.byBase, lastSegment(stem), p);
      push(this.byDirBase, lastSegment(dirname(p)), p);
    }
  }

  /** Files an import points at. Each list is tried most-specific first; the first hit wins. */
  resolve(target: ImportTarget | null): string[] {
    if (!target) return [];
    for (const s of target.stems ?? []) {
      const hit = this.byStem.get(s);
      if (hit) return hit;
    }
    for (const s of target.suffixes ?? []) {
      const hit = (this.byBase.get(lastSegment(s)) ?? []).filter((p) => {
        const stem = stripExt(p);
        return stem === s || stem.endsWith(`/${s}`);
      });
      if (hit.length) return hit;
    }
    for (const s of target.dirSuffixes ?? []) {
      const hit = (this.byDirBase.get(lastSegment(s)) ?? []).filter((p) => {
        const dir = dirname(p);
        return dir === s || dir.endsWith(`/${s}`);
      });
      if (hit.length) return hit;
    }
    return [];
  }
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

type Hit = { id: string; confidence: 'high' | 'low' };

/**
 * Method names every standard library has (collections, strings, streams, promises, I/O).
 * `x.get()` on an unknown receiver is far more likely `Map.get` than the one `get` method we
 * parsed, so these resolve only through evidence — self, imports, a known class — never by guess.
 */
const COMMON_METHODS = new Set(
  (
    'get set has add put delete remove clear size length keys values entries items forEach map filter reduce find ' +
    'findIndex some every includes contains indexOf push pop shift unshift slice splice concat join split replace trim ' +
    'toString toLowerCase toUpperCase startsWith endsWith match test exec then catch finally resolve reject next ' +
    'apply call bind emit on off once send write read close open end flush start stop run append extend insert update ' +
    'sort reverse copy clone equals hashCode compareTo format parse log debug info warn error print println printf ' +
    'append_child getattr setdefault pop_front push_back emplace_back begin len iter collect unwrap expect into as_str ' +
    'to_string clone_from Add Remove Contains ToString Equals GetHashCode Get Set Count Any Where Select First ToList'
  ).split(' '),
);

/**
 * Name-based call resolution. Tree-sitter gives us syntax, not types, so candidates are ranked
 * by locality: own class → same file → imported files / same package → globally unique name.
 * Language plugins supply what "self", "imported" and "same package" mean.
 */
export class CallResolver {
  private byName = new Map<string, FnNode[]>();
  private importCache = new Map<string, Set<string>>();

  constructor(
    nodes: FnNode[],
    private files: Map<string, ExtractedFile>,
    private index: FileIndex,
    private dirFiles: Map<string, string[]>,
  ) {
    for (const n of nodes) push(this.byName, n.name, n);
  }

  resolve(caller: FnNode, call: ExtractedCall, file: ExtractedFile, callerSelf?: string): Hit | null {
    const { name, member, object } = call;
    const all = this.byName.get(name);
    if (!all) return null;
    // Live functions win over deleted ones; a deleted match means the call site now dangles.
    const live = all.filter((n) => n.status !== 'deleted');
    const pool = live.length ? live : all;
    const unique = (list: FnNode[], confidence: Hit['confidence']): Hit | null => (list.length === 1 ? { id: list[0].id, confidence } : null);
    const spec = specForId(file.language);
    const imported = this.importedFiles(file);
    const pkg = this.packageFiles(file);
    const visible = (n: FnNode) => n.file === caller.file || imported.has(n.file) || pkg.has(n.file);
    const callerClass = caller.qualifiedName.split('.').slice(0, -1).join('.');
    const sibling = (n: FnNode) => n.qualifiedName === `${callerClass}.${name}`;

    if (!member) {
      const fns = pool.filter((n) => n.kind !== 'method');
      return (
        (spec?.implicitThis && callerClass ? unique(pool.filter((n) => sibling(n) && visible(n)), 'high') : null) ??
        unique(fns.filter((n) => n.file === caller.file), 'high') ??
        // Same package (Go, Java, …): visible without imports, exported or not.
        unique(fns.filter((n) => pkg.has(n.file)), 'high') ??
        unique(fns.filter((n) => imported.has(n.file) && n.exported), 'high') ??
        unique(fns, 'low')
      );
    }

    // `new Payments().charge()`, `Payments().charge()`, `(new Billing())->charge()`: a call on a fresh instance.
    const constructed = (object ?? '').match(/^\(?\s*new\s+([\w.\\]+)|^([A-Z]\w*)\s*\(/);
    const receiver = constructed ? (constructed[1] ?? constructed[2]) : (object ?? '');
    // `this.m()`, `self.m()`, Go `s.m()` on the method's own receiver: a sibling method.
    if (callerClass && (spec?.selfNames?.includes(receiver) || (callerSelf && receiver === callerSelf))) {
      const hit = unique(pool.filter((n) => sibling(n) && visible(n)), 'high');
      if (hit) return hit;
    }
    // `ns.fn()`, `pkg.Fn()`, `Payments.charge()`, `crate::payments::charge()`: a module, package
    // or class we can locate through imports or the receiver's own name.
    const viaImport = file.importNames[receiver];
    const targets = new Set([
      ...(viaImport ? this.index.resolve(spec?.resolveImport?.(file.path, viaImport) ?? null) : []),
      ...this.index.resolve(spec?.resolveImport?.(file.path, receiver) ?? null),
    ]);
    if (targets.size) {
      const inTargets = pool.filter((n) => targets.has(n.file));
      const hit =
        unique(inTargets.filter((n) => n.qualifiedName.endsWith(`${lastPathPart(receiver)}.${name}`)), 'high') ??
        unique(inTargets.filter((n) => n.kind !== 'method'), 'high') ??
        unique(inTargets, 'low');
      if (hit) return hit;
    }
    // `Foo.bar()` / `Foo::bar()` where Foo is a class we parsed: a static method.
    const recvName = lastPathPart(receiver);
    if (/^[A-Z]/.test(recvName)) {
      const hit = unique(pool.filter((n) => n.qualifiedName === `${recvName}.${name}` || n.qualifiedName.endsWith(`.${recvName}.${name}`)), 'high');
      if (hit) return hit;
    }
    // Any other receiver: without types we can only match methods, never free functions, and a
    // call on another object is never the caller recursing into itself.
    const methods = pool.filter((n) => n.kind === 'method' && n.id !== caller.id);
    const generic = COMMON_METHODS.has(name);
    // Injected fields are usually named after their type: `payments` / `_paymentService` / `s.store`.
    const recvKey = recvName.replace(/^(_+|m(?=[A-Z]))/, '').toLowerCase();
    const classOf = (n: FnNode) => n.qualifiedName.split('.').at(-2)?.toLowerCase();
    // ...or after its role: `resolver` → `CallResolver`, `index` → `FileIndex`, `repo` → `UserRepo`.
    const named =
      recvKey.length > 2
        ? (unique(methods.filter((n) => classOf(n) === recvKey), 'low') ??
          (recvKey.length > 3 ? unique(methods.filter((n) => classOf(n)?.endsWith(recvKey)), 'low') : null))
        : null;
    if (named) return named;
    if (generic) return null;
    return (
      unique(methods.filter((n) => n.file === caller.file), 'high') ??
      unique(methods.filter((n) => imported.has(n.file) || pkg.has(n.file)), 'low') ??
      unique(methods, 'low')
    );
  }

  /** Files reachable from this one through its import statements. */
  importedFiles(file: ExtractedFile): Set<string> {
    let set = this.importCache.get(file.path);
    if (set) return set;
    set = new Set();
    const spec = specForId(file.language);
    for (const source of file.imports) for (const p of this.index.resolve(spec?.resolveImport?.(file.path, source) ?? null)) set.add(p);
    set.delete(file.path);
    this.importCache.set(file.path, set);
    return set;
  }

  private packageCache = new Map<string, Set<string>>();

  /** Files in the same package, for languages where that makes them visible without imports. */
  packageFiles(file: ExtractedFile): Set<string> {
    let set = this.packageCache.get(file.path);
    if (set) return set;
    set = new Set();
    const spec = specForId(file.language);
    if (spec?.sameDirectoryVisible) {
      for (const p of this.dirFiles.get(dirname(file.path)) ?? []) if (p !== file.path && this.files.get(p)?.language === file.language) set.add(p);
    }
    this.packageCache.set(file.path, set);
    return set;
  }
}

/** `crate::payments` → `payments`, `com.acme.Payments` → `Payments`, `$this->repo` → `repo`. */
export function lastPathPart(expr: string): string {
  const parts = expr.split(/::|->|\.|\\/).filter(Boolean);
  return parts.at(-1) ?? expr;
}
