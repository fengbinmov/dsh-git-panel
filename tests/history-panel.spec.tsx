// @vitest-environment jsdom
/**
 * The History list's commit rows and the graph drawn beside them.
 *
 * The list is the left column of the History tab: one row per commit, each with a
 * lane-graph SVG, the ref chips, and the commit's identity. These tests pin the
 * parts the rest of the panel relies on — the DOM anchors GitView and the detail
 * pane select through, the ref KIND distinction (a checked-out branch, a local
 * branch, a remote branch and a tag used to render as one anonymous chip), the
 * hollow node for a commit no remote has, and the virtual window that keeps a
 * history of thousands of commits cheap to mount.
 *
 * The lane GEOMETRY itself is history-graph's contract and is tested there; these
 * tests never assert a lane count or a curve, because the layout is intentionally
 * free to change shape as long as the row and the SVG agree.
 *
 * jsdom measures every element as zero, which is why the window has a fallback
 * viewport and why a scroll assertion fires a real `scroll` event instead of
 * relying on layout.
 */
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { COMMIT_ROW_HEIGHT, HistoryPanel } from '../src/client/git/HistoryPanel.tsx'
import type { CommitRef, HistoryCommit, HistoryView } from '../src/core/types.ts'
import css from '../src/client/git/git.module.css'

/** The key itself, so a test reads the copy key the component asked for. */
const t = ((key: string) => key) as never

/**
 * One plain commit row. `parents` is empty unless a test supplies them: most of
 * these cases are about the row's contents, not about the lane layout.
 */
function commit(index: number, patch: Partial<HistoryCommit> = {}): HistoryCommit {
  return {
    oid: `oid-${String(index).padStart(4, '0')}`,
    shortOid: String(index).padStart(7, '0').slice(-7),
    parents: [],
    subject: `commit subject ${index}`,
    author: 'tester',
    authorEmail: 't@dsh.local',
    authorTime: 1_700_000_000 + index,
    refs: [],
    ...patch,
  }
}

/** One history page over a fresh repository root. */
function historyView(commits: HistoryCommit[], hasMore = false): HistoryView {
  return { root: '/repo', branch: 'main', commits, hasMore }
}

interface Mounted {
  container: HTMLElement
  selected: string[]
  /** One entry per "load more" click; an array so the click is visible after mount. */
  loads: number[]
}

/** Mount the panel over one view, recording the selection and paging callbacks. */
function mount(view: HistoryView, selectedOid: string | null = null): Mounted {
  const selected: string[] = []
  const loads: number[] = []
  const { container } = render(
    <HistoryPanel
      view={view}
      loading={false}
      selectedOid={selectedOid}
      onSelect={(oid) => { selected.push(oid) }}
      onLoadMore={() => { loads.push(1) }}
      t={t}
    />,
  )
  return { container, selected, loads }
}

/** Every mounted commit row, in order. */
function rowsOf(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('[data-gitgraph-commit-oid]')]
}

/** The scrolling element of the commit list. */
function scrollerOf(container: HTMLElement): HTMLElement {
  const scroller = container.querySelector('[data-gitgraph-history-scroll]')
  if (!(scroller instanceof HTMLElement)) throw new Error('the history list has no scroller')
  return scroller
}

/** The height of one of the two spacers, in pixels (0 when absent). */
function spacerHeight(container: HTMLElement, which: 'top' | 'bottom'): number {
  const spacer = container.querySelector(`[data-gitgraph-history-spacer="${which}"]`)
  if (!(spacer instanceof HTMLElement)) return 0
  return Number.parseFloat(spacer.style.height === '' ? '0' : spacer.style.height)
}

afterEach(cleanup)

describe('the history commit list', () => {
  it('renders one row per commit with the identity the detail pane needs', () => {
    const view = historyView([commit(0), commit(1), commit(2)])
    const { container } = mount(view)

    const rows = rowsOf(container)
    expect(rows.length).toBe(3)
    expect(rows.map(row => row.getAttribute('data-gitgraph-commit-oid'))).toEqual([
      'oid-0000',
      'oid-0001',
      'oid-0002',
    ])
    // The row is a real button, so Enter/Space select it without extra handlers.
    expect(rows[0]?.tagName).toBe('BUTTON')
    expect(rows[0]?.getAttribute('type')).toBe('button')
    // Subject, author and the relative time live in the row; the short id does
    // NOT — the whole id is the detail pane's business, and printing seven
    // hex characters on every row only pushed the subject to the right.
    expect(rows[1]?.textContent).not.toContain('0000001')
    expect(rows[1]?.textContent).toContain('commit subject 1')
    expect(rows[1]?.textContent).toContain('tester')
  })

  it('selects the row a reader clicks and keeps the selected row marked', () => {
    const view = historyView([commit(0), commit(1)])
    const { container, selected } = mount(view, 'oid-0001')

    fireEvent.click(rowsOf(container)[0] as HTMLElement)
    expect(selected).toEqual(['oid-0000'])

    // The selected row is the one the view passed in, and its class says so.
    const active = container.querySelector('[data-gitgraph-commit-oid="oid-0001"]')
    const idle = container.querySelector('[data-gitgraph-commit-oid="oid-0000"]')
    expect(active?.classList.contains(css.commitRowActive)).toBe(true)
    expect(idle?.classList.contains(css.commitRowActive)).toBe(false)
  })

  it('shows the load-more affordance only when there is another page', () => {
    const more = mount(historyView([commit(0)], true))
    const moreButton = more.container.querySelector('[data-gitgraph-history-more]')
    expect(moreButton).not.toBeNull()
    // The button keeps its place below the list: it is not inside the virtual
    // scroller, so it neither scrolls with the rows nor gets wrapped by a spacer.
    expect(scrollerOf(more.container).contains(moreButton)).toBe(false)
    fireEvent.click(moreButton as HTMLElement)
    expect(more.loads).toHaveLength(1)

    cleanup()
    const done = mount(historyView([commit(0)], false))
    expect(done.container.querySelector('[data-gitgraph-history-more]')).toBeNull()
  })
})

describe('the ref chips', () => {
  const REFS: CommitRef[] = [
    { name: 'main', kind: 'head' },
    { name: 'feature/graph', kind: 'branch' },
    { name: 'origin/main', kind: 'remote' },
    { name: 'v1.0.0', kind: 'tag' },
  ]

  it('renders every ref kind with its own material', () => {
    const view = historyView([commit(0, { refs: REFS })])
    const { container } = mount(view)

    const chips = [...container.querySelectorAll<HTMLElement>('[data-gitgraph-ref-kind]')]
    expect(chips.map(chip => chip.getAttribute('data-gitgraph-ref-kind'))).toEqual([
      'head',
      'branch',
      'remote',
      'tag',
    ])
    expect(chips.map(chip => chip.textContent)).toEqual(['main', 'feature/graph', 'origin/main', 'v1.0.0'])

    // Each kind wears its own class, so the four are distinguishable on screen.
    expect(chips[0]?.classList.contains(css.refBadgeHead)).toBe(true)
    expect(chips[1]?.classList.contains(css.refBadgeBranch)).toBe(true)
    expect(chips[2]?.classList.contains(css.refBadgeRemote)).toBe(true)
    expect(chips[3]?.classList.contains(css.refBadgeTag)).toBe(true)
    for (const [index, chip] of chips.entries()) {
      expect(chip.classList.contains(css.refBadge)).toBe(true)
      // No two kinds share a material.
      for (const other of chips.slice(index + 1)) expect(chip.className).not.toBe(other.className)
    }
  })

  it('paints every chip with the branch colour its graph line and node use', () => {
    const view = historyView([commit(0, { refs: REFS })])
    const { container } = mount(view)

    const chips = [...container.querySelectorAll<HTMLElement>('[data-gitgraph-ref-kind]')]
    const node = container.querySelector<SVGCircleElement>('[data-gitgraph-history-node]')
    // The chip colour is handed to CSS as one custom property…
    const rowColor = chips[0]?.style.getPropertyValue('--ref-color').trim()
    expect(rowColor).toBeTruthy()
    // …and it is exactly the colour the graph painted this row's node (and so its
    // line) with: a branch's name and its line must read as one thing.
    expect(node?.getAttribute('fill')).toBe(rowColor)
    // Every chip on the row shares it, tag and remote chip included.
    for (const chip of chips) {
      expect(chip.style.getPropertyValue('--ref-color').trim()).toBe(rowColor)
      expect(chip.getAttribute('data-gitgraph-ref-color')).toBe(rowColor)
    }
  })

  it('keeps a tooltip naming the kind and the ref', () => {
    const view = historyView([commit(0, { refs: REFS })])
    const { container } = mount(view)

    const chips = [...container.querySelectorAll<HTMLElement>('[data-gitgraph-ref-kind]')]
    expect(chips[0]?.title).toBe('git.history.refHead: main')
    expect(chips[1]?.title).toBe('git.history.refBranch: feature/graph')
    expect(chips[2]?.title).toBe('git.history.refRemote: origin/main')
    expect(chips[3]?.title).toBe('git.history.refTag: v1.0.0')
  })
})

describe('the graph nodes', () => {
  it('draws a hollow node for an unpushed commit and a filled one otherwise', () => {
    // `undefined` is an old host's answer: treat it as pushed rather than invent
    // an "unpushed" marker the host never claimed.
    const view = historyView([
      commit(0, { pushed: true }),
      commit(1, { pushed: false }),
      commit(2),
    ])
    const { container } = mount(view)

    const nodes = [...container.querySelectorAll('[data-gitgraph-history-node]')]
    expect(nodes.map(node => node.getAttribute('data-gitgraph-history-pushed'))).toEqual(['true', 'false', 'true'])

    // The hollow dot is stroke-only over the panel surface; the filled one is a
    // solid palette colour. Asserting both makes the two genuinely different in
    // the DOM, not merely labelled differently.
    const hollow = nodes[1] as SVGElement
    const filled = nodes[0] as SVGElement
    expect(hollow.style.fill).toBe('var(--dsw-alias-bg-base)')
    expect(hollow.getAttribute('fill')).toBeNull()
    expect(Number(hollow.getAttribute('stroke-width'))).toBeGreaterThan(0)
    expect(filled.getAttribute('fill')).toMatch(/^#/)
    expect(Number(filled.getAttribute('stroke-width'))).toBe(0)

    // The hollow shape is explained on hover, and only for the unpushed commit.
    const row = (oid: string): HTMLElement =>
      container.querySelector(`[data-gitgraph-commit-oid="${oid}"]`) as HTMLElement
    expect(row('oid-0001').title).toBe('git.history.unpushed')
    expect(row('oid-0000').title).toBe('')
  })

  it('marks the selected row node with an outer ring', () => {
    const view = historyView([commit(0), commit(1), commit(2)])
    const { container } = mount(view, 'oid-0001')

    const rings = container.querySelectorAll('[data-gitgraph-history-selected-ring]')
    expect(rings.length).toBe(1)
    const selectedRow = container.querySelector('[data-gitgraph-commit-oid="oid-0001"]')
    expect(selectedRow?.querySelector('[data-gitgraph-history-selected-ring]')).not.toBeNull()
  })
})

describe('the virtualized commit list', () => {
  /** A long linear history: one lane is all the tests need from the layout. */
  const COUNT = 200
  /** Deep enough that only a scrolled window can hold it. */
  const DEEP_INDEX = 150
  const DEEP_OID = commit(DEEP_INDEX).oid
  const FIRST_OID = commit(0).oid

  /** Commits linked parent-to-child, the ordinary shape of a linear history. */
  function longHistory(): HistoryView {
    const commits = Array.from({ length: COUNT }, (_, index) => commit(index, {
      parents: index + 1 < COUNT ? [commit(index + 1).oid] : [],
    }))
    return historyView(commits, false)
  }

  it('mounts only the rows around the viewport and pads the rest with spacers', () => {
    const { container } = mount(longHistory())
    const rows = rowsOf(container)

    // jsdom reports no height, so windowOf falls back to FALLBACK_VIEWPORT; either
    // way a window must be a small fraction of the 200-row history.
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.length).toBeLessThan(COUNT)
    expect(container.querySelector(`[data-gitgraph-commit-oid="${FIRST_OID}"]`)).not.toBeNull()
    expect(container.querySelector(`[data-gitgraph-commit-oid="${DEEP_OID}"]`)).toBeNull()

    // The spacers stand in for the rows not mounted, so the scroller measures the
    // whole history while the DOM holds only the window.
    const mountedHeight = rows.length * COMMIT_ROW_HEIGHT
    expect(spacerHeight(container, 'top')).toBe(0)
    expect(spacerHeight(container, 'bottom')).toBe(COUNT * COMMIT_ROW_HEIGHT - mountedHeight)
  })

  it('moves the window when the list is scrolled', async () => {
    const { container } = mount(longHistory())
    const scroller = scrollerOf(container)
    expect(rowsOf(container).length).toBeLessThan(COUNT)

    await act(async () => {
      scroller.scrollTop = DEEP_INDEX * COMMIT_ROW_HEIGHT
      fireEvent.scroll(scroller)
      // The hook reads the scroller on the next frame; jsdom may fall back to its
      // short timer, so wait past either.
      await new Promise<void>((resolve) => { setTimeout(resolve, 40) })
    })

    await waitFor(() => {
      expect(container.querySelector(`[data-gitgraph-commit-oid="${DEEP_OID}"]`)).not.toBeNull()
    })
    // The top of the list has left the window, as a windowed list must.
    expect(container.querySelector(`[data-gitgraph-commit-oid="${FIRST_OID}"]`)).toBeNull()
    expect(rowsOf(container).length).toBeLessThan(COUNT)
    expect(spacerHeight(container, 'top')).toBeGreaterThan(0)
  })
})
