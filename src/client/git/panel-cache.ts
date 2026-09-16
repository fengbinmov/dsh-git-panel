/**
 * The panel's data, kept OUTSIDE React.
 *
 * The shell renders only the active view, so opening the Git tab mounts the panel
 * from scratch and it used to paint nothing until a host round trip came back — on
 * a machine where git.exe has gone cold that is a visible pause, and the chat and
 * trajectory tabs never have one because their data is already in the browser.
 *
 * So the last view is remembered at module scope: a re-opened tab paints the list
 * it showed a moment ago in its FIRST frame, and the refresh that follows replaces
 * it in place. The same store is what a warm-up (see `index.ts`) fills in before
 * the tab is even clicked.
 *
 * `undefined` means "never loaded" and `null` means "asked, and this workspace is
 * not a repository" — the panel shows different things for the two.
 * @module dsh-git-panel/client/git/panel-cache
 */

import type { StatusFilesView } from '../../core/types.ts'

let cached: StatusFilesView | null | undefined
let mounted = false

/** The last view, or `undefined` when nothing has ever been loaded. */
export function cachedStatus(): StatusFilesView | null | undefined {
  return cached
}

/** Remember what the panel is showing, for the next time it is mounted. */
export function rememberStatus(view: StatusFilesView | null): void {
  cached = view
}

/** Whether the panel is on screen (a warm-up would then be wasted work). */
export function isPanelMounted(): boolean {
  return mounted
}

/** Record whether the panel is on screen. */
export function markPanelMounted(value: boolean): void {
  mounted = value
}
