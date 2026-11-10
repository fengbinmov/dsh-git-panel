/**
 * Fixed-row-height windowing for a list too long to mount whole.
 *
 * The History tab's commit review can list twelve thousand changed files, and one
 * DOM row per file is what made opening such a commit take seconds: tens of
 * thousands of nodes to create for the first paint, and all of them to reconcile
 * again on every later update. Only the rows a reader can actually see are worth
 * mounting, so the list renders a window of them and pads the rest with two
 * spacers that keep the scrollbar proportional to the full list.
 *
 * Everything here rests on one assumption: every row is EXACTLY the same height.
 * The caller keeps that promise in CSS — the review's rows are pinned to
 * `FILE_ROW_HEIGHT` (see `.reviewFileRow`) — which is why a row's offset is
 * `index × height` rather than a measurement of the rows already on screen.
 * @module dsh-git-panel/client/git/virtual-window
 */

import { useCallback, useEffect, useMemo, useState } from 'react'

/**
 * The viewport assumed when the scroller cannot be measured.
 *
 * jsdom reports `clientHeight` as 0 for everything, and so does a pane that is
 * still hidden (a tab that has not been shown, a `display: none` ancestor).
 * Rendering nothing in that state would leave the list blank until something else
 * happened to trigger a re-measure, so an unmeasured viewport falls back to a
 * plausible height instead of collapsing the window to zero rows.
 */
export const FALLBACK_VIEWPORT = 600

/** How many rows to render beyond each edge of the viewport by default. */
const DEFAULT_OVERSCAN = 8

/** The slice of rows to render, plus the spacers that stand in for the rest. */
export interface VirtualWindow {
  /** Index of the first row to render (inclusive). */
  start: number
  /** One past the index of the last row to render (exclusive). */
  end: number
  /** Height of the spacer above the rendered rows, in pixels. */
  paddingTop: number
  /** Height of the spacer below the rendered rows, in pixels. */
  paddingBottom: number
}

/** A list with nothing in it: no rows, no spacers. */
function emptyWindow(): VirtualWindow {
  return { start: 0, end: 0, paddingTop: 0, paddingBottom: 0 }
}

/**
 * The rows to render for one scroll position.
 *
 * @param count - how many rows the list holds in total.
 * @param rowHeight - the fixed height of one row, in pixels; a non-positive value
 *   is treated as "nothing can be drawn".
 * @param viewportHeight - the scroller's `clientHeight`; 0 or less falls back to
 *   {@link FALLBACK_VIEWPORT} so an unmeasured pane still draws its first rows.
 * @param scrollTop - the scroller's vertical offset, in pixels.
 * @param overscan - extra rows rendered above and below the viewport, so a fast
 *   scroll does not show blank space while the next frame is being prepared.
 * @returns the half-open row range `[start, end)` and the two spacer heights.
 */
export function windowOf(
  count: number,
  rowHeight: number,
  viewportHeight: number,
  scrollTop: number,
  overscan = 0,
): VirtualWindow {
  if (!(count > 0) || !(rowHeight > 0)) return emptyWindow()
  const viewport = viewportHeight > 0 ? viewportHeight : FALLBACK_VIEWPORT
  const offset = Math.max(scrollTop, 0)
  const extra = Math.max(overscan, 0)
  // The rows the viewport covers, widened by the overscan on both sides. The last
  // row is clamped below because a viewport rarely ends on a row boundary.
  const first = Math.floor(offset / rowHeight) - extra
  const last = Math.ceil((offset + viewport) / rowHeight) + extra
  // `scrollTop` can point past the rows (a pane restored after its list shrank,
  // or a window resized shorter): anchoring on the last row keeps the list from
  // rendering an empty box above a full-height spacer.
  const start = Math.min(Math.max(first, 0), count - 1)
  const end = Math.min(Math.max(last, start + 1), count)
  return {
    start,
    end,
    paddingTop: start * rowHeight,
    paddingBottom: (count - end) * rowHeight,
  }
}

/**
 * Arrange for `callback` to run on the next animation frame, with a short timer
 * where frames do not exist (jsdom in tests, an old WebView).
 * @param callback - the work to defer.
 * @returns a handle for {@link cancelFrame}.
 */
function scheduleFrame(callback: () => void): number {
  if (typeof requestAnimationFrame === 'function') return requestAnimationFrame(callback)
  return window.setTimeout(callback, 16)
}

/**
 * Cancel a frame scheduled by {@link scheduleFrame}.
 * @param handle - the handle it returned.
 */
function cancelFrame(handle: number): void {
  if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(handle)
  else window.clearTimeout(handle)
}

/** Options of {@link useVirtualWindow}. */
export interface UseVirtualWindowOptions {
  /** How many rows the list holds in total. */
  count: number
  /** The fixed height of one row, in pixels; it must match the CSS. */
  rowHeight: number
  /** Rows rendered beyond each edge of the viewport. Defaults to 8. */
  overscan?: number
  /**
   * A value that means "a different list" when it changes — usually the id of the
   * thing being shown. The scroller is sent back to the top, because an offset
   * carried over from another list lands the reader in the middle of rows they
   * have never seen.
   */
  resetKey?: unknown
}

/** The window, plus the ref the scrolling element must be attached to. */
export interface VirtualWindowHandle extends VirtualWindow {
  /**
   * Callback ref for the scrolling container.
   *
   * A callback rather than a ref object because the element is not always mounted
   * on the first render: the review draws no file list until a commit is open, so
   * an effect that read a plain ref would measure `null` once and never again.
   * Attaching the element measures it straight away, in the commit phase rather
   * than after paint, so the first frame is not drawn against the fallback
   * viewport.
   */
  containerRef: (element: HTMLDivElement | null) => void
}

/**
 * Track a scroller's viewport and offset, and derive the rows to render.
 * @param options - see {@link UseVirtualWindowOptions}.
 * @returns the window and the ref to hand to the scrolling element.
 */
export function useVirtualWindow({
  count,
  rowHeight,
  overscan = DEFAULT_OVERSCAN,
  resetKey,
}: UseVirtualWindowOptions): VirtualWindowHandle {
  const [element, setElement] = useState<HTMLDivElement | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewport, setViewport] = useState(0)

  const containerRef = useCallback((node: HTMLDivElement | null): void => {
    setElement(node)
    if (node === null) return
    setScrollTop(node.scrollTop)
    setViewport(node.clientHeight)
  }, [])

  useEffect(() => {
    if (element === null) return undefined
    let frame: number | null = null
    const read = (): void => {
      setScrollTop(element.scrollTop)
      setViewport(element.clientHeight)
    }
    const onScroll = (): void => {
      // Several scroll events arrive per frame and every read of scrollTop or
      // clientHeight can force a layout, so the reads are coalesced onto one
      // frame — that coalescing is most of the point of this hook.
      if (frame !== null) return
      frame = scheduleFrame(() => {
        frame = null
        read()
      })
    }
    element.addEventListener('scroll', onScroll, { passive: true })
    // A resize changes how many rows fit without any scroll event at all: the
    // review's own divider being dragged, or the window being resized.
    let observer: ResizeObserver | null = null
    if (typeof ResizeObserver === 'function') {
      observer = new ResizeObserver(read)
      observer.observe(element)
    }
    return () => {
      element.removeEventListener('scroll', onScroll)
      observer?.disconnect()
      if (frame !== null) cancelFrame(frame)
    }
  }, [element])

  // A different list starts at the top: the scroller itself is reused across
  // commits, so the previous one's offset would otherwise survive the switch.
  useEffect(() => {
    if (element === null) return
    if (element.scrollTop !== 0) element.scrollTop = 0
    setScrollTop(0)
  }, [element, resetKey])

  const range = useMemo(
    () => windowOf(count, rowHeight, viewport, scrollTop, overscan),
    [count, rowHeight, viewport, scrollTop, overscan],
  )

  return { ...range, containerRef }
}
