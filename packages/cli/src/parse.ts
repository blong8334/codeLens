import Parser from 'web-tree-sitter';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { extract, type ExtractedFile } from './lang/engine.ts';
import { specForPath, type LanguageSpec } from './lang/index.ts';
import type { Snapshot } from './source.ts';
import type { Store } from './store.ts';

export type { ExtractedCall, ExtractedFile, ExtractedFn } from './lang/engine.ts';

const require = createRequire(import.meta.url);

let initialized: Promise<void> | null = null;
const parsers = new Map<string, Promise<{ parser: Parser; language: Parser.Language }>>();

function parserFor(spec: LanguageSpec) {
  let p = parsers.get(spec.id);
  if (!p) {
    p = (async () => {
      initialized ??= Parser.init();
      await initialized;
      const language = await Parser.Language.load(require.resolve(`tree-sitter-wasms/out/${spec.grammar}`));
      const parser = new Parser();
      parser.setLanguage(language);
      return { parser, language };
    })();
    parsers.set(spec.id, p);
  }
  return p;
}

/** The language id for a path, or null when no supported language claims it. */
export function languageFor(path: string): string | null {
  return specForPath(path)?.id ?? null;
}

export async function parseFile(path: string, source: string): Promise<ExtractedFile | null> {
  const spec = specForPath(path);
  if (!spec) return null;
  const { parser, language } = await parserFor(spec);
  const tree = parser.parse(source);
  try {
    return { path, language: spec.id, ...extract(spec, language, tree.rootNode) };
  } finally {
    tree.delete();
  }
}

// ---- cached parsing of a whole snapshot ----

/**
 * Changes whenever the extraction code does (the engine, any language plugin, this file), so
 * cached parses from an older CodeLens are never reused.
 */
export const EXTRACTOR_VERSION: string = (() => {
  const h = createHash('sha1');
  const langDir = new URL('./lang/', import.meta.url);
  for (const name of readdirSync(langDir).sort()) if (name.endsWith('.ts')) h.update(readFileSync(new URL(name, langDir)));
  h.update(readFileSync(new URL(import.meta.url)));
  return h.digest('hex').slice(0, 12);
})();

export const MAX_FILE_BYTES = 512 * 1024;

export interface LoadStats {
  parsed: number;
  cached: number;
  skipped: number;
}

/** Parse every source file of a snapshot that `include` accepts, reusing cached parses by blob id. */
export async function loadFiles(
  snapshot: Snapshot,
  opts: { include: (path: string) => boolean; store?: Store },
): Promise<{ files: Map<string, ExtractedFile>; stats: LoadStats }> {
  const files = new Map<string, ExtractedFile>();
  const stats: LoadStats = { parsed: 0, cached: 0, skipped: 0 };
  const store = opts.store;
  // Batch inserts into transactions: thousands of small writes become a few disk syncs.
  let pending = 0;
  store?.begin();
  try {
    for (const f of snapshot.files) {
      const spec = specForPath(f.path);
      if (!spec || !opts.include(f.path)) continue;
      if ((f.size ?? 0) > MAX_FILE_BYTES) {
        stats.skipped++;
        continue;
      }
      const extractor = `${spec.id}:${EXTRACTOR_VERSION}`;
      const hit = store?.getParse(f.blob, extractor);
      if (hit) {
        files.set(f.path, { ...(JSON.parse(hit) as Omit<ExtractedFile, 'path'>), path: f.path });
        stats.cached++;
        continue;
      }
      const source = await snapshot.read(f);
      if (source == null || source.length > MAX_FILE_BYTES) {
        stats.skipped++;
        continue;
      }
      const parsed = await parseFile(f.path, source);
      if (!parsed) continue;
      files.set(f.path, parsed);
      stats.parsed++;
      if (store) {
        const { path: _path, ...data } = parsed;
        store.putParse(f.blob, extractor, JSON.stringify(data));
        if (++pending >= 200) {
          store.commit();
          store.begin();
          pending = 0;
        }
      }
    }
  } finally {
    store?.commit();
  }
  return { files, stats };
}
