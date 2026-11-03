import { forwardRef, useMemo, useState } from 'react';
import { displayName, type FnNode, type Group, type Index } from './data.ts';

export type SearchHit = { kind: 'fn'; fn: FnNode; score: number } | { kind: 'group'; group: Group; score: number };

const MAX_RESULTS = 12;

/** Rank how well `query` matches `text`: exact > prefix > word start > substring > in-order letters. */
function matchScore(query: string, text: string): number {
  const t = text.toLowerCase();
  if (t === query) return 100;
  if (t.startsWith(query)) return 80 - Math.min(20, t.length - query.length) / 2;
  const i = t.indexOf(query);
  if (i >= 0) return (/[\s._/#:-]/.test(t[i - 1] ?? '') || /[A-Z]/.test(text[i]) ? 60 : 45) - Math.min(15, i) / 3;
  // Subsequence: every query character, in order.
  let j = 0;
  let gaps = 0;
  for (let k = 0; k < t.length && j < query.length; k++) {
    if (t[k] === query[j]) j++;
    else if (j > 0) gaps++;
  }
  return j === query.length ? Math.max(5, 30 - gaps) : 0;
}

export function search(ix: Index, raw: string): SearchHit[] {
  const query = raw.trim().toLowerCase();
  if (!query) return [];
  const hits: SearchHit[] = [];
  for (const fn of ix.fns.values()) {
    const s = Math.max(matchScore(query, fn.name), matchScore(query, fn.qualifiedName) - 2, matchScore(query, fn.file) - 25);
    if (s > 0) hits.push({ kind: 'fn', fn, score: s + (fn.outside ? -10 : 0) + (fn.entry && fn.entry.kind !== 'test' ? 3 : 0) + (ix.hotspots.has(fn.id) ? 4 : 0) });
  }
  for (const group of ix.groups.values()) {
    const s = Math.max(matchScore(query, group.label), matchScore(query, group.path ?? '') - 5);
    if (s > 0) hits.push({ kind: 'group', group, score: s + (group.kind === 'file' ? 0 : 5) });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, MAX_RESULTS);
}

export const Search = forwardRef<HTMLInputElement, { ix: Index; onPick: (hit: SearchHit) => void }>(function Search({ ix, onPick }, ref) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState(false);
  const hits = useMemo(() => search(ix, query), [ix, query]);
  const pick = (hit: SearchHit | undefined) => {
    if (!hit) return;
    onPick(hit);
    setQuery('');
    setOpen(false);
    (ref as React.RefObject<HTMLInputElement> | null)?.current?.blur();
  };
  return (
    <div className="search">
      <input
        ref={ref}
        className="search-input"
        type="search"
        placeholder="Search functions, files, modules…  /"
        value={query}
        aria-label="Search"
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActive((a) => Math.min(hits.length - 1, a + 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((a) => Math.max(0, a - 1));
          } else if (e.key === 'Enter') pick(hits[active]);
          else if (e.key === 'Escape') {
            setQuery('');
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
      {open && query.trim() && (
        <div className="search-results" role="listbox">
          {hits.length === 0 && <div className="search-empty">No matches</div>}
          {hits.map((h, i) => (
            <button
              key={h.kind === 'fn' ? h.fn.id : h.group.id}
              role="option"
              aria-selected={i === active}
              className={`search-hit ${i === active ? 'active' : ''}`}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(h)}
            >
              {h.kind === 'fn' ? (
                <>
                  <span className="search-hit-main">
                    <span className="mono">{displayName(h.fn)}</span>
                    <span className="search-hit-sub">{h.fn.purpose?.what ?? h.fn.file}</span>
                  </span>
                  <span className="badge badge-quiet">{h.fn.entry && h.fn.entry.kind !== 'test' ? h.fn.entry.kind : 'fn'}</span>
                </>
              ) : (
                <>
                  <span className="search-hit-main">
                    <span>{h.group.label}</span>
                    <span className="search-hit-sub">{h.group.summary ?? h.group.path}</span>
                  </span>
                  <span className="badge badge-quiet">{h.group.kind}</span>
                </>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
});
