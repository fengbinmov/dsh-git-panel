// @vitest-environment jsdom
/**
 * The line-selection surface of the preview: which button appears for which side,
 * what a drag chooses, and what the rebuilt fragment contains.
 *
 * The patch itself is proven against real git in `selection-stage.spec.ts`; this file
 * is about the interface — the pending side offers stage AND discard, the staged side
 * offers only unstage, and a commit's diff (no side) offers nothing at all.
 */
import { readFileSync } from 'node:fs'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { DetailPane } from '../src/client/git/DetailPane.tsx'
import { DiffFileView } from '../src/client/git/DiffFileView.tsx'
import { splitPatch, type FileDiff, type SelectionDirection } from '../src/client/git/diff-parse.ts'
import type { DiffView } from '../src/core/types.ts'

const t = ((key: string, params?: Record<string, unknown>) => (
  params === undefined ? key : `${key}:${JSON.stringify(params)}`
)) as never

/** A two-hunk change: one replacement and one insertion. */
const PATCH = [
  'diff --git a/a.txt b/a.txt',
  'index 1111111..2222222 100644',
  '--- a/a.txt',
  '+++ b/a.txt',
  '@@ -1,3 +1,4 @@',
  ' keep one',
  '-old two',
  '+new two',
  ' keep three',
  '@@ -10,2 +11,3 @@',
  ' keep ten',
  '+added eleven',
  '',
].join('\n')

function parsed(): FileDiff {
  const section = splitPatch(PATCH)[0]
  if (section === undefined) throw new Error('the patch did not parse')
  return section
}

type Applied = { direction: SelectionDirection; fragment: string }

/** Mount the viewer and hand back its rows plus what an apply reported. */
function mount(side: 'pending' | 'staged' | null) {
  const applied: Applied[] = []
  const { container } = render(
    <DiffFileView
      file={parsed()}
      t={t}
      side={side}
      onApplySelection={side === null ? undefined : (direction, fragment) => { applied.push({ direction, fragment }) }}
    />,
  )
  const rows = [...container.querySelectorAll<HTMLElement>('[data-diff-index]')]
  const bar = (): HTMLElement | null => container.querySelector<HTMLElement>('[data-gitgraph-line-bar]')
  return { container, rows, applied, bar }
}

/**
 * Drag from one row's GUTTER to another, the way the pointer does it.
 *
 * The gutter is the handle: a drag that starts in the text beside it belongs to the
 * browser (see the text-selection test below). jsdom has no `PointerEvent`, so
 * `fireEvent.pointerDown` would send a bare Event with no `button`/`clientX` on it —
 * which the handler is right to ignore — so a `MouseEvent` carries those fields under
 * the pointer event's type name, which is what React listens for.
 */
function drag(rows: HTMLElement[], from: number, to: number): void {
  const gutter = (index: number): HTMLElement => {
    const cell = rows[index]?.querySelector<HTMLElement>('[data-diff-gutter]')
    if (cell === null || cell === undefined) throw new Error('row missing')
    return cell
  }
  const at = (y: number) => ({ bubbles: true, button: 0, clientX: 10, clientY: y })
  fireEvent(gutter(from), new MouseEvent('pointerdown', at(10)))
  fireEvent(gutter(to), new MouseEvent('pointermove', at(60)))
  fireEvent(gutter(to), new MouseEvent('pointerup', at(60)))
}

/** One row's gutter cell — the handle a drag starts on. */
function gutterOf(rows: HTMLElement[], index: number): HTMLElement {
  const cell = rows[index]?.querySelector<HTMLElement>('[data-diff-gutter]')
  if (cell === null || cell === undefined) throw new Error(`row ${index} has no gutter`)
  return cell
}

afterEach(cleanup)

describe('the cursor a row drag shows', () => {
  /**
   * The handle has to LOOK like a handle for the whole gesture.
   *
   * The drag starts on the gutter, which owns the resize cursor, but the pointer
   * leaves it immediately and travels over the code — and the code has an ordinary
   * cursor of its own. Handing the document the cursor for the length of the drag is
   * what keeps the cue on screen exactly while it is being used.
   */
  const at = (y: number) => ({ bubbles: true, button: 0, clientX: 10, clientY: y })

  it('takes the document cursor on pointerdown and keeps it while extending', () => {
    const { rows } = mount('pending')
    expect(document.body.style.cursor).toBe('')
    fireEvent(gutterOf(rows, 2), new MouseEvent('pointerdown', at(10)))
    expect(document.body.style.cursor).toBe('row-resize')
    // The range keeps growing under the pointer, well past the gutter it started on.
    fireEvent(gutterOf(rows, 4), new MouseEvent('pointermove', at(60)))
    expect(document.body.style.cursor).toBe('row-resize')
  })

  it('hands the cursor back when the selection ends', () => {
    const { rows } = mount('pending')
    const handle = gutterOf(rows, 2)
    fireEvent(handle, new MouseEvent('pointerdown', at(10)))
    fireEvent(handle, new MouseEvent('pointermove', at(60)))
    fireEvent(handle, new MouseEvent('pointerup', at(60)))
    expect(document.body.style.cursor).toBe('')
  })

  it('puts the cursor back if the pane is unmounted mid-drag', () => {
    // Switching files while the pointer is down unmounts this pane; the document is
    // not the pane's to leave holding a cursor.
    const { rows } = mount('pending')
    fireEvent(gutterOf(rows, 2), new MouseEvent('pointerdown', at(10)))
    expect(document.body.style.cursor).toBe('row-resize')
    cleanup()
    expect(document.body.style.cursor).toBe('')
  })
})

describe('the preview line selection', () => {
  it('offers stage and discard for a pending preview', () => {
    const { rows, container, bar } = mount('pending')
    expect(bar()).toBeNull()
    // Row 2 is `-old two`, row 3 is `+new two`.
    drag(rows, 2, 3)
    const actions = bar()
    expect(actions).not.toBeNull()
    expect(actions?.querySelector('[data-gitgraph-line-stage]')).not.toBeNull()
    expect(actions?.querySelector('[data-gitgraph-line-discard]')).not.toBeNull()
    expect(actions?.querySelector('[data-gitgraph-line-unstage]')).toBeNull()
    // The chosen rows are marked as such.
    expect(container.querySelectorAll('[class*="_diffRowChosen"]')).toHaveLength(2)
  })

  it('offers only unstage for a staged preview', () => {
    const { rows, bar } = mount('staged')
    drag(rows, 2, 3)
    const actions = bar()
    expect(actions?.querySelector('[data-gitgraph-line-unstage]')).not.toBeNull()
    expect(actions?.querySelector('[data-gitgraph-line-stage]')).toBeNull()
    expect(actions?.querySelector('[data-gitgraph-line-discard]')).toBeNull()
  })

  it('gives each action the colour of the rows it moves', () => {
    // The bar used to be bare labels on a floating card — no fill, no border — which
    // left the reader working out where one control ended and whether either was
    // clickable. Each action now carries its own fill class, and the fill is the
    // same colour the rows it acts on are drawn in.
    const { rows, bar } = mount('pending')
    drag(rows, 2, 3)
    expect(bar()?.querySelector('[data-gitgraph-line-stage]')?.className).toContain('lineActionAdd')
    expect(bar()?.querySelector('[data-gitgraph-line-discard]')?.className).toContain('lineActionDel')
  })

  it('offers nothing on a commit\'s diff, where there is no index to apply to', () => {
    const { rows, container } = mount(null)
    drag(rows, 2, 3)
    expect(container.querySelector('[data-gitgraph-line-bar]')).toBeNull()
    expect(container.querySelectorAll('[class*="_diffRowChosen"]')).toHaveLength(0)
  })

  it('hands over a fragment holding the chosen rows and none of the others', () => {
    const { rows, applied } = mount('pending')
    // Pick the insertion in the SECOND hunk only (found by its text, not by index).
    const target = rows.findIndex(row => row.textContent?.includes('added eleven'))
    expect(target).toBeGreaterThan(0)
    drag(rows, target, target)
    const actions = document.querySelector<HTMLElement>('[data-gitgraph-line-stage]')
    fireEvent.click(actions as HTMLElement)
    expect(applied).toHaveLength(1)
    const { direction, fragment } = applied[0]!
    expect(direction).toBe('stage')
    expect(fragment).toContain('+added eleven')
    // The untouched hunk is not in the patch at all, and neither is the replacement.
    expect(fragment).not.toContain('new two')
    expect(fragment).not.toContain('old two')
    expect(fragment.split('\n').filter(line => line.startsWith('@@'))).toHaveLength(1)
    // The bar goes away with the action.
    expect(document.querySelector('[data-gitgraph-line-bar]')).toBeNull()
  })

  it('takes the chosen rows off the screen with the button, not after the host answers', () => {
    const { rows, container, applied } = mount('pending')
    const before = rows.length
    // Rows 2 and 3 are the removed and re-added `two`.
    drag(rows, 2, 3)
    fireEvent.click(container.querySelector<HTMLElement>('[data-gitgraph-line-stage]') as HTMLElement)
    // Deliberately not awaited: the lines have to leave in the same update that takes
    // the bar away, or the button reads as unresponsive for a whole round trip.
    expect(container.querySelectorAll('[data-diff-index]')).toHaveLength(before - 2)
    expect(container.querySelector('[data-gitgraph-line-bar]')).toBeNull()
    expect(applied).toHaveLength(1)
    // The rest of the patch — the other hunk and the context — is still there.
    expect(container.textContent).toContain('added eleven')
    expect(container.textContent).toContain('keep one')
  })

  it('leaves a gesture in the TEXT to the browser, so a few words can be selected', () => {
    const { rows, container } = mount('pending')
    const text = rows[1]?.querySelector('[data-diff-text]')
    if (text === null || text === undefined) throw new Error('no text cell')
    const at = { bubbles: true, button: 0, clientX: 90, clientY: 10 }
    fireEvent(text, new MouseEvent('pointerdown', at))
    fireEvent(text, new MouseEvent('pointermove', { ...at, clientY: 60 }))
    fireEvent(text, new MouseEvent('pointerup', { ...at, clientY: 60 }))
    // No line selection: the gutter is the handle, and this gesture never touched it.
    expect(container.querySelector('[data-gitgraph-line-bar]')).toBeNull()
    expect(container.querySelectorAll('[class*="_diffRowChosen"]')).toHaveLength(0)
  })

  it('clears the selection when the patch under it changes', () => {
    const { rows, container, bar } = mount('pending')
    drag(rows, 2, 3)
    expect(bar()).not.toBeNull()
    // A refresh replaces the file object; the rows it referred to may be gone.
    cleanup()
    const next = mount('pending')
    drag(next.rows, 2, 3)
    expect(next.bar()).not.toBeNull()
    cleanup()
    expect(container.isConnected).toBe(false)
  })
})


/**
 * The floating bar's geometry, pinned against a stubbed layout (jsdom lays nothing
 * out, so every rect is what the test says it is).
 *
 * The bar belongs to the preview: it is positioned against the detail pane — the
 * ancestor that also clips it — so its numbers are PANE-relative, and it is clamped
 * into the diff's own viewport so a selection scrolled out of sight cannot leave its
 * buttons over the header or, worse, outside the pane.
 */
describe('the line-action bar geometry', () => {
  let rowTop = 200
  let restore: (() => void) | null = null

  afterEach(() => {
    restore?.()
    restore = null
    rowTop = 200
  })

  /** A pane at y=100 (its diff viewport from y=130 to y=500) with the bar mounted in it. */
  function mountInPane(): HTMLElement {
    const rectOf = (over: Partial<DOMRect>): DOMRect => ({
      top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0,
      toJSON: () => ({}),
      ...over,
    } as DOMRect)
    const pane = { top: 100, bottom: 500, left: 200, right: 600, width: 400, height: 400 }
    const scroll = { top: 130, bottom: 500, left: 200, right: 600, width: 400, height: 370 }
    const barBox = { top: 0, bottom: 32, left: 480, right: 600, width: 120, height: 32 }
    const original = Element.prototype.getBoundingClientRect
    Element.prototype.getBoundingClientRect = function (this: Element) {
      if (this.getAttribute('data-gitgraph-part') === 'detail') return rectOf(pane)
      if (this.hasAttribute('data-gitgraph-line-bar')) return rectOf(barBox)
      if (this.hasAttribute('data-diff-index')) return rectOf({ top: rowTop, bottom: rowTop + 20, height: 20 })
      if (this.querySelector(':scope > [data-gitgraph-diff]') !== null) return rectOf(scroll)
      return rectOf({})
    }
    restore = () => { Element.prototype.getBoundingClientRect = original }

    const diff: DiffView = { path: 'a.txt', staged: false, binary: false, truncated: false, patch: PATCH }
    const { container } = render(
      <DetailPane
        selection={{ path: 'a.txt', staged: false }}
        diff={diff}
        loading={false}
        onApplySelection={() => {}}
        t={t}
      />,
    )
    const rows = [...container.querySelectorAll<HTMLElement>('[data-diff-index]')]
    drag(rows, 2, 3)
    const bar = container.querySelector<HTMLElement>('[data-gitgraph-line-bar]')
    if (bar === null) throw new Error('the bar did not appear')
    return bar
  }

  it('is positioned against the detail pane, not the viewport', () => {
    const bar = mountInPane()
    // Row y=200, pane y=100: 100px is pane-relative. A viewport calculation would
    // have kept the raw 200, and the right edge is the pane's 8px inset.
    expect(bar.style.top).toBe('100px')
    expect(bar.style.right).toBe('8px')
  })

  it('is clamped inside the diff viewport once the selection scrolls out of sight', () => {
    const bar = mountInPane()
    rowTop = 50
    fireEvent.scroll(window)
    expect(bar.style.top).toBe('34px') // diff viewport top 134, minus the pane's 100
    rowTop = 520
    fireEvent.scroll(window)
    expect(bar.style.top).toBe('364px') // 500 - bar height 32 - inset 4, minus 100
  })
})

/**
 * The gutter is the line-selection handle, and it has to be the WHOLE gutter.
 *
 * An added row has no old number and a deleted row has no new one, so half of the
 * gutter is blank on exactly the rows a reader is aiming at. jsdom lays nothing out,
 * so the height cannot be measured here; the first test pins the CSS rule that keeps
 * a blank cell from collapsing to zero height, and the second proves the DOM puts the
 * blank cell in the handle at all. (The real-browser probe in the layout-check
 * harness measures the hit area directly.)
 */
describe('the gutter handle, blank cells included', () => {
  it('stretches every number cell and marker to the row height', () => {
    // vitest runs from the package root (the `test` script is `vitest run`).
    const css = readFileSync('src/client/git/git.module.css', 'utf8')
    const ruleOf = (selector: string): string => {
      // Anchored at a line start: `.diffMark {` also appears inside `.diffRowAdd .diffMark {`.
      const at = css.indexOf('\n' + selector + ' {')
      if (at < 0) throw new Error(`${selector} not found`)
      return css.slice(at, css.indexOf('}', at))
    }
    // `align-items: flex-start` on .diffRow makes an empty cell zero-height, which is
    // what stopped the pointer landing on the blank half.
    expect(ruleOf('.diffNum')).toMatch(/align-self:\s*stretch/)
    expect(ruleOf('.diffMark')).toMatch(/align-self:\s*stretch/)
  })

  it('lets a drag start on the blank number cell of an added or deleted row', () => {
    const { rows, container, bar } = mount('pending')
    // Row 2 is `-old two` (no new number); row 3 is `+new two` (no old number).
    const blankNew = rows[2]?.children[1]
    const blankOld = rows[3]?.children[0]
    if (blankNew === undefined || blankOld === undefined) throw new Error('the gutter cells are missing')
    expect(blankNew.textContent).toBe('')
    expect(blankOld.textContent).toBe('')
    expect(blankNew.getAttribute('data-diff-gutter')).not.toBeNull()
    expect(blankOld.getAttribute('data-diff-gutter')).not.toBeNull()

    const at = (y: number): MouseEventInit => ({ bubbles: true, button: 0, clientX: 10, clientY: y })
    fireEvent(blankNew, new MouseEvent('pointerdown', at(10)))
    fireEvent(blankOld, new MouseEvent('pointermove', at(60)))
    fireEvent(blankOld, new MouseEvent('pointerup', at(60)))

    expect(bar()).not.toBeNull()
    expect(container.querySelectorAll('[class*="_diffRowChosen"]')).toHaveLength(2)
  })
})
