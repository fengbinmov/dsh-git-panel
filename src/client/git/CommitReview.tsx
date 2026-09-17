/**
 * The commit review: what the History tab shows for the selected commit.
 *
 * Three parts, matching how a change is actually read:
 *   - a compact bar with the commit's identity (author, short id, a copy button,
 *     and the commit's own +/− totals);
 *   - the changed files, each with its status badge — selecting one picks the
 *     diff beside it;
 *   - the selected file's diff, with both line-number gutters.
 *
 * The file list and the diff are two columns of a row with its own draggable
 * divider and its own remembered split (scope `review`), independent of the
 * outer list/detail split.
 * @module dsh-git-panel/client/git/CommitReview
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import type { CommitDetail, CommitDiff } from '../../core/types.ts'
import type { GitPanelKey } from '../locales.ts'
import { DiffFileView, statusBadgeOf } from './DiffFileView.tsx'
import { reviewFiles, splitPatch } from './diff-parse.ts'
import { formatBytes } from './helpers.ts'
import { FilePathCell, FileRowBody, FileStatCell } from './FileRow.tsx'
import { usePaneSplit } from './pane-split.ts'
import { useCommitFileDiff } from './use-commit-diff.ts'
import css from './git.module.css'

/** Props of the commit review. */
export interface CommitReviewProps {
  detail: CommitDetail | null
  loading: boolean
  /**
   * Fetch ONE file's patch out of the commit.
   *
   * Optional, and every use below is guarded: a shell that cannot supply it — an
   * older host half, or a slot inject that dropped the key — must leave the review
   * rendering whatever the commit patch carries, not throwing. A rejection reads
   * exactly like an absent verb: the pane keeps its note and the file list stands.
   */
  commitDiff?: ((oid: string, file: string) => Promise<CommitDiff | null>) | undefined
  /** The repository root, which scopes the remembered column split. */
  root: string
  t: Translate<GitPanelKey>
}

/**
 * The commit review panes.
 * @param props - see {@link CommitReviewProps}.
 */
export function CommitReview({ detail, loading, commitDiff, root, t }: CommitReviewProps) {
  const oid = detail?.oid ?? null
  const truncated = detail?.truncated === true

  /**
   * The commit patch, split per file.
   *
   * The dependency is the patch TEXT, not the detail object that carries it. The host
   * pushes changes (SSE, a poll, a window focus) and each push re-fetches the commit,
   * which hands this component a fresh `detail` holding the SAME string; keying the
   * memo on the object re-split a patch of up to 400 KB on every one of those pushes.
   * Strings compare by value, so the text as the key costs nothing and skips the work.
   *
   * A patch the host capped ends mid-section, so its LAST section is a fragment:
   * half a hunk, or a file whose remaining lines never arrived. Rendering it would
   * show a file as though that were all of it, so the last section is dropped and
   * left to the per-file fetch below — the same rule `sectionOf` applies to the
   * change list's batched patches.
   */
  const patch = detail?.patch
  const sections = useMemo(() => {
    const parsed = patch === undefined ? [] : splitPatch(patch)
    return truncated && parsed.length > 0 ? parsed.slice(0, -1) : parsed
  }, [patch, truncated])

  const files = useMemo(
    () => (detail === null ? [] : reviewFiles(detail.files, sections)),
    [detail, sections],
  )
  /** Index by path, so picking a file is a lookup rather than a scan of every row. */
  const byPath = useMemo(() => new Map(files.map(file => [file.path, file])), [files])
  /** The file whose diff is on show; null means "the first one". */
  const [picked, setPicked] = useState<string | null>(null)
  const panes = usePaneSplit('review', root)

  // A different commit is a different set of files, so the pick does not carry — and
  // the hook drops every answer it was holding for the previous one.
  useEffect(() => { setPicked(null) }, [oid])

  const active = (picked === null ? undefined : byPath.get(picked)) ?? files[0]
  /**
   * Everything the pane can say about that file: the section to draw, whether it is
   * binary, the two sizes, and the state of the per-file fetch that fills in what the
   * commit's own patch could not reach. See {@link useCommitFileDiff}.
   */
  const view = useCommitFileDiff({ oid, active, fetchDiff: commitDiff })

  const totals = files.reduce(
    (sum, file) => ({ additions: sum.additions + file.additions, deletions: sum.deletions + file.deletions }),
    { additions: 0, deletions: 0 },
  )

  /**
   * The sizes, for the files that have no lines to show.
   *
   * Absent on a side means the path did not exist there, which is itself the
   * interesting part: a binary file the commit ADDED has nothing to compare against,
   * and the note says so rather than printing "0 B".
   */
  const sizeNote = !view.settled || (view.before === null && view.after === null) ? null : (
    <div className={css.diffSize} data-gitgraph-file-size={active?.path ?? ''}>
      {t('git.review.size', {
        before: view.before === null ? t('git.review.sizeAbsent') : formatBytes(view.before),
        after: view.after === null ? t('git.review.sizeAbsent') : formatBytes(view.after),
      })}
    </div>
  )

  const copyOid = useCallback((): void => {
    if (detail === null) return
    // A clipboard rejection (an insecure context, a denied permission) is not
    // worth surfacing: the id is on screen and selectable anyway.
    void navigator.clipboard?.writeText(detail.oid).catch(() => {})
  }, [detail])

  if (detail === null) {
    return (
      <div className={css.reviewColumn} data-gitgraph-part="review">
        <div className={css.reviewEmpty}>{loading ? t('git.loading') : t('git.history.select')}</div>
      </div>
    )
  }

  return (
    <div className={css.reviewColumn} data-gitgraph-part="review">
      <div className={css.reviewBar} title={detail.body === '' ? detail.subject : `${detail.subject}\n\n${detail.body}`}>
        <span className={css.reviewAuthor}>{detail.author}</span>
        {/* The commit glyph, in the same spirit as the graph the shell draws. */}
        <svg className={css.reviewGlyph} viewBox="0 0 18 12" aria-hidden="true">
          <path d="M0 6h5M13 6h5" />
          <circle cx="9" cy="6" r="3.2" />
        </svg>
        <button
          type="button"
          className={css.reviewOid}
          title={t('git.review.copyOid')}
          onClick={copyOid}
          data-gitgraph-review-oid={detail.shortOid}
        >
          {detail.shortOid}
        </button>
        {/* The subject keeps the message one hover away even with the body out of
            the way; the bar stays one line whatever the message's length. */}
        <span className={css.reviewSubject}>{detail.subject}</span>
        <span className={css.reviewStat}>
          <span className={css.statAdd}>+{totals.additions}</span>
          <span className={css.statDel}>−{totals.deletions}</span>
        </span>
      </div>
      <div className={css.reviewRow} style={panes.style}>
        <div className={css.filesPane} data-gitgraph-part="review-files">
          <div className={css.filesHead}>{t('git.review.count', { count: files.length })}</div>
          <div className={css.filesScroll}>
            {files.map((file) => {
              const badge = statusBadgeOf(file.status)
              const isActive = active !== undefined && active.path === file.path
              return (
                <div
                  key={file.path}
                  role="button"
                  tabIndex={0}
                  aria-pressed={isActive}
                  className={`${css.fileRow ?? ''} ${isActive ? css.fileRowActive ?? '' : ''}`.trim()}
                  data-gitgraph-review-file={file.path}
                  onClick={() => { setPicked(file.path) }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      setPicked(file.path)
                    }
                  }}
                >
                  <FileRowBody
                    badge={badge.letter}
                    tone={badge.tone}
                    badgeTitle={file.status}
                    label={file.path}
                    additions={file.additions}
                    deletions={file.deletions}
                  />
                </div>
              )
            })}
            {files.length === 0 && <div className={css.empty}>{t('git.review.empty')}</div>}
          </div>
        </div>
        {/* The divider owns the boundary between the file list and the diff. */}
        <div
          className={`${css.paneDivider ?? ''} ${panes.dragging ? css.paneDividerActive ?? '' : ''}`.trim()}
          role="separator"
          aria-orientation="vertical"
          aria-label={t('git.paneDividerAria')}
          title={t('git.paneResizeHint')}
          data-gitgraph-pane-divider="review"
          onPointerDown={panes.dividerProps.onPointerDown}
          onDoubleClick={panes.dividerProps.onDoubleClick}
        />
        <div className={css.diffPane} data-gitgraph-part="review-diff">
          {active !== undefined && (
            <div className={css.diffHead} data-gitgraph-diff-head="review">
              <FilePathCell label={active.path} />
              <span className={css.spacer} />
              <FileStatCell additions={active.additions} deletions={active.deletions} />
            </div>
          )}
          {/* Keyed by the commit AND the picked file: picking another file — or
              opening another commit — starts at the top, while a refresh of the same
              pair keeps the key (and the reader's scroll position). */}
          <div key={`${detail.oid}|${active?.path ?? ''}`} className={css.diffScroll}>
            {active !== undefined && view.diff !== null && <DiffFileView file={view.diff} t={t} />}
            {/* Every branch below is a NOTE, never nothing: the pane has to say
                something whatever happened, which is the whole point of the
                per-file route — the old code had one note for four situations. */}
            {active !== undefined && view.diff === null && view.binary && (
              <div className={css.diffBlank}>{t('git.review.binary')}</div>
            )}
            {active !== undefined && view.diff === null && !view.binary && view.busy && (
              <div className={css.diffBlank}>{t('git.loading')}</div>
            )}
            {active !== undefined && view.diff === null && !view.binary && !view.busy && view.settled && (
              <div className={css.diffBlank}>{t('git.review.noText')}</div>
            )}
            {/* No section in the commit patch and no way to fetch one: a verb this
                shell did not provide, or a fetch that failed. */}
            {active !== undefined && view.diff === null && !view.binary && !view.busy && !view.settled && (
              <div className={css.diffBlank}>{t('git.review.truncated')}</div>
            )}
            {/* What a file with no lines can still say about itself — the sizes it
                changed between. It sits under the note, not instead of it. */}
            {active !== undefined && !view.hasText && sizeNote}
          </div>
        </div>
      </div>
    </div>
  )
}
