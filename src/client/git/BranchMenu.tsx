/**
 * The branch menu in the Git view header: search-free branch list with the
 * current branch marked, plus per-branch switch / merge / rebase actions.
 * Every action asks for an inline confirmation first, because merge and
 * rebase rewrite the working tree and switch can move it.
 * @module dsh-git-panel/client/git/BranchMenu
 */

import { useState } from 'react'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import type { BranchRow } from '../../core/types.ts'
import type { GitPanelKey } from '../locales.ts'
import { Backdrop } from './ui.tsx'
import css from './git.module.css'

/** The action awaiting confirmation. */
type PendingAction = { kind: 'switch' | 'merge' | 'rebase'; branch: string }

/** Props of the branch menu. */
export interface BranchMenuProps {
  /** Current branch; empty when HEAD is detached. */
  current: string
  branches: BranchRow[]
  busy: boolean
  onSwitch: (branch: string) => void
  onMerge: (branch: string) => void
  onRebase: (branch: string) => void
  onClose: () => void
  t: Translate<GitPanelKey>
}

/**
 * The branch menu.
 * @param props - see {@link BranchMenuProps}.
 */
export function BranchMenu(props: BranchMenuProps) {
  const { current, branches, busy, onSwitch, onMerge, onRebase, onClose, t } = props
  const [pending, setPending] = useState<PendingAction | null>(null)

  const confirmText = (action: PendingAction): string => {
    switch (action.kind) {
      case 'switch': return t('git.branch.switchConfirm', { branch: action.branch })
      case 'merge': return t('git.branch.mergeConfirm', { branch: action.branch, current: current === '' ? t('git.detached') : current })
      case 'rebase': return t('git.branch.rebaseConfirm', { branch: action.branch, current: current === '' ? t('git.detached') : current })
    }
  }

  const run = (action: PendingAction): void => {
    if (action.kind === 'switch') onSwitch(action.branch)
    else if (action.kind === 'merge') onMerge(action.branch)
    else onRebase(action.branch)
    setPending(null)
    onClose()
  }

  return (
    <>
      <Backdrop onClose={onClose} />
      <div className={css.branchMenu} role="menu" aria-label={t('git.branch.switch')} data-gitgraph-branch-menu>
        {pending !== null && (
          <div className={css.confirmBar}>
            <span className={css.confirmText}>{confirmText(pending)}</span>
            <button
              type="button"
              className={`${css.button ?? ''} ${css.buttonTiny ?? ''}`.trim()}
              onClick={() => { setPending(null) }}
            >
              {t('git.cancel')}
            </button>
            <button
              type="button"
              className={`${css.button ?? ''} ${css.buttonTiny ?? ''}`.trim()}
              disabled={busy}
              data-gitgraph-branch-confirm
              onClick={() => { run(pending) }}
            >
              OK
            </button>
          </div>
        )}
        {branches.map(row => (
          <div key={row.name} className={css.branchRow} data-gitgraph-branch={row.name}>
            <span className={`${css.branchName} ${row.current ? css.branchRowCurrent ?? '' : ''}`.trim()} title={row.name}>
              {row.current ? '✓ ' : ''}{row.name}
            </span>
            {!row.current && (
              <span className={css.branchOps}>
                <button
                  type="button"
                  className={css.branchOpButton}
                  disabled={busy}
                  onClick={() => { setPending({ kind: 'switch', branch: row.name }) }}
                >
                  {t('git.branch.switch')}
                </button>
                <button
                  type="button"
                  className={css.branchOpButton}
                  disabled={busy}
                  title={t('git.branch.merge', { branch: row.name })}
                  onClick={() => { setPending({ kind: 'merge', branch: row.name }) }}
                >
                  merge
                </button>
                <button
                  type="button"
                  className={css.branchOpButton}
                  disabled={busy}
                  title={t('git.branch.rebase', { branch: row.name })}
                  onClick={() => { setPending({ kind: 'rebase', branch: row.name }) }}
                >
                  rebase
                </button>
              </span>
            )}
          </div>
        ))}
        {branches.length === 0 && <div className={css.empty}>{t('git.loading')}</div>}
      </div>
    </>
  )
}
