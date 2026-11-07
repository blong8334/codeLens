import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { CodeGraph } from './data.ts';
import { call } from './Discussion.tsx';
import type { ReviewFile } from '../../cli/src/types.ts';

/** reviewed: marked at the current diff · stale: marked, but the file changed since · open: not marked. */
export type MarkState = 'reviewed' | 'stale' | 'open';

interface MarksValue {
  enabled: boolean;
  files: ReviewFile[];
  /** A file's own mark. */
  state: (path: string) => MarkState;
  toggle: (path: string, reviewed: boolean) => void;
  /** A changed function's "accept change" mark. */
  fnState: (fnId: string) => MarkState;
  toggleFn: (fnId: string, accepted: boolean) => void;
  /** Files done: marked at their current diff, or every changed function in them accepted. */
  reviewed: Set<string>;
  /** Changed functions accepted at their current diff. */
  accepted: Set<string>;
  /** Changed function ids per file. */
  fnsByFile: Map<string, string[]>;
  progress: Progress;
  loaded: boolean;
  /** Clear every mark on this review: start over. */
  reset: () => void;
  error?: string;
}

export interface Progress {
  changes: { done: number; total: number };
  files: { done: number; total: number };
  lines: { done: number; total: number };
}
const NO_PROGRESS: Progress = { changes: { done: 0, total: 0 }, files: { done: 0, total: 0 }, lines: { done: 0, total: 0 } };

const Ctx = createContext<MarksValue>({
  enabled: false,
  files: [],
  state: () => 'open',
  toggle: () => {},
  fnState: () => 'open',
  toggleFn: () => {},
  reviewed: new Set(),
  accepted: new Set(),
  fnsByFile: new Map(),
  progress: NO_PROGRESS,
  loaded: false,
  reset: () => {},
});
export const useMarks = () => useContext(Ctx);

type Marks = Record<string, { fingerprint: string }>;
const localKey = (key: string) => `codelens.marks.${key}`;
const readLocal = (key: string): Marks => {
  try {
    return JSON.parse(localStorage.getItem(localKey(key)) ?? '{}') as Marks;
  } catch {
    return {};
  }
};

/**
 * "I'm good with this file" marks. Saved in the CodeLens store through `codelens view` (so they
 * survive restarts and are per reviewer); in this browser only when the page has no server.
 */
export function MarksProvider({ graph, children }: { graph: CodeGraph; children: ReactNode }) {
  const review = graph.review;
  const [marks, setMarks] = useState<Marks>({});
  const [server, setServer] = useState(false);
  // Controls wait for saved marks, so a click never acts on a not-yet-loaded state.
  const [loaded, setLoaded] = useState(false);
  const saving = useRef<Promise<void>>(Promise.resolve());
  const latest = useRef(0);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!review) return;
    call<{ marks: Marks }>('/api/review/marks')
      .then((r) => {
        setMarks(r.marks);
        setServer(true);
      })
      .catch(() => setMarks(readLocal(review.key)))
      .finally(() => setLoaded(true));
  }, [review?.key]); // eslint-disable-line react-hooks/exhaustive-deps

  const byPath = useMemo(() => new Map((review?.files ?? []).map((f) => [f.path, f])), [review]);
  const fnPrints = review?.functions ?? {};
  const markState = (key: string, current: string | undefined): MarkState => {
    const m = marks[key];
    if (!m) return 'open';
    return m.fingerprint === current ? 'reviewed' : 'stale';
  };
  const state = useCallback((path: string) => markState(path, byPath.get(path)?.fingerprint), [marks, byPath]); // eslint-disable-line react-hooks/exhaustive-deps
  const fnState = useCallback((id: string) => markState(id, fnPrints[id]), [marks, fnPrints]); // eslint-disable-line react-hooks/exhaustive-deps

  const fnsByFile = useMemo(() => {
    const out = new Map<string, string[]>();
    for (const id of Object.keys(fnPrints)) {
      const file = id.slice(0, id.indexOf('#'));
      (out.get(file) ?? out.set(file, []).get(file)!).push(id);
    }
    return out;
  }, [fnPrints]);

  type Change = { key: string; fingerprint: string | undefined; on: boolean; body: Record<string, unknown> };
  /** Apply several marks at once: optimistic locally, then saved in order on the server. */
  const apply = useCallback(
    (changes: Change[]) => {
      const valid = changes.filter((c) => c.fingerprint);
      if (!review || !valid.length) return;
      setMarks((m) => {
        const next = { ...m };
        for (const c of valid) {
          if (c.on) next[c.key] = { fingerprint: c.fingerprint! };
          else delete next[c.key];
        }
        if (!server) {
          try {
            localStorage.setItem(localKey(review!.key), JSON.stringify(next));
          } catch {
            // Storage unavailable: the marks last for this page only.
          }
        }
        return next;
      });
      if (!server) return;
      // Saves go out one at a time, in order, and only the newest batch's answer is shown: a slow
      // older response can never overwrite a newer accept or undo.
      const seq = ++latest.current;
      saving.current = saving.current.then(async () => {
        try {
          let last: Marks | undefined;
          for (const c of valid) last = (await call<{ marks: Marks }>('/api/review/mark', c.body)).marks;
          if (last && seq === latest.current) setMarks(last);
          setError(undefined);
        } catch (e) {
          setError((e as Error).message);
        }
      });
    },
    [review, server],
  );
  const reset = useCallback(() => {
    if (!review) return;
    setMarks({});
    if (!server) {
      try {
        localStorage.removeItem(localKey(review.key));
      } catch {
        // Nothing stored.
      }
      return;
    }
    const seq = ++latest.current;
    saving.current = saving.current.then(async () => {
      try {
        const r = await call<{ marks: Marks }>('/api/review/reset', {});
        if (seq === latest.current) setMarks(r.marks);
      } catch (e) {
        setError((e as Error).message);
      }
    });
  }, [review, server]);

  const fileMark = (path: string, on: boolean): Change => ({ key: path, fingerprint: byPath.get(path)?.fingerprint, on, body: { path, reviewed: on } });
  const fnMark = (id: string, on: boolean): Change => ({ key: id, fingerprint: fnPrints[id], on, body: { fnId: id, reviewed: on } });

  /** Check a file off, or reopen it — which reopens all of its changes too. */
  const toggle = useCallback(
    (path: string, on: boolean) => apply(on ? [fileMark(path, true)] : [fileMark(path, false), ...(fnsByFile.get(path) ?? []).filter((id) => marks[id]).map((id) => fnMark(id, false))]),
    [apply, fnsByFile, marks, byPath, fnPrints], // eslint-disable-line react-hooks/exhaustive-deps
  );
  /**
   * Accept one change, or un-accept it. Un-accepting a change in a file that was checked off as a
   * whole reopens only that change: the file's other changes stay accepted, individually.
   */
  const toggleFn = useCallback(
    (id: string, on: boolean) => {
      if (on) return apply([fnMark(id, true)]);
      const file = id.slice(0, id.indexOf('#'));
      if (!marks[file]) return apply([fnMark(id, false)]);
      const others = (fnsByFile.get(file) ?? []).filter((other) => other !== id && !marks[other]);
      apply([...others.map((other) => fnMark(other, true)), fileMark(file, false), fnMark(id, false)]);
    },
    [apply, fnsByFile, marks, byPath, fnPrints], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const accepted = useMemo(() => new Set(Object.keys(fnPrints).filter((id) => fnState(id) === 'reviewed')), [fnPrints, fnState]);
  const reviewed = useMemo(
    () =>
      new Set(
        (review?.files ?? [])
          .filter((f) => state(f.path) === 'reviewed' || (fnsByFile.get(f.path)?.length ? fnsByFile.get(f.path)!.every((id) => accepted.has(id)) : false))
          .map((f) => f.path),
      ),
    [review, state, fnsByFile, accepted],
  );

  // One measure for both ways of reviewing: a change is done when accepted or when its whole file is.
  const fnLines = useMemo(() => {
    const out = new Map<string, number>();
    for (const n of graph.nodes) if (fnPrints[n.id]) out.set(n.id, (n.diff ?? '').split('\n').filter((l) => /^[+-]/.test(l)).length);
    return out;
  }, [graph, fnPrints]);
  const progress = useMemo((): Progress => {
    const files = review?.files ?? [];
    const ids = Object.keys(fnPrints);
    const done = (id: string) => accepted.has(id) || reviewed.has(id.slice(0, id.indexOf('#')));
    let doneLines = 0;
    for (const f of files) {
      const size = f.additions + f.deletions;
      doneLines += reviewed.has(f.path) ? size : Math.min(size, (fnsByFile.get(f.path) ?? []).filter((id) => accepted.has(id)).reduce((n, id) => n + (fnLines.get(id) ?? 0), 0));
    }
    return {
      changes: { done: ids.filter(done).length, total: ids.length },
      files: { done: reviewed.size, total: files.length },
      lines: { done: doneLines, total: files.reduce((n, f) => n + f.additions + f.deletions, 0) },
    };
  }, [review, fnPrints, accepted, reviewed, fnsByFile, fnLines]);

  return (
    <Ctx.Provider value={{ enabled: !!review, files: review?.files ?? [], state, toggle, fnState, toggleFn, reviewed, accepted, fnsByFile, progress, loaded, reset, error }}>{children}</Ctx.Provider>
  );
}

/** The checkbox, wherever a file appears. */
export function MarkBox({ path, label = true }: { path: string; label?: boolean }) {
  const { enabled, state, toggle, reviewed, loaded } = useMarks();
  if (!enabled) return null;
  const own = state(path);
  const s: MarkState = reviewed.has(path) ? 'reviewed' : own;
  return (
    <label className={`mark-box mark-${s}`} title={s === 'stale' ? 'You reviewed this file, but it changed since' : "Mark this file as reviewed: “I'm good with this”"} onClick={(e) => e.stopPropagation()}>
      <input type="checkbox" disabled={!loaded} checked={s === 'reviewed'} onChange={(e) => toggle(path, e.target.checked)} />
      {label && <span>{s === 'reviewed' ? (own === 'reviewed' ? 'File reviewed' : 'All changes accepted') : s === 'stale' ? 'Changed since you reviewed' : "I'm good with this file"}</span>}
    </label>
  );
}

/** "Reset review": clear every check and acceptance, after an in-page confirmation. */
export function ResetMarks() {
  const { enabled, progress, reset, loaded } = useMarks();
  const [confirming, setConfirming] = useState(false);
  const count = progress.changes.done + progress.files.done;
  if (!enabled || !loaded) return null;
  if (!count && !confirming) return null;
  return confirming ? (
    <span className="reset-confirm" role="alert">
      Clear all {progress.changes.done} accepted change{progress.changes.done === 1 ? '' : 's'} and {progress.files.done} checked file{progress.files.done === 1 ? '' : 's'}?
      <button
        className="btn btn-small btn-danger"
        onClick={() => {
          reset();
          setConfirming(false);
        }}
      >
        Reset
      </button>
      <button className="btn btn-small" onClick={() => setConfirming(false)}>
        Cancel
      </button>
    </span>
  ) : (
    <button className="link small reset-link" onClick={() => setConfirming(true)} title="Clear every accepted change and checked file in this review">
      Reset review
    </button>
  );
}

/** "Accept change": approve one changed function, not its whole file. */
export function AcceptButton({ fnId }: { fnId: string }) {
  const { enabled, fnState, toggleFn, fnsByFile, loaded, reviewed } = useMarks();
  if (!enabled || !fnsByFile.size || ![...fnsByFile.values()].some((ids) => ids.includes(fnId))) return null;
  // Done by its own mark, or because its whole file was checked off.
  const own = fnState(fnId);
  const s: MarkState = own === 'stale' ? 'stale' : reviewed.has(fnId.slice(0, fnId.indexOf('#'))) ? 'reviewed' : own;
  return (
    <button
      disabled={!loaded}
      className={`btn accept-btn accept-${s}`}
      onClick={() => toggleFn(fnId, s !== 'reviewed')}
      title={s === 'reviewed' ? 'Undo: mark this change as not reviewed' : s === 'stale' ? 'You accepted this change, but it changed since' : 'Approve this change only (not the rest of its file)'}
    >
      {s === 'reviewed' ? (
        <>
          ✓ Accepted <span className="undo-hint">· undo</span>
        </>
      ) : s === 'stale' ? (
        '↻ Changed since accepted: accept again'
      ) : (
        '✓ Accept change'
      )}
    </button>
  );
}

/** Progress across the review, and every file smallest-first, to clear the easy ones quickly. */
/** How far the review has come: changes (accepted or in a reviewed file), files, and lines. */
export function ReviewProgress({ compact = false }: { compact?: boolean }) {
  const { enabled, progress: p, loaded } = useMarks();
  if (!enabled || !loaded || !(p.changes.total || p.files.total)) return null;
  const share = p.lines.total ? p.lines.done / p.lines.total : p.changes.total ? p.changes.done / p.changes.total : p.files.done / Math.max(1, p.files.total);
  const complete = p.files.done === p.files.total && p.changes.done === p.changes.total;
  return (
    <div className={`review-progress ${compact ? 'compact' : ''} ${complete ? 'complete' : ''}`} title={`${p.changes.done} of ${p.changes.total} changes · ${p.files.done} of ${p.files.total} files · ${p.lines.done} of ${p.lines.total} lines reviewed`}>
      <div className="progress-track">
        <div className="progress-fill" style={{ width: `${Math.round(share * 100)}%` }} />
      </div>
      <span className="progress-text">
        {compact ? (
          complete ? (
            'Reviewed ✓'
          ) : (
            <>
              <b>{p.changes.done}</b>/{p.changes.total} changes
            </>
          )
        ) : (
          <>
            <b>{p.changes.done}</b> of {p.changes.total} changes · <b>{p.files.done}</b> of {p.files.total} files · {p.lines.done} of {p.lines.total} lines
          </>
        )}
      </span>
    </div>
  );
}

export function FilesChecklist({ onOpen, onDiff }: { onOpen?: (path: string) => void; onDiff?: (path: string) => void }) {
  const { files, state, reviewed, accepted, fnsByFile, error } = useMarks();
  const [hideDone, setHideDone] = useState(false);
  if (!files.length) return null;
  const size = (f: ReviewFile) => f.additions + f.deletions;
  const sorted = [...files].sort((a, b) => Number(reviewed.has(a.path)) - Number(reviewed.has(b.path)) || size(a) - size(b) || a.path.localeCompare(b.path));
  const shown = hideDone ? sorted.filter((f) => !reviewed.has(f.path)) : sorted;
  return (
    <div className="files-checklist">
      <div className="progress-row">
        <ReviewProgress />
        <label className="hide-done">
          <input type="checkbox" checked={hideDone} onChange={(e) => setHideDone(e.target.checked)} /> hide reviewed
        </label>
        <ResetMarks />
      </div>
      {error && <p className="compose-result err">{error}</p>}
      <ul className="file-rows">
        {shown.map((f) => {
          const s: MarkState = reviewed.has(f.path) ? 'reviewed' : state(f.path);
          return (
            <li key={f.path} className={`file-row mark-${s}`}>
              <MarkBox path={f.path} label={false} />
              <button className="file-row-name mono" onClick={() => onOpen?.(f.path)} title={onOpen ? 'Show on the map' : undefined}>
                {f.path}
              </button>
              {s === 'stale' && <span className="badge status-modified">changed since</span>}
              <span className="file-row-meta">
                {onDiff && (
                  <button className="link small" onClick={() => onDiff(f.path)} title="Full-screen diff">
                    diff
                  </button>
                )}
                {f.functions > 0 && (
                  <span className="muted">
                    {(fnsByFile.get(f.path) ?? []).filter((id) => accepted.has(id)).length > 0 && !reviewed.has(f.path)
                      ? `${(fnsByFile.get(f.path) ?? []).filter((id) => accepted.has(id)).length}/${f.functions} accepted`
                      : `${f.functions} fn`}
                  </span>
                )}
                <span className="pr-add">+{f.additions}</span>
                <span className="pr-del">−{f.deletions}</span>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
