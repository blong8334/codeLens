import { useEffect, useRef, useState } from 'react';
import { call } from './Discussion.tsx';

// Feedback goes to the project's GitHub issues: the button opens a new issue, prefilled with what
// you wrote and the CodeLens version, for you to look over and submit. Nothing from the review
// (code, file names, titles) is ever added: reviews are often of private code.

const REPO = 'https://github.com/blong8334/codeLens';
const KINDS = [
  { id: 'bug', label: 'Something broke' },
  { id: 'idea', label: 'Idea' },
  { id: 'other', label: 'Other' },
] as const;
type Kind = (typeof KINDS)[number]['id'];

let version: Promise<string | undefined> | undefined;
const useVersion = () => {
  const [v, setV] = useState<string>();
  useEffect(() => {
    version ??= call<{ version?: string }>('/api/session').then((s) => s.version, () => undefined);
    let live = true;
    version.then((x) => live && setV(x));
    return () => {
      live = false;
    };
  }, []);
  return v;
};

/** The new-issue URL for a note: what the reviewer wrote, the kind, and the version. Nothing else. */
export function issueUrl(kind: Kind, text: string, ver?: string): string {
  const note = text.trim().slice(0, 6000);
  const first = note.split('\n')[0].slice(0, 80);
  const prefix = kind === 'bug' ? 'Bug: ' : kind === 'idea' ? 'Idea: ' : '';
  const body = `${note}\n\n---\nCodeLens ${ver ?? '(unknown version)'} · sent from the review viewer`;
  return `${REPO}/issues/new?${new URLSearchParams({ title: `${prefix}${first}`, body })}`;
}

export function FeedbackButton() {
  const [open, setOpen] = useState(false);
  return (
    <div className="feedback" data-no-shortcuts>
      <button className="btn btn-ghost" onClick={() => setOpen(!open)} aria-expanded={open} title="Report a bug or suggest an idea">
        Feedback
      </button>
      {open && <FeedbackForm onClose={() => setOpen(false)} />}
    </div>
  );
}

function FeedbackForm({ onClose }: { onClose: () => void }) {
  const ver = useVersion();
  const [kind, setKind] = useState<Kind>('bug');
  const [text, setText] = useState('');
  const box = useRef<HTMLTextAreaElement>(null);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    box.current?.focus();
    const away = (e: MouseEvent) => {
      if (root.current && !root.current.parentElement?.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [onClose]);
  const send = () => {
    if (!text.trim()) return;
    window.open(issueUrl(kind, text, ver), '_blank', 'noopener');
    setText('');
    onClose();
  };

  return (
    <div
      ref={root}
      className="feedback-pop"
      role="dialog"
      aria-label="Send feedback"
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send();
      }}
    >
      <div className="feedback-title">Send feedback</div>
      <div className="feedback-kinds" role="radiogroup">
        {KINDS.map((k) => (
          <button key={k.id} role="radio" aria-checked={kind === k.id} className={`feedback-kind ${kind === k.id ? 'is-on' : ''}`} onClick={() => setKind(k.id)}>
            {k.label}
          </button>
        ))}
      </div>
      <textarea
        ref={box}
        rows={5}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={kind === 'bug' ? 'What happened, and what did you expect?' : kind === 'idea' ? 'What would make reviews better?' : 'What’s on your mind?'}
      />
      <p className="feedback-note muted">
        Opens a new GitHub issue with your note and the CodeLens version{ver ? ` (${ver})` : ''}, for you to check and submit. Nothing from this review is included, so leave out anything private.
      </p>
      <div className="feedback-actions">
        <button className="link small" onClick={onClose}>
          Cancel
        </button>
        <button className="btn btn-primary" onClick={send} disabled={!text.trim()}>
          Continue on GitHub ↗
        </button>
      </div>
    </div>
  );
}
