import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { displayName, type Index } from './data.ts';
import { Compose, ThreadView, useDiscussion } from './Discussion.tsx';
import { codeLinks } from './links.ts';
import { MarkBox, ReviewProgress, useMarks } from './Marks.tsx';
import type { PrThread, ReviewFile } from '../../cli/src/types.ts';

type Kind = 'add' | 'del' | 'ctx';
interface Line {
  kind: Kind;
  old?: number;
  new?: number;
  text: string;
}
interface Hunk {
  header: string;
  lines: Line[];
}

/** Unified diff hunks (from the first `@@`) → numbered lines. `offset` shifts both sides (function-only diffs). */
export function parseHunks(patch: string, offset = 0): Hunk[] {
  const hunks: Hunk[] = [];
  let oldNo = 0;
  let newNo = 0;
  for (const raw of patch.split('\n')) {
    const h = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
    if (h) {
      oldNo = Number(h[1]) + offset;
      newNo = Number(h[2]) + offset;
      hunks.push({ header: h[3].trim(), lines: [] });
      continue;
    }
    const hunk = hunks.at(-1);
    if (!hunk || raw.startsWith('\\')) continue;
    if (raw.startsWith('+')) hunk.lines.push({ kind: 'add', new: newNo++, text: raw.slice(1) });
    else if (raw.startsWith('-')) hunk.lines.push({ kind: 'del', old: oldNo++, text: raw.slice(1) });
    else hunk.lines.push({ kind: 'ctx', old: oldNo++, new: newNo++, text: raw.slice(1) });
  }
  return hunks;
}

/** Side-by-side rows: removals and additions in the same run share rows. */
function splitRows(lines: Line[]): [Line | undefined, Line | undefined][] {
  const rows: [Line | undefined, Line | undefined][] = [];
  for (let i = 0; i < lines.length; ) {
    if (lines[i].kind === 'ctx') {
      rows.push([lines[i], lines[i]]);
      i++;
      continue;
    }
    const dels: Line[] = [];
    const adds: Line[] = [];
    while (i < lines.length && lines[i].kind === 'del') dels.push(lines[i++]);
    while (i < lines.length && lines[i].kind === 'add') adds.push(lines[i++]);
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) rows.push([dels[k], adds[k]]);
  }
  return rows;
}

const threadKey = (side: 'LEFT' | 'RIGHT', line: number) => `${side}:${line}`;

interface Props {
  ix: Index;
  path: string;
  /** Highlight and scroll to this function. */
  fnId?: string;
  onClose: () => void;
  onOpen: (path: string) => void;
}

/** The whole-screen diff of one file: unified or side by side, with review threads inline. */
export function DiffViewer({ ix, path, fnId, onClose, onOpen }: Props) {
  const file = ix.graph.review?.files.find((f) => f.path === path);
  const fn = fnId ? ix.fns.get(fnId) : undefined;
  const { discussion, canPost, lineComment } = useDiscussion();
  const { reviewed } = useMarks();
  const [split, setSplit] = useState(() => {
    try {
      return localStorage.getItem('codelens.diffSplit') === '1';
    } catch {
      return false;
    }
  });
  const [composing, setComposing] = useState<{ side: 'LEFT' | 'RIGHT'; line: number } | null>(null);
  const body = useRef<HTMLDivElement>(null);

  // The whole file when the graph carries it; else the function's own diff.
  const hunks = useMemo(() => (file?.patch ? parseHunks(file.patch) : fn?.diff ? parseHunks(fn.diff, fn.range.startLine - 1) : []), [file, fn]);
  const threads = (discussion?.threads ?? []).filter((t) => t.path === path);
  const placed = new Map<string, PrThread[]>();
  for (const t of threads) if (!t.outdated && t.line !== null) (placed.get(threadKey(t.side, t.line)) ?? placed.set(threadKey(t.side, t.line), []).get(threadKey(t.side, t.line))!).push(t);
  const outdated = threads.filter((t) => t.outdated || t.line === null);
  const inFn = (l: Line | undefined) => !!fn && !!l?.new && l.new >= fn.range.startLine && l.new <= fn.range.endLine;

  // Files in path order (as GitHub lists them); next/previous skip ones already reviewed.
  const files = useMemo(() => [...(ix.graph.review?.files ?? [])].sort((a, b) => a.path.localeCompare(b.path)), [ix]);
  const step = (dir: 1 | -1) => {
    const at = files.findIndex((f) => f.path === path);
    for (let k = 1; k <= files.length; k++) {
      const f = files[(at + dir * k + files.length * k) % files.length];
      if (!reviewed.has(f.path) && f.path !== path) return onOpen(f.path);
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement || e.metaKey || e.ctrlKey || e.altKey) return;
      const handled = e.key === 'Escape' ? (onClose(), true) : e.key === ']' ? (step(1), true) : e.key === '[' ? (step(-1), true) : e.key === 'v' ? (toggleSplit(), true) : false;
      if (handled) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });
  // Bring the function (or the first change) into view when a file opens.
  useEffect(() => {
    const target = body.current?.querySelector('.in-fn.dl-add, .in-fn.dl-del, .in-fn') ?? body.current?.querySelector('.dl-add, .dl-del');
    target?.scrollIntoView({ block: 'center' });
  }, [path, fnId]);

  const toggleSplit = () =>
    setSplit((v) => {
      try {
        localStorage.setItem('codelens.diffSplit', v ? '0' : '1');
      } catch {
        // Not remembered: fine.
      }
      return !v;
    });

  const lineButton = (side: 'LEFT' | 'RIGHT', n: number | undefined) =>
    n === undefined ? (
      <td className="ln" />
    ) : canPost ? (
      <td className="ln ln-action" title={`Comment on line ${n}`} onClick={() => setComposing({ side, line: n })}>
        {n}
      </td>
    ) : (
      <td className="ln">{n}</td>
    );

  const extras = (l: Line | undefined, side: 'LEFT' | 'RIGHT', span: number) => {
    const n = side === 'RIGHT' ? l?.new : l?.old;
    if (n === undefined) return null;
    const here = placed.get(threadKey(side, n)) ?? [];
    const compose = composing && composing.side === side && composing.line === n;
    if (!here.length && !compose) return null;
    return (
      <tr className="dl-thread">
        <td colSpan={span}>
          {here.map((t) => (
            <ThreadView key={t.id} thread={t} />
          ))}
          {compose && (
            <Compose
              placeholder={`Comment on line ${n}…`}
              actions={[
                { label: 'Comment', primary: true, run: (text) => lineComment(path, n, side, text).then((u) => (setComposing(null), u)) },
                { label: 'Cancel', allowEmpty: true, run: async () => (setComposing(null), '') },
              ]}
            />
          )}
        </td>
      </tr>
    );
  };

  const link = codeLinks(ix.graph, path).web;
  return (
    <div className="diff-overlay" role="dialog" aria-label={`Diff of ${path}`}>
      <div className="diff-overlay-head">
        <div className="diff-overlay-title">
          <span className="mono">{path}</span>
          {file && (
            <span className="file-row-meta">
              <span className={`badge status-${file.status === 'renamed' ? 'modified' : file.status}`}>{file.status}</span>
              <span className="pr-add">+{file.additions}</span>
              <span className="pr-del">−{file.deletions}</span>
            </span>
          )}
          {fn && <span className="muted small">· {displayName(fn)}</span>}
        </div>
        <div className="diff-overlay-actions">
          <ReviewProgress compact />
          {file && <MarkBox path={path} />}
          <div className="view-switch" role="tablist" aria-label="Diff layout">
            <button className={!split ? 'active' : ''} onClick={() => split && toggleSplit()} title="Unified (v)">
              Unified
            </button>
            <button className={split ? 'active' : ''} onClick={() => !split && toggleSplit()} title="Side by side (v)">
              Split
            </button>
          </div>
          <button className="icon-btn" onClick={() => step(-1)} title="Previous unreviewed file ([)">
            ‹ File
          </button>
          <button className="icon-btn" onClick={() => step(1)} title="Next unreviewed file (])">
            File ›
          </button>
          {link && (
            <a className="btn btn-small" href={link} target="_blank" rel="noreferrer">
              ↗ GitHub
            </a>
          )}
          <button className="icon-btn diff-close" onClick={onClose} title="Close (Esc)" aria-label="Close">
            ✕
          </button>
        </div>
      </div>
      <div className="diff-overlay-body" ref={body}>
        {outdated.length > 0 && (
          <details className="diff-outdated">
            <summary>
              {outdated.length} outdated comment thread{outdated.length > 1 ? 's' : ''} (the code changed since)
            </summary>
            {outdated.map((t) => (
              <ThreadView key={t.id} thread={t} />
            ))}
          </details>
        )}
        {!hunks.length && <p className="empty-note muted">No line changes to show for this file{file && !file.patch ? ' (its diff is too large, or this graph was saved without source)' : ''}.</p>}
        <table className={`diff mono diff-big ${split ? 'diff-split' : ''}`}>
          <tbody>
            {hunks.map((h, hi) => (
              <Fragment key={hi}>
                <tr className="diff-hunk">
                  <td colSpan={split ? 4 : 3}>{h.header ? `@@ ${h.header}` : '@@'}</td>
                </tr>
                {split
                  ? splitRows(h.lines).map(([l, r], ri) => (
                      <Fragment key={ri}>
                        <tr className={inFn(r) ? 'in-fn' : ''}>
                          {lineButton('LEFT', l?.old)}
                          <td className={`code ${l ? (l.kind === 'del' ? 'dl-del' : '') : 'dl-empty'}`}>{l?.text ?? ''}</td>
                          {lineButton('RIGHT', r?.new)}
                          <td className={`code ${r ? (r.kind === 'add' ? 'dl-add' : '') : 'dl-empty'}`}>{r?.text ?? ''}</td>
                        </tr>
                        {extras(l?.kind === 'del' ? l : undefined, 'LEFT', 4)}
                        {extras(r, 'RIGHT', 4)}
                      </Fragment>
                    ))
                  : h.lines.map((l, li) => (
                      <Fragment key={li}>
                        <tr className={`dl-${l.kind} ${inFn(l) ? 'in-fn' : ''}`}>
                          {lineButton('LEFT', l.kind !== 'add' ? l.old : undefined)}
                          {lineButton('RIGHT', l.kind !== 'del' ? l.new : undefined)}
                          <td className="code">
                            <span className="sign">{l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' '}</span>
                            {l.text}
                          </td>
                        </tr>
                        {extras(l, l.kind === 'del' ? 'LEFT' : 'RIGHT', 3)}
                      </Fragment>
                    ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
      <div className="diff-overlay-foot muted small">
        {canPost ? 'Click a line number to comment · ' : ''}
        <kbd>v</kbd> unified / split · <kbd>[</kbd> <kbd>]</kbd> previous / next unreviewed file · <kbd>Esc</kbd> close
      </div>
    </div>
  );
}

export type { ReviewFile };
