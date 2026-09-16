// @vitest-environment jsdom
/**
 * The changes panel's rows and rails.
 *
 * There are exactly two groups, one per side of the index boundary, and both are
 * on screen whether or not they hold files: a group that vanished as it emptied
 * took its share of the list with it, so the split the user had arranged jumped
 * about under them as they staged and unstaged. Splitting the pending side further
 * (untracked / changes / conflicts) produced regions that came and went, and it
 * hid a path whose index side and worktree side had BOTH moved — that path's
 * worktree change was listed nowhere at all. These tests pin the two rails, the
 * both-sides rule, the per-side badge, and the keyboard Delete verb, which is the
 * only per-row action left now that staging is a drag.
 */
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { ChangesPanel } from '../src/client/git/ChangesPanel.tsx'
import { badgeOf, sideKindOf, splitPath } from '../src/client/git/helpers.ts'
import type { FileChange, StatusFilesView } from '../src/core/types.ts'

const t = ((key: string) => key) as never

function staged(path: string): FileChange {
  return { path, index: 'M', worktree: ' ', kind: 'modified', staged: true, conflicted: false, untracked: false }
}

function unstaged(path: string): FileChange {
  return { path, index: ' ', worktree: 'M', kind: 'modified', staged: false, conflicted: false, untracked: false }
}

function untracked(path: string): FileChange {
  return { path, index: '?', worktree: '?', kind: 'untracked', staged: false, conflicted: false, untracked: true }
}

function conflicted(path: string): FileChange {
  return { path, index: 'U', worktree: 'U', kind: 'conflicted', staged: false, conflicted: true, untracked: false }
}

/**
 * A file added to the index and then edited again — `git status` reports `AM`.
 * Both of its changes are real, and they belong in two different groups.
 */
function addedThenEdited(path: string): FileChange {
  return { path, index: 'A', worktree: 'M', kind: 'added', staged: true, conflicted: false, untracked: false }
}

function statusOf(files: FileChange[]): StatusFilesView {
  return {
    root: '/repo',
    branch: 'main',
    head: 'a'.repeat(40),
    files,
    stagedCount: files.filter(file => file.staged).length,
    // The host counts the WORKTREE side (a path can be in both counts), which is
    // the same rule the list groups by.
    unstagedCount: files.filter(file => !file.untracked && !file.conflicted && file.worktree !== ' ').length,
    untrackedCount: files.filter(file => file.untracked).length,
    conflictedCount: files.filter(file => file.conflicted).length,
    operationInProgress: false,
    operation: '',
    upstream: 'origin/main',
    behind: 0,
    ahead: 0,
  }
}

/** Mount the panel with recorded verbs, and return its rows in render order. */
function mountWith(files: FileChange[]): {
  rows: HTMLElement[]
  discarded: string[][]
  unstagedCalls: string[][]
} {
  const discarded: string[][] = []
  const unstagedCalls: string[][] = []
  const { container } = render(
    <ChangesPanel
      status={statusOf(files)}
      selected={null}
      busy={false}
      onSelect={() => {}}
      onStage={() => {}}
      onUnstage={(paths) => { unstagedCalls.push([...paths]) }}
      onDiscard={(paths) => { discarded.push([...paths]) }}
      onCommit={() => {}}
      t={t}
    />,
  )
  return {
    rows: [...container.querySelectorAll<HTMLElement>('[data-gitgraph-file]')],
    discarded,
    unstagedCalls,
  }
}

/** Mount the panel and return its groups in visual order, with their rows. */
function rail(files: FileChange[]): {
  key: string
  text: string
  rows: { path: string; staged: boolean; badge: string }[]
}[] {
  const { container } = render(
    <ChangesPanel
      status={statusOf(files)}
      selected={null}
      busy={false}
      onSelect={() => {}}
      onStage={() => {}}
      onUnstage={() => {}}
      onDiscard={() => {}}
      onCommit={() => {}}
      t={t}
    />,
  )
  return [...container.querySelectorAll('[data-gitgraph-group]')].map(element => ({
    key: element.getAttribute('data-gitgraph-group') ?? '',
    text: element.textContent ?? '',
    rows: [...element.querySelectorAll('[data-gitgraph-file]')].map(row => ({
      path: row.getAttribute('data-gitgraph-file') ?? '',
      staged: row.getAttribute('data-gitgraph-file-staged') === 'true',
      badge: row.querySelector('[data-gitgraph-badge]')?.getAttribute('data-gitgraph-badge') ?? '',
    })),
  }))
}

/** Which groups a path is listed in, in visual order. */
function groupsOf(files: FileChange[], path: string): string[] {
  return rail(files).filter(group => group.rows.some(row => row.path === path)).map(group => group.key)
}

afterEach(cleanup)

describe('Delete acts on the region the row is in', () => {
  it('discards a pending row straight away, with nothing to confirm', () => {
    const { rows, discarded, unstagedCalls } = mountWith([unstaged('a.ts')])
    fireEvent.keyDown(rows[0], { key: 'Delete' })
    expect(discarded).toEqual([['a.ts']])
    expect(unstagedCalls).toEqual([])
  })

  it('sends a staged row back to the pending region', () => {
    const { rows, discarded, unstagedCalls } = mountWith([staged('a.ts')])
    fireEvent.keyDown(rows[0], { key: 'Delete' })
    expect(unstagedCalls).toEqual([['a.ts']])
    expect(discarded).toEqual([])
  })

  it('carries the whole selection, splitting it by region', () => {
    const { rows, discarded, unstagedCalls } = mountWith([unstaged('a.ts'), unstaged('b.ts'), staged('c.ts')])
    // Select all three: plain click, then Ctrl+click for the rest.
    fireEvent.click(rows[0])
    fireEvent.click(rows[1], { ctrlKey: true })
    fireEvent.click(rows[2], { ctrlKey: true })
    fireEvent.keyDown(rows[1], { key: 'Delete' })
    expect(discarded).toEqual([['a.ts', 'b.ts']])
    expect(unstagedCalls).toEqual([['c.ts']])
  })

  it('never discards a path it is also unstaging', () => {
    // A path staged AND further modified is selected on both sides: unstaging it
    // hands the edits back, so discarding it too would destroy what it returned.
    const { rows, discarded, unstagedCalls } = mountWith([addedThenEdited('package.json')])
    fireEvent.click(rows[0])
    fireEvent.click(rows[1], { ctrlKey: true })
    fireEvent.keyDown(rows[0], { key: 'Delete' })
    expect(unstagedCalls).toEqual([['package.json']])
    expect(discarded).toEqual([])
  })

  it('renders no per-row buttons at all', () => {
    const { rows } = mountWith([unstaged('a.ts'), staged('b.ts')])
    expect(rows.every(row => row.querySelector('button') === null)).toBe(true)
  })
})

describe('opening a row', () => {
  it('asks for the diff as soon as the pointer or the focus lands on it', () => {
    // The row under the pointer is the row about to be clicked, so the panel
    // reports it and the view prefetches: the preview then opens with the patch
    // already in memory instead of after a host round trip.
    const peeked: { path: string; staged: boolean }[] = []
    const { container } = render(
      <ChangesPanel
        status={statusOf([unstaged('a.ts'), staged('b.ts')])}
        selected={null}
        busy={false}
        onSelect={() => {}}
        onPeek={(next) => { peeked.push(next) }}
        onStage={() => {}}
        onUnstage={() => {}}
        onDiscard={() => {}}
        onCommit={() => {}}
        t={t}
      />,
    )
    const rows = [...container.querySelectorAll<HTMLElement>('[data-gitgraph-file]')]
    if (rows.length < 2) throw new Error('expected both groups to list a row')
    fireEvent.pointerEnter(rows[0]!)
    fireEvent.focus(rows[1]!)
    expect(peeked).toEqual([
      { path: 'a.ts', staged: false },
      { path: 'b.ts', staged: true },
    ])
  })
})

describe('the row each list draws', () => {
  it('is the History list\'s row: badge, path, then that side\'s +N −M counts', () => {
    // The two lists render their rows from one component, so the anatomy is the
    // contract: a badge, the split path, and the counts of the side the row lists.
    const { rows } = mountWith([
      { ...unstaged('src/client/a.ts'), worktreeStat: { additions: 4, deletions: 2 } },
    ])
    const row = rows[0]
    if (row === undefined) throw new Error('no row')
    expect([...row.children].map(element => (
      element.hasAttribute('data-gitgraph-badge') ? 'badge'
        : element.hasAttribute('data-gitgraph-file-stat') ? 'stat' : 'path'))).toEqual(['badge', 'path', 'stat'])
    expect(row.querySelector('[data-gitgraph-file-stat]')?.textContent).toBe('+4−2')
    // The path still splits so a shortened row keeps the file NAME.
    expect(row.querySelector('[data-gitgraph-file-name]')?.textContent).toBe('a.ts')
    expect(row.children[1]?.textContent).toBe('src/client/a.ts')
  })

  it('shows each side of a both-sides path its own counts', () => {
    // 'AM': added to the index and edited again. One record, two rows, and the
    // numbers belong to the side each row lists.
    const file = {
      ...addedThenEdited('package.json'),
      worktreeStat: { additions: 2, deletions: 1 },
      indexStat: { additions: 7, deletions: 0 },
    }
    const bySide = Object.fromEntries(
      [...mountWith([file]).rows].map(row => [
        row.getAttribute('data-gitgraph-file-staged') ?? '',
        row.querySelector('[data-gitgraph-file-stat]')?.textContent ?? '',
      ]),
    )
    expect(bySide).toEqual({ false: '+2−1', true: '+7−0' })
  })

  it('shows no counts cell when git reported none for the path', () => {
    // An untracked file is in no diff and a conflict's numstat is a combined one,
    // so neither row invents a `+0 −0`.
    const { rows } = mountWith([untracked('new.txt'), conflicted('angry.ts')])
    expect(rows.length).toBe(2)
    expect(rows.every(row => row.querySelector('[data-gitgraph-file-stat]') === null)).toBe(true)
  })
})

describe('splitPath', () => {
  it('splits a path at its last slash, so the directory can absorb the clipping', () => {
    expect(splitPath('a/b/c.ts')).toEqual({ directory: 'a/b/', name: 'c.ts' })
    expect(splitPath('packages/x/src/client/git/GitView.tsx'))
      .toEqual({ directory: 'packages/x/src/client/git/', name: 'GitView.tsx' })
  })

  it('treats a bare name as all name', () => {
    expect(splitPath('c.ts')).toEqual({ directory: '', name: 'c.ts' })
    expect(splitPath('')).toEqual({ directory: '', name: '' })
  })
})

describe('the change groups', () => {
  it('are exactly the two sides of the index boundary, for any worktree state', () => {
    expect(rail([]).map(group => group.key)).toEqual(['unstaged', 'staged'])
    expect(rail([staged('a.ts')]).map(group => group.key)).toEqual(['unstaged', 'staged'])
    expect(rail([untracked('n.txt')]).map(group => group.key)).toEqual(['unstaged', 'staged'])
    expect(rail([unstaged('b.ts'), conflicted('c.ts')]).map(group => group.key))
      .toEqual(['unstaged', 'staged'])
  })

  it('put everything the index does not hold in the pending group', () => {
    // Untracked files, worktree modifications and unresolved conflicts are three
    // kinds of the same thing here — held in one place, told apart by the badge.
    const files = [untracked('new.txt'), unstaged('edited.ts'), conflicted('angry.ts')]
    const pending = rail(files)[0]
    expect(pending.key).toBe('unstaged')
    expect(pending.rows.map(row => row.path)).toEqual(['new.txt', 'edited.ts', 'angry.ts'])
    expect(pending.rows.map(row => row.badge)).toEqual(['?', 'M', 'U'])
  })

  it('list a path whose two sides both moved in BOTH of its groups', () => {
    // `git status` reports 'AM': added to the index, then edited again. Testing
    // the index side alone dropped the row from the pending group, so the
    // worktree change was listed nowhere and could not be staged or discarded.
    const files = [addedThenEdited('package.json'), staged('a.ts')]
    expect(groupsOf(files, 'package.json')).toEqual(['unstaged', 'staged'])
    expect(groupsOf(files, 'a.ts')).toEqual(['staged'])
  })

  it('badge each row with the side it actually lists', () => {
    const change = addedThenEdited('package.json')
    expect(sideKindOf(change, true)).toBe('added')
    expect(sideKindOf(change, false)).toBe('modified')
    expect(badgeOf(change, true)).toBe('A')
    expect(badgeOf(change, false)).toBe('M')
    // A one-sided change is unaffected: both helpers agree with the coarse kind.
    expect(badgeOf(staged('a.ts'), true)).toBe('M')
    expect(badgeOf(unstaged('b.ts'), false)).toBe('M')
    expect(badgeOf(untracked('n.txt'), false)).toBe('?')
    expect(badgeOf(conflicted('c.ts'), false)).toBe('U')
    // ...and the rows on screen carry those letters.
    const byGroup = Object.fromEntries(rail([change]).map(group => [group.key, group.rows[0]?.badge]))
    expect(byGroup.staged).toBe('A')
    expect(byGroup.unstaged).toBe('M')
  })

  it('name what an empty group is missing instead of inviting a drop', () => {
    const byKey = Object.fromEntries(rail([staged('a.ts')]).map(group => [group.key, group.text]))
    // The staged group holds its row, and the empty pending group names what it
    // lacks — never the drop cue, which would invite a drag that cannot happen.
    expect(byKey.staged).toContain('a.ts')
    expect(byKey.unstaged).toContain('git.section.unstaged.empty')
  })

  it('offer no bulk verb over an empty group', () => {
    const byKey = Object.fromEntries(rail([staged('a.ts')]).map(group => [group.key, group.text]))
    expect(byKey.staged).toContain('git.unstageAll')
    expect(byKey.unstaged).not.toContain('git.stageAll')
  })

  it('leave a conflict out of the bulk verb it has no business in', () => {
    // `git add` on an unresolved path stages the conflict markers as the
    // resolution, so "stage all" must not sweep one up.
    const conflictedOnly = rail([conflicted('angry.ts')])[0]
    expect(conflictedOnly.text).not.toContain('git.stageAll')
    const mixed = rail([conflicted('angry.ts'), untracked('new.txt')])[0]
    expect(mixed.text).toContain('git.stageAll')
  })
})
