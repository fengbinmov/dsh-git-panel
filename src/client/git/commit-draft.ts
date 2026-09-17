/**
 * The commit message in progress, kept OUTSIDE React.
 *
 * The shell renders only the active view, so leaving the Git tab unmounts the panel
 * — and took a half-written commit message with it. A message is the one thing here
 * the reader typed themselves, and glancing at the conversation for a moment is not
 * a reason to lose it. `panel-cache` keeps the file list for the same reason; this
 * keeps the sentence.
 *
 * Keyed by the repository ROOT, not held in one slot. A draft belongs to one
 * repository: carried across workspaces, the message written for one project would
 * be sitting in another project's commit box, one Enter away from being committed
 * to the wrong tree.
 *
 * Module scope, like `panel-cache`, so a reload of the page starts clean — a draft
 * that outlived the session would be one more thing to wonder about later.
 * @module dsh-git-panel/client/git/commit-draft
 */

const drafts = new Map<string, string>()

/** The draft for one repository; '' when nothing has been typed for it. */
export function commitDraft(root: string): string {
  return drafts.get(root) ?? ''
}

/** Remember what is in one repository's commit box (an empty message drops it). */
export function rememberCommitDraft(root: string, message: string): void {
  if (message === '') drafts.delete(root)
  else drafts.set(root, message)
}

/** Forget one repository's draft — it has been committed. */
export function clearCommitDraft(root: string): void {
  drafts.delete(root)
}
