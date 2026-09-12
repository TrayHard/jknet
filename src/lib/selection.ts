/**
 * Text selection and the menu the webview would open on a right click.
 *
 * --- slice: selection context menu ---
 * Two rules that belong together, because both decide what a mouse press means
 * on a page that is now selectable: a drag across a row is a selection rather
 * than a press on the row, and a right click anywhere is the launcher's own
 * menu rather than the one Chromium ships with.
 */

/**
 * Whether the player has just selected text with the pointer.
 *
 * A row of the server table is both something to select and something to read
 * out of, and the two meet on the same press: the drag that paints the name of
 * a server ends with a `click` on the row underneath it. Pressing the button
 * collapses whatever was selected before, so a selection that is still alive
 * when the click arrives is the one the player made with that very drag — and
 * a click that only marks a row leaves nothing behind for this to find.
 */
export function hasTextSelection(): boolean {
  const selection = window.getSelection();
  if (selection === null || selection.isCollapsed) return false;
  return selection.toString().trim() !== "";
}

/**
 * Takes the webview's own context menu off the launcher.
 *
 * The menu Chromium opens holds **Back**, **Reload** and **View page source**,
 * and in a debug build **Inspect**: four answers to questions nobody asks of a
 * launcher, on top of a window that draws its own everything. The screens put
 * their own menu in its place through `useContextMenu` in the UI kit.
 *
 * A field is the exception, and the only one. **Cut**, **Copy** and **Paste**
 * on a text field are what the system menu is for, they are what a player
 * expects from a right click there, and nothing in the launcher replaces them.
 *
 * Bound to the document rather than to a component: every window of the
 * launcher runs this same bundle, so one call in `main.tsx` covers the main
 * window and every client window with it. The returned function unbinds, which
 * is what a test needs and the app never does.
 */
export function blockNativeContextMenu(): () => void {
  const onContextMenu = (event: MouseEvent) => {
    if (isEditable(event.target)) return;
    event.preventDefault();
  };
  document.addEventListener("contextmenu", onContextMenu);
  return () => document.removeEventListener("contextmenu", onContextMenu);
}

/** A field the system menu still belongs to: an input, a textarea, rich text. */
function isEditable(target: EventTarget | null): boolean {
  if (target instanceof HTMLInputElement) return true;
  if (target instanceof HTMLTextAreaElement) return true;
  return target instanceof HTMLElement && target.isContentEditable;
}
