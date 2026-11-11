import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { call, Markdown } from './Discussion.tsx';
import { displayName, type FnNode } from './data.ts';

// "Ask": a conversation with the review's model about the change, from inside the review. It lives
// outside any component so it survives switching views and changes; it is not saved anywhere.

interface Turn {
  role: 'user' | 'assistant';
  content: string;
  /** The change that was open when this was asked. */
  about?: string;
}

interface ChatState {
  turns: Turn[];
  session?: string;
  pending: boolean;
  error?: string;
}

let state: ChatState = { turns: [], pending: false };
const listeners = new Set<() => void>();
const set = (next: Partial<ChatState>) => {
  state = { ...state, ...next };
  listeners.forEach((l) => l());
};
const useChatState = () =>
  useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => state,
  );

export interface ChatInfo {
  provider: string;
  canRead: boolean;
}

let info: Promise<ChatInfo | null> | undefined;
/** The model "Ask" talks to, or null when the review was opened without one. */
export function useChatInfo(): ChatInfo | null {
  const [value, setValue] = useState<ChatInfo | null>(null);
  useEffect(() => {
    info ??= call<{ chat?: ChatInfo | null }>('/api/session').then((s) => s.chat ?? null, () => null);
    let live = true;
    info.then((v) => live && setValue(v));
    return () => {
      live = false;
    };
  }, []);
  return value;
}

async function ask(question: string, focus: FnNode | undefined) {
  const turns: Turn[] = [...state.turns, { role: 'user', content: question, about: focus ? displayName(focus) : undefined }];
  set({ turns, pending: true, error: undefined });
  try {
    const reply = await call<{ text: string; session?: string }>('/api/chat', {
      messages: turns.map(({ role, content }) => ({ role, content })),
      focus: focus?.id,
      session: state.session,
    });
    set({ turns: [...turns, { role: 'assistant', content: reply.text || '(no answer)' }], session: reply.session ?? state.session, pending: false });
  } catch (err) {
    set({ pending: false, error: (err as Error).message });
  }
}

const SUGGESTIONS = ['Why is this change risky?', 'Does similar code already exist elsewhere?', 'What could break for the callers?', 'Any performance concerns here?'];

export function ChatPanel({ chat, focus, onClose }: { chat: ChatInfo; focus?: FnNode; onClose: () => void }) {
  const { turns, pending, error } = useChatState();
  const [draft, setDraft] = useState('');
  const box = useRef<HTMLTextAreaElement>(null);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => box.current?.focus(), []);
  useEffect(() => end.current?.scrollIntoView({ block: 'end' }), [turns.length, pending]);
  const send = (text = draft) => {
    const q = text.trim();
    if (!q || pending) return;
    setDraft('');
    void ask(q, focus);
  };

  return (
    <aside
      className="chat-panel"
      aria-label="Ask about this change"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <header className="chat-head">
        <div>
          <div className="chat-title">Ask {chat.provider.split(':')[0] === 'claude-code' ? 'Claude' : chat.provider.split(':')[0]}</div>
          <div className="chat-sub">{chat.canRead ? 'Can read the whole codebase as it is after this change (read-only)' : 'Answers from this review (no file access)'}</div>
        </div>
        <div className="chat-head-actions">
          {turns.length > 0 && (
            <button className="link small" onClick={() => set({ turns: [], session: undefined, error: undefined })} disabled={pending}>
              New chat
            </button>
          )}
          <button className="icon-btn" onClick={onClose} aria-label="Close" title="Close (Esc)">
            ✕
          </button>
        </div>
      </header>

      <div className="chat-body">
        {turns.length === 0 && (
          <div className="chat-empty">
            <p className="muted">Ask anything about this change. {focus ? <>Your question includes the change you have open.</> : null}</p>
            <div className="chat-suggestions">
              {SUGGESTIONS.map((s) => (
                <button key={s} className="chat-suggestion" onClick={() => send(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {turns.map((t, i) => (
          <div key={i} className={`chat-turn chat-${t.role}`}>
            {t.role === 'user' ? (
              <>
                {t.about && <div className="chat-about mono">re {t.about}</div>}
                <div className="chat-question">{t.content}</div>
              </>
            ) : (
              <Markdown text={t.content} />
            )}
          </div>
        ))}
        {pending && <div className="chat-turn chat-assistant chat-pending">{chat.canRead ? 'Reading the code…' : 'Thinking…'}</div>}
        {error && <div className="chat-error">Couldn't answer: {error}</div>}
        <div ref={end} />
      </div>

      <footer className="chat-foot">
        {focus && <div className="chat-focus mono">About: {displayName(focus)}</div>}
        <textarea
          ref={box}
          value={draft}
          rows={3}
          placeholder="Ask about this change… (Enter to send, Shift+Enter for a new line)"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <button className="btn btn-primary" onClick={() => send()} disabled={pending || !draft.trim()}>
          Ask
        </button>
      </footer>
    </aside>
  );
}
