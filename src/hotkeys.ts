/**
 * Should a single-letter shortcut (A, D, R, M) act on this key press?
 *
 * Not while the pilot is typing: a text or number field gets its letters. But a
 * dropdown keeps keyboard focus after it is used, and ignoring keys there made
 * R do nothing after picking a map, until something else was clicked; the
 * pilot read that as a broken reset. On a dropdown the shortcut acts, and
 * `preventDefault` stops the dropdown's own type-ahead, which would otherwise
 * jump the map list to "Race vibes" on an R.
 */
export function shortcutAllowed(e: KeyboardEvent): boolean {
  if (e.ctrlKey || e.metaKey || e.altKey) return false;
  const t = e.target;
  if (t instanceof HTMLTextAreaElement) return false;
  if (t instanceof HTMLInputElement) {
    const typing = ['text', 'number', 'search', 'email', 'url', 'password', 'tel'];
    if (typing.includes(t.type)) return false;
  }
  if (t instanceof HTMLSelectElement) e.preventDefault();
  return true;
}
