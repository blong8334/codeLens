/**
 * Whether a key press belongs to what the reviewer is doing rather than to a single-key shortcut:
 * typing in any field, holding a modifier, or anything inside the Ask panel or another popup marked
 * `data-no-shortcuts` (a conversation there must never be cut off by a shortcut that leaves the review).
 */
export function notAShortcut(e: KeyboardEvent): boolean {
  const t = e.target;
  if (e.metaKey || e.ctrlKey || e.altKey) return true;
  if (!(t instanceof HTMLElement)) return false;
  return t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement || t.isContentEditable || !!t.closest('.chat-panel, [data-no-shortcuts]');
}
