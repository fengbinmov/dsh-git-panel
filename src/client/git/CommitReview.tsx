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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import type { CommitDetail, CommitDiff } from '../../core/types.ts'
import type { GitPanelKey } from '../locales.ts'
import { DiffFileView, statusBadgeOf } from './DiffFileView.tsx'
import { reviewFiles, splitPatch, type FileDiff } from './diff-parse.ts'
import { FilePathCell, FileRowBody, FileStatCell } from './FileRow.tsx'
import { usePaneSplit } from './pane-split.ts'
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
   * A patch the host capped ends mid-section, so its LAST section is a fragment:
   * half a hunk, or a file whose remaining lines never arrived. Rendering it would
   * show a file as though that were all of it, so the last section is dropped and
   * left to the per-file fetch below — the same rule `sectionOf` applies to the
   * change list's batched patches.
   */
  const sections = useMemo(() => {
    const parsed = detail === null ? [] : splitPatch(detail.patch)
    return truncated && parsed.length > 0 ? parsed.slice(0, -1) : parsed
  }, [detail, truncated])

  const files = useMemo(
    () => (detail === null ? [] : reviewFiles(detail.files, sections)),
    [detail, sections],
  )
  /** The file whose diff is on show; null means "the first one". */
  const [picked, setPicked] = useState<string | null>(null)
  /** Per-file fetches that came back, keyed by path. `null` means "fetched, nothing textual". */
  const [fetched, setFetched] = useState<ReadonlyMap<string, FileDiff | null>>(new Map())
  /** Paths whose fetch is still on the wire. */
  const [fetching, setFetching] = useState<ReadonlySet<string>>(() => new Set())
  /**
   * Paths a fetch has been STARTED for, so a failure does not re-ask forever.
   *
   * A rejected request leaves no entry in `fetched`, and without this the effect
   * would fire again on the next render — an endless request loop for a host that
   * cannot answer this route.
   */
  const asked = useRef(new Set<string>())
  const panes = usePaneSplit('review', root)

  // A different commit is a different set of files, so neither the pick nor any
  // resolved patch carries over.
  useEffect(() => {
    setPicked(null)
    setFetched(new Map())
    setFetching(new Set())
    asked.current = new Set()
  }, [oid])

  const active = files.find(file => file.path === picked) ?? files[0]
  const activePath = active?.path ?? null
  /** The section the commit patch itself carried, when it carried one. */
  const inlineDiff = active?.diff ?? null
  const fetchedDiff = activePath === null ? undefined : fetched.get(activePath)
  /** What the pane renders: the commit's own section first, else the fetched one. */
  const shown = inlineDiff ?? fetchedDiff ?? null
  const waiting = activePath !== null && fetching.has(activePath)
  /**
   * Whether the pane should say it is loading rather than that it cannot show the
   * file: either the fetch is on the wire, or it is about to start — the reason a
   * promise cannot be `asked` for on the very first frame.
   *
   * A path that was asked for and came back with nothing is deliberately NOT busy:
   * that is the case the note below describes.
   */
  const pending = active !== undefined && active.diff === null && !active.binary
    && typeof commitDiff === 'function' && fetchedDiff === undefined
    && (activePath !== null && !asked.current.has(activePath))
  const busy = waiting || pending

  useEffect(() => {
    if (detail === null || active === undefined || activePath === null) return undefined
    // Nothing to fetch: the commit patch already describes this file, or the file
    // is binary and has no text to show.
    if (active.diff !== null || active.binary) return undefined
    if (typeof commitDiff !== 'function' || asked.current.has(activePath)) return undefined
    asked.current.add(activePath)
    let live = true
    setFetching(current => new Set(current).add(activePath))
    const settle = (): void => {
      if (!live) return
      setFetching((current) => {
        const next = new Set(current)
        next.delete(activePath)
        return next
      })
    }
    const apply = (next: CommitDiff | null): void => {
      if (!live) return
      setFetched((current) => {
        const map = new Map(current)
        const parsed = next === null || next.binary ? [] : splitPatch(next.patch)
        map.set(activePath, parsed[0] ?? null)
        return map
      })
    }
    // A fetch that fails is not worth an error surface — the pane keeps the note it
    // had before this verb existed. A verb that throws SYNCHRONOUSLY is caught here
    // for a blunter reason: an error raised inside an effect makes React unmount the
    // tree, and taking the whole Git tab down over one file's diff is not acceptable.
    try {
      void commitDiff(detail.oid, activePath).then(apply).catch(() => {}).finally(settle)
    } catch {
      settle()
    }
    return () => { live = false }
  }, [active, activePath, commitDiff, detail])

  const totals = files.reduce(
    (sum, file) => ({ additions: sum.additions + file.additions, deletions: sum.deletions + file.deletions }),
    { additions: 0, deletions: 0 },
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
            {active !== undefined && shown !== null && <DiffFileView file={shown} t={t} />}
            {/* Every branch below is a NOTE, never nothing: the pane has to say
                something whatever happened, which is the whole point of the
                per-file route — the old code had one note for four situations. */}
            {active !== undefined && shown === null && active.binary && (
              <div className={css.diffBlank}>{t('git.review.binary')}</div>
            )}
            {active !== undefined && shown === null && !active.binary && busy && (
              <div className={css.diffBlank}>{t('git.loading')}</div>
            )}
            {active !== undefined && shown === null && !active.binary && !busy && fetchedDiff !== undefined && (
              <div className={css.diffBlank}>{t('git.review.noText')}</div>
            )}
            {/* No section in the commit patch and no way to fetch one: a verb this
                shell did not provide, or a fetch that failed. */}
            {active !== undefined && shown === null && !active.binary && !busy && fetchedDiff === undefined && (
              <div className={css.diffBlank}>{t('git.review.truncated')}</div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
