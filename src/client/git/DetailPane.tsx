/**
 * The Changes tab's file preview: the picked change's diff.
 *
 * Its three parts are the History tab's diff pane — the same header (split path,
 * the same `+N −M` pair the row shows), the same scroll container, and the same
 * viewer ({@link DiffFileView} over the rows `diff-parse` builds) — so a file
 * reads the same whether it was picked in the change list or inside a commit.
 *
 * It used to paint the raw patch text with a prefix-tint renderer of its own:
 * git's `diff --git` and `index` plumbing on screen, no line numbers, no marker
 * column, and a different type size for the same file.
 * @module dsh-git-panel/client/git/DetailPane
 */

import { useMemo } from 'react'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import type { DiffView, LineStat } from '../../core/types.ts'
import type { GitPanelKey } from '../locales.ts'
import { DiffFileView } from './DiffFileView.tsx'
import { FilePathCell, FileStatCell } from './FileRow.tsx'
import { splitPatch, type SelectionDirection } from './diff-parse.ts'
import css from './git.module.css'

/** Props of the file preview. */
export interface DetailPaneProps {
  /** The picked change row, or null when nothing is picked. */
  selection: { path: string; staged: boolean } | null
  /** That row's diff, fetched for the side the row lists. */
  diff: DiffView | null
  /** Whether the fetch is still in flight. */
  loading: boolean
  /** The picked row's line counts — the same pair the row itself shows. */
  stat?: LineStat | undefined
  /** Apply a line selection: stage, unstage or discard the chosen rows. */
  onApplySelection?: ((direction: SelectionDirection, fragment: string, counts: LineStat) => void) | undefined
  t: Translate<GitPanelKey>
}

/**
 * The detail pane.
 * @param props - see {@link DetailPaneProps}.
 */
export function DetailPane(props: DetailPaneProps) {
  const { selection, diff, loading, stat, onApplySelection, t } = props
  // The patch arrives as one file's raw `git diff`, so it is one section: the
  // same parser the commit review uses turns it into numbered rows. A binary or
  // still-loading diff has nothing to parse.
  const section = useMemo(
    () => (diff === null || diff.binary ? null : splitPatch(diff.patch)[0] ?? null),
    [diff],
  )

  if (selection === null) {
    return (
      <div className={css.detailPane} data-gitgraph-part="detail">
        <div className={css.empty}>{t('git.diff.select')}</div>
      </div>
    )
  }

  const noRows = section === null || section.rows.length === 0
  return (
    <div className={css.detailPane} data-gitgraph-part="detail">
      <div className={css.diffHead} data-gitgraph-diff-head="changes">
        <FilePathCell label={selection.path} />
        <span className={css.spacer} />
        {/* The one thing this head says that the commit review's does not: which
            side of the index the patch shows. Either side can hold the same path,
            so the preview has to name the one it is showing. */}
        <span className={css.detailMeta}>
          <span>{selection.staged ? t('git.diff.staged') : t('git.diff.unstaged')}</span>
          {diff !== null && diff.truncated && <span>{t('git.diff.truncated')}</span>}
        </span>
        <FileStatCell additions={stat?.additions} deletions={stat?.deletions} />
      </div>
      {/* The scroller is keyed by WHAT IT SHOWS: a newly picked file (a different
          path or the other side of the index) starts at the top, while a refresh of
          the file already on screen keeps its key and the reader's scroll position.
          A fresh scroller element has scrollTop/scrollLeft 0 by construction. */}
      <div
        key={`${selection.path}|${selection.staged ? 'index' : 'worktree'}`}
        className={css.diffScroll}
      >
        {/* Notes sit in the pane's own note style, the one the commit review's
            diff pane uses for the same situations. */}
        {loading && <div className={css.diffBlank}>{t('git.loading')}</div>}
        {!loading && diff !== null && diff.binary && <div className={css.diffBlank}>{t('git.diff.binary')}</div>}
        {!loading && diff === null && <div className={css.diffBlank}>{t('git.diff.empty')}</div>}
        {!loading && !noRows && section !== null && (
          <DiffFileView
            file={section}
            t={t}
            // The side decides what a line selection can do: a pending preview stages
            // or discards, a staged one unstages.
            side={selection.staged ? 'staged' : 'pending'}
            onApplySelection={onApplySelection}
          />
        )}
        {!loading && diff !== null && !diff.binary && noRows && (
          <div className={css.diffBlank}>{t('git.diff.empty')}</div>
        )}
      </div>
    </div>
  )
}
