/**
 * Stable git error code → readable copy mapping. The host classifies failures
 * onto the codes; this mapper owns the user-facing sentences, so a rejection
 * always reads as a sentence rather than as git's stderr.
 *
 * The switch is intentionally exhaustive over {@link GitErrorCode}: adding a
 * code without copy is a compile error, not a silent fallback to `internal`.
 * @module dsh-git-panel/client/error-copy
 */

import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import type { GitError } from '../core/types.ts'
import type { GitPanelKey } from './locales.ts'

/** The blocked-file sentence tail: quoted paths plus the overflow count. */
function pathsText(error: GitError, t: Translate<GitPanelKey>): string {
  const listed = (error.paths ?? []).map(path => `"${path}"`).join(t('error.pathsSeparator'))
  const more = error.moreFiles !== undefined && error.moreFiles > 0
    ? ` ${t('error.moreFiles', { count: error.moreFiles })}`
    : ''
  return `${listed}${more}`
}

/**
 * One readable message for a git operation rejection.
 * @param error - the classified git error.
 * @param t - the git-panel namespace translate seat.
 * @returns the sentence for the error's code.
 */
export function errorMessage(error: GitError, t: Translate<GitPanelKey>): string {
  switch (error.code) {
    case 'conflicts-present':
      return t('error.conflictsPresent')
    case 'operation-in-progress':
      return t('error.operationInProgress')
    case 'branch-in-other-worktree':
      return t('error.branchInOtherWorktree')
    case 'tracked-changes-would-be-overwritten':
      return t('error.trackedOverwrite', { paths: pathsText(error, t) })
    case 'untracked-changes-would-be-overwritten':
      return t('error.untrackedOverwrite', { paths: pathsText(error, t) })
    case 'target-branch-not-found':
      return t('error.targetBranchNotFound')
    case 'invalid-branch-name':
      return t('error.invalidBranchName')
    case 'workspace-unknown':
      return t('error.workspaceUnknown')
    case 'nothing-to-commit':
      return t('error.nothingToCommit')
    case 'empty-commit-message':
      return t('error.emptyCommitMessage')
    case 'nothing-to-discard':
      return t('error.nothingToDiscard')
    case 'not-a-repository':
      return t('error.notARepository')
    case 'invalid-path':
      return t('error.invalidPath')
    case 'no-upstream':
      return t('error.noUpstream')
    case 'detached-head':
      return t('error.detachedHead')
    case 'remote-failed':
      return t('error.remoteFailed', { error: error.message })
    case 'internal':
      return t('error.requestFailed', { error: error.message })
  }
}
