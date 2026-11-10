// @vitest-environment jsdom
/**
 * The change list's two groups have to stay responsive under a worktree holding
 * thousands of changes.
 *
 * The panel used to mount one row per change in BOTH groups. A branch switch, a
 * bulk delete or a vendored tree appearing can put thousands of rows in each, and
 * building (and re-reconciling, on every optimistic update) tens of thousands of
 * nodes is what made the Changes tab crawl. These tests pin the windowed lists:
 * each group mounts only the rows around its own viewport, still reports the real
 * count in its header, and still scrolls to the rest.
 */
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { ChangesPanel } from '../src/client/git/ChangesPanel.tsx'
import type { FileChange, StatusFilesView } from '../src/core/types.ts'

const t = ((key: string) => key) as never

const GROUP_SIZE = 3_000
const ROW_HEIGHT = 22
/** A row deep enough into the pending group that only a scrolled window holds it. */
const DEEP_INDEX = 2_000
const DEEP_PATH = `dir/worktree-${String(DEEP_INDEX).padStart(5, '0')}.txt`
const FIRST_PATH = 'dir/worktree-00000.txt'

/** One worktree modification, or one staged one: one row per side. */
function change(index: number, staged: boolean): FileChange {
  return staged
    ? {
        path: `dir/staged-${String(index).padStart(5, '0')}.txt`,
        index: 'M', worktree: ' ', kind: 'modified', staged: true, conflicted: false, untracked: false,
        indexStat: { additions: 1, deletions: 1 },
      }
    : {
        path: `dir/worktree-${String(index).padStart(5, '0')}.txt`,
        index: ' ', worktree: 'M', kind: 'modified', staged: false, conflicted: false, untracked: false,
        worktreeStat: { additions: 1, deletions: 1 },
      }
}

/** A worktree with {@link GROUP_SIZE} changes on each side of the index. */
function bigStatus(): StatusFilesView {
  const files: FileChange[] = []
  for (let index = 0; index < GROUP_SIZE; index += 1) files.push(change(index, false), change(index, true))
  return {
    root: '/repo', branch: 'main', head: 'a'.repeat(40), files,
    stagedCount: GROUP_SIZE, unstagedCount: GROUP_SIZE, untrackedCount: 0, conflictedCount: 0,
    operationInProgress: false, operation: '', upstream: '', ahead: 0, behind: 0, remotes: [],
    patches: { worktree: '', staged: '', truncated: false },
  }
}

const noop = (): void => {}

interface Mounted {
  container: HTMLElement
  selected: string[]
}

/** Mount the panel over the big worktree and record every row it opens. */
function mount(status: StatusFilesView = bigStatus()): Mounted {
  const selected: string[] = []
  const { container } = render(
    <ChangesPanel
      status={status}
      selected={null}
      busy={false}
      onSelect={(entry) => { selected.push(entry.path) }}
      onStage={noop}
      onUnstage={noop}
      onDiscard={noop}
      onCommit={async () => true}
      t={t}
    />,
  )
  return { container, selected }
}

/** The scrolling element of one group. */
function scrollerOf(container: HTMLElement, group: 'unstaged' | 'staged'): HTMLElement {
  const scroller = container.querySelector(`[data-gitgraph-changes-scroll="${group}"]`)
  if (!(scroller instanceof HTMLElement)) throw new Error(`group ${group} has no scroller`)
  return scroller
}

afterEach(cleanup)

describe('the change list of a huge worktree', () => {
  it('mounts only the rows around each group viewport but keeps the real counts', async () => {
    const { container } = mount()
    await waitFor(() => { expect(container.querySelector('[data-gitgraph-file]')).not.toBeNull() })

    const rows = container.querySelectorAll('[data-gitgraph-file]')
    // Both groups are windowed; a full mount would be 6000 rows.
    expect(rows.length).toBeLessThan(200)
    expect(rows.length).toBeGreaterThan(0)
    // A deep row is not mounted yet, so the window really is a window.
    expect(container.querySelector(`[data-gitgraph-file="${DEEP_PATH}"]`)).toBeNull()
    // Each header still reports its whole group, not the mounted slice.
    for (const group of ['unstaged', 'staged']) {
      const header = container.querySelector(`[data-gitgraph-group="${group}"]`)
      expect(header?.textContent).toContain(String(GROUP_SIZE))
    }
  })

  it('mounts the rows around a scrolled group instead', async () => {
    const { container } = mount()
    await waitFor(() => { expect(container.querySelector('[data-gitgraph-file]')).not.toBeNull() })
    const scroller = scrollerOf(container, 'unstaged')

    await act(async () => {
      scroller.scrollTop = DEEP_INDEX * ROW_HEIGHT
      fireEvent.scroll(scroller)
      // The handler reads the scroller on the next frame; jsdom may fall back to
      // the hook's short timer, so wait past either.
      await new Promise<void>((resolve) => { setTimeout(resolve, 40) })
    })

    await waitFor(() => {
      expect(container.querySelector(`[data-gitgraph-file="${DEEP_PATH}"]`)).not.toBeNull()
    })
    expect(container.querySelector(`[data-gitgraph-file="${FIRST_PATH}"]`)).toBeNull()
    // The other group is untouched by this group's scroll.
    expect(container.querySelector('[data-gitgraph-changes-scroll="staged"]')).not.toBeNull()
    expect(container.querySelectorAll('[data-gitgraph-file]').length).toBeLessThan(200)
  })

  it('still opens the row a reader clicks', async () => {
    const { container, selected } = mount()
    await waitFor(() => { expect(container.querySelector('[data-gitgraph-file]')).not.toBeNull() })

    const target = container.querySelector('[data-gitgraph-file="dir/worktree-00003.txt"]')
    if (!(target instanceof HTMLElement)) throw new Error('the fourth row is not in the window')
    fireEvent.click(target)
    expect(selected).toEqual(['dir/worktree-00003.txt'])
  })
})
