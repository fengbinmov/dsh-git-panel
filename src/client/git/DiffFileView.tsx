/**
 * One file's diff, rendered for review: two line-number gutters (old and new), a
 * marker column, and the line itself tinted by kind, with the hunk headers as
 * separator rows.
 *
 * Showing both numbers is what makes a diff readable after the fact: a row's old
 * number is where it came from, its new number is where it went, and a row only
 * carries the side it exists on. The rows come from `diff-parse.ts`, which owns
 * the numbering, so this component is pure presentation.
 * @module dsh-git-panel/client/git/DiffFileView
 */

import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import type { LineStat } from '../../core/types.ts'
import type { GitPanelKey } from '../locales.ts'
import { selectionPatch, type DiffRow, type FileDiff, type FileDiffStatus, type SelectionDirection } from './diff-parse.ts'
import css from './git.module.css'

/** Props of one file's diff view. */
export interface DiffFileViewProps {
  /** The parsed section to render. */
  file: FileDiff
  /** The git-panel translate seat. */
  t: Translate<GitPanelKey>
  /**
   * Which side the patch shows, which is what decides what can be done with a line
   * selection: a `pending` preview stages or discards, a `staged` one unstages. Null
   * (a commit's diff in the History tab) turns the whole line-selection surface off —
   * there is nothing to apply a commit's lines to.
   */
  side?: 'pending' | 'staged' | null
  /** Apply the chosen rows; receives the patch fragment and what it moves. */
  onApplySelection?: (direction: SelectionDirection, fragment: string, counts: LineStat) => void
}

/** The marker in the gutter of an added or removed row. */
function markerOf(kind: DiffRow['kind']): string {
  if (kind === 'add') return '+'
  if (kind === 'del') return '−'
  // A context row keeps the marker column's width so the code stays aligned; a
  // hunk header is a separator and has no marker at all.
  return kind === 'context' ? ' ' : ''
}

/** The tint class for one row. */
function rowClassOf(kind: DiffRow['kind']): string {
  if (kind === 'add') return css.diffRowAdd ?? ''
  if (kind === 'del') return css.diffRowDel ?? ''
  if (kind === 'note') return css.diffRowNote ?? ''
  return ''
}

/** The badge letter and tone one file status shows, reusing the change-row palette. */
const STATUS_BADGE: Record<FileDiffStatus, { letter: string; tone: string }> = {
  added: { letter: 'A', tone: css.badgeAdded ?? '' },
  deleted: { letter: 'D', tone: css.badgeDeleted ?? '' },
  renamed: { letter: 'R', tone: css.badgeRenamed ?? '' },
  modified: { letter: 'M', tone: css.badgeModified ?? '' },
  // A binary change has no letter of its own in the change list either.
  binary: { letter: 'M', tone: css.badgeModified ?? '' },
}

/**
 * The badge for one review file.
 * @param status - the status read from the patch headers.
 * @returns the letter and the tone class.
 */
export function statusBadgeOf(status: FileDiffStatus): { letter: string; tone: string } {
  return STATUS_BADGE[status]
}

/**
 * One rendered patch as a VALUE, so two objects carrying the same rows compare equal.
 *
 * The diff is rebuilt on every host refresh — the pane re-cuts the section and
 * re-parses it — so object identity says "the panel refreshed", not "the diff
 * changed". A line selection only becomes meaningless when the ROWS change, and
 * this is the cheapest thing that changes with them. The side is part of it
 * because the same rows mean different things on the index side.
 * @param file - the parsed section.
 * @param side - which side of the index the selection would act on.
 * @returns a string that is equal exactly for equal rows on the same side.
 */
function patchSignature(file: FileDiff, side: 'pending' | 'staged' | null): string {
  const rows = file.rows.map(row =>
    `${row.kind}\u0000${row.oldLine ?? ''}\u0000${row.newLine ?? ''}\u0000${row.text}`)
  return [side ?? '', file.path, file.status, file.origPath ?? '', ...rows].join('\n')
}

/**
 * One file's diff.
 * @param props - see {@link DiffFileViewProps}.
 */
export function DiffFileView({ file, t, side = null, onApplySelection }: DiffFileViewProps) {
  const container = useRef<HTMLDivElement | null>(null)
  const barRef = useRef<HTMLDivElement | null>(null)
  const dragging = useRef(false)
  // The live selection: the row the drag started on and the row it is over. Kept as
  // two indices rather than a set so extending it is a state update, not a rebuild.
  const [range, setRange] = useState<{ anchor: number; head: number } | null>(null)
  const [bar, setBar] = useState<{ top: number; right: number } | null>(null)
  /**
   * The rows as the action left them, shown until the refresh replaces the patch.
   *
   * Applying a line selection removes exactly the chosen change rows from the diff —
   * in every direction: staging takes them out of the worktree side, unstaging out of
   * the index side, discarding out of the worktree side — so the text can go with the
   * button instead of a host round trip later. That round trip is what made the
   * button feel like it had not worked: the bar vanished and the lines stayed.
   *
   * The override is dropped the moment a new patch arrives (the `file` effect below):
   * git's own answer replaces it, and if the action FAILED the rows come back, which
   * is the honest outcome.
   */
  const [optimistic, setOptimistic] = useState<FileDiff | null>(null)
  const shown = optimistic ?? file

  const selectable = side !== null && onApplySelection !== undefined
  // A fresh patch OBJECT means git has answered, so whatever the action left on
  // screen has been superseded by its own text — including when the answer matches
  // the pre-action patch (a failed apply), where the rows have to come back. That is
  // why this keys on identity while the selection reset below does not.
  useEffect(() => {
    setOptimistic(null)
  }, [file])

  // The selection only has to be dropped when the ROWS change. A background refresh
  // hands over a freshly parsed but identical patch — the host re-cut the same diff —
  // and clearing the selection for that threw away lines the user was still choosing.
  const signature = useMemo(() => patchSignature(file, side), [file, side])
  const lastSignature = useRef(signature)
  useEffect(() => {
    if (lastSignature.current === signature) return
    lastSignature.current = signature
    setRange(null)
  }, [signature])

  // Kept as two NUMBERS, never as an object: the effects below depend on them, and a
  // fresh object every render would re-run the (state-writing) measurement effect on
  // every render — which is an infinite loop, not a slow path.
  const from = range === null ? null : Math.min(range.anchor, range.head)
  const to = range === null ? null : Math.max(range.anchor, range.head)
  // Only real changes can be applied; context rows inside the range are carried along
  // because a hunk needs them to apply.
  const chosen = useMemo(() => {
    if (from === null || to === null) return new Set<number>()
    const set = new Set<number>()
    for (let index = from; index <= to; index += 1) {
      const kind = file.rows[index]?.kind
      if (kind === 'add' || kind === 'del') set.add(index)
    }
    return set
  }, [from, to, file.rows])

  // The bar sits at the TOP-RIGHT of the selected block, inside the preview pane.
  //
  // It is positioned against `.detailPane` — the nearest positioned ancestor, which
  // also clips it — so the buttons can never be drawn outside the preview, however
  // the panel around it moves. Both coordinates are PANE-relative, which is also why
  // a refresh is harmless: a notice or a resize can shift the pane without the bar
  // needing a new anchor. What does move is the row, so the effect still re-measures
  // on any scroll and on every new patch.
  useEffect(() => {
    if (from === null || chosen.size === 0) { setBar(null); return undefined }
    const measure = (): void => {
      const host = container.current
      if (host === null) return
      const first = host.querySelector<HTMLElement>(`[data-diff-index="${from}"]`)
      const scroll = host.parentElement
      if (first === null || scroll === null) return
      // Without the pane marker (a standalone mount) the scroller stands in.
      const pane = host.closest<HTMLElement>('[data-gitgraph-part="detail"]') ?? scroll
      const rowBox = first.getBoundingClientRect()
      const scrollBox = scroll.getBoundingClientRect()
      const paneBox = pane.getBoundingClientRect()
      const height = barRef.current?.getBoundingClientRect().height ?? 0
      // Keep the bar inside the diff's own viewport: a selected block scrolled past
      // the top edge must not leave its buttons over the header.
      const min = scrollBox.top + 4
      const max = Math.max(scrollBox.bottom - height - 4, min)
      const top = Math.min(Math.max(rowBox.top, min), max) - paneBox.top
      setBar(current => {
        const next = { top, right: 8 }
        // Unchanged numbers mean an unchanged position: returning the same object
        // keeps React from re-rendering on every scroll event.
        return current !== null && current.top === next.top && current.right === next.right ? current : next
      })
    }
    measure()
    // Any scroll (the diff's, or the shell's conversation scroller) moves the rows
    // under the bar, so the listener is in the capture phase on the window.
    window.addEventListener('scroll', measure, true)
    window.addEventListener('resize', measure)
    return () => {
      window.removeEventListener('scroll', measure, true)
      window.removeEventListener('resize', measure)
    }
  }, [from, chosen.size, file])

  // Escape drops the selection; it is the only key this surface answers to.
  useEffect(() => {
    if (!selectable) return undefined
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') setRange(null) }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey) }
  }, [selectable])

  /**
   * The row index of a point, but ONLY when the gesture started on that row's gutter.
   *
   * The gutter — the two number columns and the marker — is the handle for line
   * selection, and the text beside it is left to the browser. That is what lets a
   * reader select a few WORDS, which is the thing a whole-pane `user-select: none`
   * (the previous shape of this) took away. A gesture that starts anywhere else is
   * not ours: no `preventDefault`, no row selection, just ordinary text selection.
   */
  const gutterRowAt = (event: { clientX: number; clientY: number; target: EventTarget | null }): number | null => {
    if (!(event.target instanceof Element) || event.target.closest('[data-diff-gutter]') === null) return null
    const under = typeof document.elementFromPoint === 'function'
      ? document.elementFromPoint(event.clientX, event.clientY)
      : null
    // The point wins when it lands on a row; otherwise the event's own target does —
    // which covers a DOM with no hit-testing (jsdom), and the case where the point
    // resolves to something that is not a row.
    const fromPoint = under === null ? null : under.closest('[data-diff-index]')
    const fromTarget = event.target.closest('[data-diff-index]')
    const raw = (fromPoint ?? fromTarget)?.getAttribute('data-diff-index')
    return raw === undefined || raw === null ? null : Number(raw)
  }

  /** The row index under a point, whatever part of the row it is over. */
  const rowAtPoint = (event: { clientX: number; clientY: number; target: EventTarget | null }): number | null => {
    const under = typeof document.elementFromPoint === 'function'
      ? document.elementFromPoint(event.clientX, event.clientY)
      : null
    const fromPoint = under === null ? null : under.closest('[data-diff-index]')
    const fromTarget = event.target instanceof Element ? event.target.closest('[data-diff-index]') : null
    const raw = (fromPoint ?? fromTarget)?.getAttribute('data-diff-index')
    return raw === undefined || raw === null ? null : Number(raw)
  }

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!selectable || event.button !== 0) return
    const index = gutterRowAt(event)
    if (index === null) return
    // Ours from here on: preventing the default is what stops the same drag from
    // starting a text selection that would fight the row highlights. A drag that
    // begins in the text beside the gutter never reaches this line.
    event.preventDefault()
    dragging.current = true
    // Pointer capture keeps a drag that leaves the diff (or the window) alive; it is
    // optional because a pointer that is not active — or a DOM without the API —
    // throws rather than failing quietly.
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId)
    } catch {
      // No capture: the drag still works while the pointer stays inside the diff.
    }
    setRange({ anchor: index, head: index })
  }
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!dragging.current) return
    // Once the drag is ours the range follows the POINTER, including across the text
    // it passed over on the way to the next row's gutter.
    const index = rowAtPoint(event)
    if (index === null) return
    setRange(current => (current === null || current.head === index ? current : { ...current, head: index }))
  }
  const endDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!dragging.current) return
    dragging.current = false
    try {
      if (event.currentTarget.hasPointerCapture?.(event.pointerId) === true) {
        event.currentTarget.releasePointerCapture?.(event.pointerId)
      }
    } catch {
      // The pointer is already gone; nothing to release.
    }
  }

  /** The patch fragment for the current selection, or null when there is nothing to do. */
  const fragmentFor = (direction: SelectionDirection): string | null => selectionPatch(file, chosen, direction)

  const apply = (direction: SelectionDirection): void => {
    const fragment = fragmentFor(direction)
    if (fragment === null || onApplySelection === undefined) return
    // How much is moving, counted from the ROWS rather than the fragment text: the
    // list's own `+N −M` is predicted from these numbers, so they have to mean the
    // same thing the diff's counts do.
    const counts = { additions: 0, deletions: 0 }
    for (const index of chosen) {
      const kind = file.rows[index]?.kind
      if (kind === 'add') counts.additions += 1
      else if (kind === 'del') counts.deletions += 1
    }
    // The chosen lines leave the diff NOW, in the same update as the bar's removal;
    // the refresh that follows puts git's own answer in their place.
    setOptimistic({ ...file, rows: file.rows.filter((_, index) => !chosen.has(index)) })
    setRange(null)
    onApplySelection(direction, fragment, counts)
  }

  if (shown.status === 'binary') {
    return <div className={css.diffBlank} data-gitgraph-diff={shown.path}>{t('git.review.binary')}</div>
  }
  if (shown.rows.length === 0) {
    return <div className={css.diffBlank} data-gitgraph-diff={shown.path}>{t('git.review.noText')}</div>
  }
  const inRange = (index: number): boolean => from !== null && to !== null && index >= from && index <= to
  return (
    <>
      <div
        ref={container}
        className={`${css.diff} ${selectable ? css.diffSelectable ?? '' : ''}`.trim()}
        data-gitgraph-diff={shown.path}
        data-gitgraph-line-actions={selectable ? (side ?? '') : undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        {shown.rows.map((row, index) => (
          // Rows have no identity of their own; their position in the patch is it.
          // eslint-disable-next-line react/no-array-index-key
          <div
            key={index}
            className={[
              css.diffRow,
              rowClassOf(row.kind),
              chosen.has(index) ? css.diffRowChosen : '',
              inRange(index) && !chosen.has(index) ? css.diffRowInRange : '',
            ].filter(Boolean).join(' ')}
            data-diff-kind={row.kind}
            data-diff-index={index}
          >
            <span className={css.diffNum} data-diff-gutter>{row.oldLine ?? ''}</span>
            <span className={css.diffNum} data-diff-gutter>{row.newLine ?? ''}</span>
            <span className={css.diffMark} data-diff-gutter>{markerOf(row.kind)}</span>
            {/* An empty line still needs its height; a non-breaking space is the
                cheapest way to give the row one without changing the text. */}
            <span className={css.diffText} data-diff-text>{row.text === '' ? '\u00a0' : row.text}</span>
          </div>
        ))}
      </div>
      {bar !== null && (
        <div ref={barRef} className={css.lineActions} style={{ top: `${bar.top}px`, right: `${bar.right}px` }} data-gitgraph-line-bar>
          <span className={css.lineCount}>{t('git.selection.count', { count: chosen.size })}</span>
          {/* A pending preview can move its lines into the index or throw them away; a
              staged one has only one thing left to do with them. */}
          {side === 'staged' ? (
            <button type="button" className={css.button} data-gitgraph-line-unstage onClick={() => { apply('unstage') }}>
              {t('git.selection.unstage')}
            </button>
          ) : (
            <>
              <button
                type="button"
                className={`${css.button ?? ''} ${css.lineActionAdd ?? ''}`.trim()}
                data-gitgraph-line-stage
                onClick={() => { apply('stage') }}
              >
                {t('git.selection.stage')}
              </button>
              <button
                type="button"
                className={`${css.button ?? ''} ${css.lineActionDel ?? ''}`.trim()}
                data-gitgraph-line-discard
                onClick={() => { apply('discard') }}
              >
                {t('git.selection.discard')}
              </button>
            </>
          )}
        </div>
      )}
    </>
  )
}
