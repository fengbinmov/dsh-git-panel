/**
 * The Changes/History tabs' horizontal split: the file list on the left, the
 * detail pane on the right, and a draggable divider between them.
 *
 * The columns are sized by unitless SHARES carried as custom properties on the
 * row (see `git.module.css`), so the browser turns the weights into pixels and
 * the two always add up to the row exactly — no arithmetic here can leave a gap
 * or an overflow, and a window resize just re-divides. A drag only trades share
 * between the two columns, and the chosen split is remembered per repository.
 *
 * The divider measures its OWN siblings rather than taking refs, which keeps the
 * hook's contract to one ref: the element the pointer grabbed is the element
 * between the two panes by construction.
 * @module dsh-git-panel/client/git/pane-split
 */

import {
  useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent,
} from 'react'
import {
  DEFAULT_PANE_SPLIT, dragPaneSplit, paneSplitOf, shareScale, type PaneSplit,
} from './helpers.ts'

/** localStorage key prefix for a repository's remembered column split. */
const PANE_SPLIT_STORAGE_PREFIX = 'dsh.git-panel.pane-split.v1:'

/**
 * The storage key for one split. The scope is part of it because the panel has
 * two independent rows — the list/detail columns, and the commit review's file
 * list against its diff — and dragging one must not move the other.
 */
function paneSplitKey(scope: string, root: string): string {
  return `${PANE_SPLIT_STORAGE_PREFIX}${scope}:${root}`
}

/** Read a repository's remembered split; storage is untrusted, so it is validated. */
function readPaneSplit(scope: string, root: string): PaneSplit {
  if (root === '') return DEFAULT_PANE_SPLIT
  try {
    const raw = localStorage.getItem(paneSplitKey(scope, root))
    if (raw === null) return DEFAULT_PANE_SPLIT
    return paneSplitOf(JSON.parse(raw))
  } catch {
    // Storage can be unavailable (private mode) or hold invalid JSON.
    return DEFAULT_PANE_SPLIT
  }
}

/** Persist a repository's split; a failure is not worth surfacing. */
function writePaneSplit(scope: string, root: string, split: PaneSplit): void {
  if (root === '') return
  try {
    localStorage.setItem(paneSplitKey(scope, root), JSON.stringify(split))
  } catch {
    // Ignore: the layout still works for this mount.
  }
}

/** What the view needs to render the two columns and their divider. */
export interface PaneSplitHandle {
  /** Inline style for the row: the two column weights. */
  readonly style: CSSProperties
  /** Whether a drag is in flight (drives the divider's active look). */
  readonly dragging: boolean
  /** Pointer handlers for the divider element. */
  readonly dividerProps: {
    onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void
    onDoubleClick: () => void
  }
}

/**
 * Own one row's split for one repository.
 * @param scope - which row this split belongs to (`changes`, `history`, …), so
 *   the panel's rows remember their widths independently.
 * @param root - the repository root; the split is remembered per repository, and
 *   a new root re-reads (or defaults) rather than inheriting the last repo's.
 * @returns the row style and the divider's handlers.
 */
export function usePaneSplit(scope: string, root: string): PaneSplitHandle {
  const [split, setSplit] = useState<PaneSplit>(() => readPaneSplit(scope, root))
  const [dragging, setDragging] = useState(false)
  /** The latest split, readable from the pointerup handler without stale state. */
  const splitRef = useRef(split)
  splitRef.current = split

  // A different repository brings a different remembered split.
  useEffect(() => { setSplit(readPaneSplit(scope, root)) }, [scope, root])

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>): void => {
    const divider = event.currentTarget
    const list = divider.previousElementSibling
    const detail = divider.nextElementSibling
    if (list === null || detail === null) return
    const listPx = list.getBoundingClientRect().width
    const detailPx = detail.getBoundingClientRect().width
    const pairPx = listPx + detailPx
    if (!(pairPx > 0)) return
    // Seeded from what is on screen, in pixels: the on-screen split is preserved
    // exactly and the drag then moves share between the two columns only.
    const start: PaneSplit = { list: listPx, detail: detailPx }
    event.preventDefault()
    const startX = event.clientX
    setSplit(start)
    setDragging(true)
    // The pointer leaves the 9px divider immediately, so the cursor and the
    // text-selection suppression have to be applied to the document.
    const previousCursor = document.body.style.cursor
    const previousSelect = document.body.style.userSelect
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    const move = (moveEvent: PointerEvent): void => {
      setSplit(dragPaneSplit(start, pairPx, moveEvent.clientX - startX))
    }
    const finish = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
      document.body.style.cursor = previousCursor
      document.body.style.userSelect = previousSelect
      setDragging(false)
      writePaneSplit(scope, root, splitRef.current)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', finish)
  }, [scope, root])

  /** Forget the dragged split, which hands the columns back to the default ratio. */
  const onDoubleClick = useCallback((): void => {
    setSplit(DEFAULT_PANE_SPLIT)
    writePaneSplit(scope, root, DEFAULT_PANE_SPLIT)
  }, [scope, root])

  // The weights are relative, but a stored pair that sums to less than one would
  // leave the row's remainder undistributed (a slice of empty space on the right),
  // so the set is scaled up as a whole when it needs to be.
  const scale = shareScale([split.list, split.detail])
  const style = {
    '--git-list-share': String(split.list * scale),
    '--git-detail-share': String(split.detail * scale),
  } as CSSProperties

  return { style, dragging, dividerProps: { onPointerDown, onDoubleClick } }
}
