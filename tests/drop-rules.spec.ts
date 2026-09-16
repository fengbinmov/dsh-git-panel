/**
 * Tests for the drag-and-drop staging rules.
 *
 * These encode the semantics rather than the mechanism: a drop moves paths across
 * the staged boundary only, and a payload already on the target's side yields no
 * plan at all. That is what stops a drop from firing a git command that would be
 * a no-op or a hard error — `git reset HEAD -- <path>` on a path with no index
 * entry FAILS rather than doing nothing.
 */
import { describe, expect, it } from 'vitest'
import {
  acceptsDrop, CHANGE_GROUP_ORDER, dropPaths, dropTargetOf, type DragPayload,
} from '../src/client/git/helpers.ts'

/** A drag carrying the given paths from each side. */
const payload = (staged: string[] = [], unstaged: string[] = []): DragPayload => ({ staged, unstaged })

describe('dropTargetOf', () => {
  it('maps each side of the index boundary onto its verb', () => {
    expect(dropTargetOf('staged')).toBe('staged')
    expect(dropTargetOf('unstaged')).toBe('unstaged')
  })
})

describe('dropPaths', () => {
  it('stages a pending payload dropped on the staged group', () => {
    expect(dropPaths(payload([], ['a.txt']), 'staged')).toEqual({ action: 'stage', paths: ['a.txt'] })
  })

  it('unstages a staged payload dropped on the pending group', () => {
    expect(dropPaths(payload(['a.txt']), 'unstaged')).toEqual({ action: 'unstage', paths: ['a.txt'] })
  })

  it('moves every path of a multi-row drag', () => {
    expect(dropPaths(payload([], ['a.txt', 'b.txt', 'c.txt']), 'staged')).toEqual({
      action: 'stage',
      paths: ['a.txt', 'b.txt', 'c.txt'],
    })
  })

  it('moves only the paths on the side the target acts on', () => {
    // A selection may span both groups. Dropping on the staged group must stage
    // the pending half and leave the already-staged half alone (and vice
    // versa) — not attempt the impossible direction for the other half.
    expect(dropPaths(payload(['s1.txt', 's2.txt'], ['u1.txt']), 'staged')).toEqual({
      action: 'stage',
      paths: ['u1.txt'],
    })
    expect(dropPaths(payload(['s1.txt'], ['u1.txt', 'u2.txt']), 'unstaged')).toEqual({
      action: 'unstage',
      paths: ['s1.txt'],
    })
  })

  it('yields no plan when the payload is already on the target side', () => {
    // Re-staging something staged, or "unstaging" something with no index
    // entry, are exactly the calls git would reject.
    expect(dropPaths(payload(['a.txt']), 'staged')).toBeNull()
    expect(dropPaths(payload([], ['a.txt']), 'unstaged')).toBeNull()
  })

  it('yields no plan for an empty payload', () => {
    for (const key of CHANGE_GROUP_ORDER) {
      expect(dropPaths(payload(), key)).toBeNull()
    }
  })
})

describe('acceptsDrop', () => {
  it('agrees with dropPaths on every combination', () => {
    const payloads = [payload(), payload(['s']), payload([], ['u']), payload(['s'], ['u'])]
    for (const candidate of payloads) {
      for (const key of CHANGE_GROUP_ORDER) {
        expect(acceptsDrop(candidate, key)).toBe(dropPaths(candidate, key) !== null)
      }
    }
  })

  it('accepts a crossing drag and refuses a same-side one', () => {
    expect(acceptsDrop(payload([], ['u']), 'staged')).toBe(true)
    expect(acceptsDrop(payload(['s']), 'unstaged')).toBe(true)
    expect(acceptsDrop(payload(['s']), 'staged')).toBe(false)
    expect(acceptsDrop(payload([], ['u']), 'unstaged')).toBe(false)
  })
})

describe('CHANGE_GROUP_ORDER', () => {
  it('is exactly the two sides of the index boundary', () => {
    expect([...CHANGE_GROUP_ORDER]).toEqual(['unstaged', 'staged'])
    expect(new Set(CHANGE_GROUP_ORDER).size).toBe(CHANGE_GROUP_ORDER.length)
  })

  it('keeps the staged group below the pending one, so dragging DOWN stages', () => {
    // The whole point of the order: staging is a downward drag toward the commit
    // box, and unstaging is the reverse upward drag. If the staged group ever
    // moved above the pending group, that gesture would silently invert.
    expect(CHANGE_GROUP_ORDER.indexOf('unstaged')).toBeLessThan(CHANGE_GROUP_ORDER.indexOf('staged'))
  })
})
