/**
 * Keyboard-shortcut helpers shared by Chrome's global key handler and the
 * per-page row navigators (j/k/Enter in list views).
 *
 * The model is deliberately tiny: components register their own keydown
 * listeners and use the helpers below to decide whether to react. We don't
 * have a central registry — that would force every page to declare its
 * shortcuts up front, and a few useEffects scattered across the tree are
 * simpler to read.
 */

/**
 * True if focus is in a text input where the user is plausibly typing —
 * input, textarea, select, or any contenteditable. Used to suppress
 * single-letter shortcuts so the user can type "c" into the To field
 * without launching the composer.
 */
export function isEditableTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (el.isContentEditable) return true;
  return false;
}

/**
 * True if this keydown carries any non-shift modifier. Shift alone is fine
 * (it's how "?" is reached on most layouts).
 */
export function hasMod(e: KeyboardEvent): boolean {
  return e.metaKey || e.ctrlKey || e.altKey;
}

/** Cmd on macOS, Ctrl elsewhere. */
export function isModK(e: KeyboardEvent): boolean {
  return (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k';
}
