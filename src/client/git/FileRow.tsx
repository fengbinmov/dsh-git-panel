/**
 * The pieces of one file row: status badge, path cell, `+N −M` counts.
 *
 * Every surface that shows a file — the Changes tab's per-region rows, the
 * History tab's review rows, and both tabs' preview headers — draws exactly
 * these, and the requirement is that they look the same wherever they appear.
 * They are therefore rendered from one place instead of from several copies of
 * the same markup that drift apart.
 *
 * Only the BODY is shared. Each list keeps its own wrapper, because the wrappers
 * genuinely differ: a Changes row is a draggable, multi-selectable member of a
 * region (Ctrl/Shift extend the selection, Delete acts on it), while a review row
 * is a plain pick that swaps the diff beside it. Those are the tab's own verbs,
 * not style.
 * @module dsh-git-panel/client/git/FileRow
 */

import { splitPath } from './helpers.ts'
import css from './git.module.css'

/** Props of {@link FilePathCell}. */
export interface FilePathCellProps {
  /** The path to draw; a rename carries its origin as `old → new`. */
  label: string
}

/**
 * The path, split so a shortened cell keeps the FILE NAME: the directory takes
 * the clipping and its ellipsis lands right before the name.
 * @param props - see {@link FilePathCellProps}.
 */
export function FilePathCell({ label }: FilePathCellProps) {
  const parts = splitPath(label)
  return (
    <span className={css.filePath} title={label}>
      <span className={css.fileDir}>{parts.directory}</span>
      <span className={css.fileName} data-gitgraph-file-name>{parts.name}</span>
    </span>
  )
}

/** Props of {@link FileStatCell}. */
export interface FileStatCellProps {
  /** Added lines on the side this row lists; omitted when git reported none. */
  additions?: number | undefined
  /** Deleted lines on the side this row lists; omitted when git reported none. */
  deletions?: number | undefined
}

/**
 * The `+N −M` pair, or nothing when the counts are unknown.
 *
 * Unknown is a real state, not a zero: an untracked file appears in no diff, so
 * its row shows no counts rather than a misleading `+0 −0`.
 * @param props - see {@link FileStatCellProps}.
 */
export function FileStatCell({ additions, deletions }: FileStatCellProps) {
  if (additions === undefined || deletions === undefined) return null
  return (
    <span className={css.fileStat} data-gitgraph-file-stat>
      <span className={css.statAdd}>+{additions}</span>
      <span className={css.statDel}>−{deletions}</span>
    </span>
  )
}

/** Props of {@link FileRowBody}. */
export interface FileRowBodyProps extends FileStatCellProps {
  /** The one-letter status the badge shows. */
  badge: string
  /** The badge's colour class (`badgeClassOf` for a change, `statusBadgeOf` for a commit's file). */
  tone: string
  /** The badge's tooltip. */
  badgeTitle: string
  /** The path to draw. */
  label: string
}

/**
 * The badge, the path, and the counts of one file row.
 * @param props - see {@link FileRowBodyProps}.
 */
export function FileRowBody({ badge, tone, badgeTitle, label, additions, deletions }: FileRowBodyProps) {
  return (
    <>
      <span
        className={`${css.badge ?? ''} ${tone}`.trim()}
        title={badgeTitle}
        data-gitgraph-badge={badge}
      >
        {badge}
      </span>
      <FilePathCell label={label} />
      <FileStatCell additions={additions} deletions={deletions} />
    </>
  )
}
