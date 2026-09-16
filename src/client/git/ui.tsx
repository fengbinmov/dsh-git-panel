/**
 * The click-away backdrop the branch menu renders behind itself.
 *
 * It is local rather than imported from another plugin's components because the
 * client bundle purity gate forbids cross-plugin value imports — a shared
 * component would either inline a duplicate runtime or require a specifier the
 * shell's frozen module table cannot answer.
 * @module dsh-git-panel/client/git/ui
 */

import css from './git.module.css'

/** Full-screen transparent backdrop closing the open menu on click. */
export function Backdrop({ onClose }: { onClose: () => void }) {
  return <div className={css.backdrop} onClick={onClose} />
}
