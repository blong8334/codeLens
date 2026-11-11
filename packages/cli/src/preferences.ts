// A reviewer's preferences: what they care about and what they skip, in their own words. Optional;
// without a file, reviews work exactly as before. The text goes to the model (brief and change
// notes); a "Skip" list naming tests or renames/moves also takes those out of the review queue.
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isTestFile } from './hierarchy.ts';
import type { CodeGraph, ReviewPreferences } from './types.ts';

export const defaultPreferencesPath = () => process.env.CODELENS_PREFERENCES ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'codelens', 'preferences.md');

/**
 * Read preferences from `path` (an explicit --prefs: missing is an error), else the default
 * location (missing is fine). `false` (--no-prefs) skips them.
 */
export async function loadPreferences(path?: string | false): Promise<ReviewPreferences | undefined> {
  if (path === false) return undefined;
  const file = path ?? defaultPreferencesPath();
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    if (path) throw new Error(`could not read preferences ${file}: ${(err as Error).message}`);
    return undefined;
  }
  return parsePreferences(text, file);
}

export function parsePreferences(text: string, source: string): ReviewPreferences | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  // Lines under a "skip" / "don't care" heading (or a single line starting that way).
  const skips: string[] = [];
  let inSkip = false;
  for (const line of trimmed.split('\n')) {
    const heading = line.match(/^\s*(?:#+\s*)?([^-*\s].*?):?\s*$/);
    const skipHead = /^(?:i\s+)?(?:skip|ignore|don'?t care|do not care|could not care less|not interested)/i;
    if (heading && !/^\s*[-*]/.test(line)) {
      const words = heading[1].replace(/^#+\s*/, '');
      inSkip = skipHead.test(words);
      const rest = words.match(/^(?:i\s+)?(?:skip|ignore|don'?t care about|do not care about|could not care less about)\s*:?\s*(.+)$/i)?.[1];
      if (inSkip && rest && !/^about$/i.test(rest)) skips.push(rest);
      continue;
    }
    if (inSkip) skips.push(line);
  }
  const skip = skips.join('\n');
  return {
    source,
    text: trimmed.slice(0, 4000),
    skipTests: /\btests?\b|\btesting\b|\bspecs?\b/i.test(skip),
    skipMoves: /renam|\bmove|moving|lift|shift|relocat/i.test(skip),
  };
}

/** Attach preferences to a review graph, and list what they skip (tests, unchanged moves). */
export function applyPreferences(graph: CodeGraph, prefs: ReviewPreferences | undefined): void {
  if (!graph.review || !prefs) return;
  graph.review.preferences = prefs;
  const skippedFn = (n: CodeGraph['nodes'][number]) => (prefs.skipTests && isTestFile(n.file)) || (prefs.skipMoves && !!n.moved?.exact);
  const changed = graph.nodes.filter((n) => n.status !== 'unchanged');
  const skipped = new Set(changed.filter(skippedFn).map((n) => n.id));
  for (const f of graph.review.files) {
    const fns = changed.filter((n) => n.file === f.path);
    // A file is skipped when everything in it is (or, for tests, when it is a test file).
    if ((prefs.skipTests && isTestFile(f.path)) || (fns.length > 0 && fns.every((n) => skipped.has(n.id)))) skipped.add(f.path);
  }
  graph.review.skipped = [...skipped];
}
