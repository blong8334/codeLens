import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Optional `.codelens.json` at the repository root. Everything is optional; anything not
 * listed falls back to auto-detection.
 *
 * {
 *   "systems":     { "Payments": ["src/services/payments.ts", "src/lib/money.ts"] },
 *   "modules":     { "Checkout flow": ["src/services/orders.ts", "src/services/inventory.ts"] },
 *   "entryPoints": ["src/api/**", "worker/reconcile.py#reconcile"],
 *   "sinks":       { "network": ["gateway"], "billing": ["stripe"] },
 *   "ignore":      ["**\/generated/**"]
 * }
 *
 * Patterns are globs over repo-relative paths (`*`, `**`, `?`). Append `#name` to match a
 * function by qualified name within matching files (the name part is a glob too).
 */
export interface CodeLensConfig {
  systems?: Record<string, string[]>;
  modules?: Record<string, string[]>;
  entryPoints?: string[];
  /** Sink category → identifiers or package names that count as that external effect. */
  sinks?: Record<string, string[]>;
  ignore?: string[];
}

export const CONFIG_FILES = ['.codelens.json', 'codelens.config.json'];

export async function loadConfig(root: string): Promise<{ config: CodeLensConfig; path?: string }> {
  for (const name of CONFIG_FILES) {
    let text: string;
    try {
      text = await readFile(join(root, name), 'utf8');
    } catch {
      continue;
    }
    try {
      return { config: JSON.parse(text) as CodeLensConfig, path: name };
    } catch (err) {
      throw new Error(`${name}: invalid JSON (${(err as Error).message})`);
    }
  }
  return { config: {} };
}

const globCache = new Map<string, RegExp>();

export function globToRegExp(glob: string): RegExp {
  let re = globCache.get(glob);
  if (re) return re;
  let src = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        const slash = glob[i + 2] === '/';
        src += slash ? '(?:.*/)?' : '.*';
        i += slash ? 2 : 1;
      } else src += '[^/]*';
    } else if (c === '?') src += '[^/]';
    else src += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  re = new RegExp(`^${src}$`);
  globCache.set(glob, re);
  return re;
}

/** Does `pattern` (optionally `path#fnName`) match this file / function? */
export function matches(pattern: string, path: string, qualifiedName?: string): boolean {
  const [pathGlob, nameGlob] = pattern.split('#');
  if (!globToRegExp(pathGlob).test(path)) return false;
  if (nameGlob === undefined) return true;
  return qualifiedName !== undefined && globToRegExp(nameGlob).test(qualifiedName);
}

/** First key of a `{ name: patterns[] }` map whose patterns match. */
export function firstMatch(map: Record<string, string[]> | undefined, path: string, qualifiedName?: string): string | undefined {
  for (const [name, patterns] of Object.entries(map ?? {})) {
    if (patterns.some((p) => matches(p, path, qualifiedName))) return name;
  }
  return undefined;
}
