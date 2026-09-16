/**
 * Tests for the group splitter arithmetic.
 *
 * The model is SHARES: unitless weights that the browser turns into pixels,
 * because the list is a flex column whose groups carry `flex: <share> 1 0`. That
 * removes the whole class of bug this file used to guard against — there is no
 * height arithmetic left to get wrong, and the groups cannot leave a gap (all
 * the space is distributed) or overflow (nothing is sized in absolute pixels).
 *
 * What is still worth testing is the drag itself: it moves space between its two
 * neighbours and nowhere else, neither side can be dragged out of existence, and
 * nonsense input changes nothing.
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_GROUP_SHARE, DEFAULT_PANE_SPLIT, dragPaneSplit, dragShares, EMPTY_GROUP_SHARE,
  MIN_GROUP_SHARE_FRACTION, MIN_PANE_SHARE_FRACTION, paneSplitOf, shareOf, shareScale,
} from '../src/client/git/helpers.ts'

describe('paneSplitOf', () => {
  it('accepts a stored pair of positive weights', () => {
    expect(paneSplitOf({ list: 340, detail: 420 })).toEqual({ list: 340, detail: 420 })
  })

  it('falls back to the default for anything unusable', () => {
    // Storage is untrusted input: only two finite positive numbers describe a
    // layout, and a half-read pair would be worse than none.
    for (const value of [null, undefined, 42, 'nope', {}, { list: 1 }, { list: 1, detail: 0 },
      { list: -3, detail: 5 }, { list: Number.NaN, detail: 5 }, { list: 1, detail: Number.POSITIVE_INFINITY }]) {
      expect(paneSplitOf(value)).toEqual(DEFAULT_PANE_SPLIT)
    }
  })

  it('defaults to the ratio the panel shipped with', () => {
    const share = DEFAULT_PANE_SPLIT.list / (DEFAULT_PANE_SPLIT.list + DEFAULT_PANE_SPLIT.detail)
    expect(share).toBeCloseTo(0.46, 2)
  })
})

describe('dragPaneSplit', () => {
  it('moves width 1:1 with the pointer', () => {
    const next = dragPaneSplit({ list: 400, detail: 400 }, 800, 60)
    expect(next.list).toBeCloseTo(460, 6)
    expect(next.detail).toBeCloseTo(340, 6)
  })

  it('preserves the pair, so the row is never under- or over-filled', () => {
    for (const delta of [-500, -30, 0, 30, 500]) {
      const next = dragPaneSplit({ list: 300, detail: 500 }, 800, delta)
      expect(next.list + next.detail).toBeCloseTo(800, 6)
    }
  })

  it('keeps both columns above the minimum fraction', () => {
    const floor = 800 * MIN_PANE_SHARE_FRACTION
    expect(dragPaneSplit({ list: 300, detail: 500 }, 800, -10_000).list).toBeCloseTo(floor, 6)
    expect(dragPaneSplit({ list: 300, detail: 500 }, 800, 10_000).detail).toBeCloseTo(floor, 6)
  })

  it('leaves the pair alone when it cannot be laid out', () => {
    expect(dragPaneSplit({ list: 3, detail: 4 }, 0, 50)).toEqual({ list: 3, detail: 4 })
    expect(dragPaneSplit({ list: 3, detail: 4 }, 700, Number.NaN)).toEqual({ list: 3, detail: 4 })
  })
})

describe('shareOf', () => {
  it('uses the dragged split when the repository has one', () => {
    expect(shareOf('staged', 0, { staged: 7 })).toBe(7)
    expect(shareOf('staged', 12, { staged: 7 })).toBe(7)
  })

  it('falls back to an even share for a group with files', () => {
    expect(shareOf('staged', 3, {})).toBe(DEFAULT_GROUP_SHARE)
  })

  it('gives an empty group less, so blank space does not starve the files', () => {
    expect(shareOf('staged', 0, {})).toBe(EMPTY_GROUP_SHARE)
    expect(EMPTY_GROUP_SHARE).toBeLessThan(DEFAULT_GROUP_SHARE)
  })

  it('never lets the rendered defaults leave the list unfilled', () => {
    // A flex line whose grow factors sum to less than one leaves the leftover
    // space UNDISTRIBUTED — with both groups empty, the raw defaults would reopen
    // a void above the commit box.
    const raw = [EMPTY_GROUP_SHARE, EMPTY_GROUP_SHARE]
    const scaled = raw.map(weight => weight * shareScale(raw))
    expect(scaled.reduce((sum, weight) => sum + weight, 0)).toBeCloseTo(1, 9)
  })

  it('lets a dragged share beat the empty default', () => {
    // Otherwise a divider drag next to an empty group would be undone the moment
    // the group emptied.
    expect(shareOf('unstaged', 0, { unstaged: 2 })).toBe(2)
  })
})

describe('shareScale', () => {
  it('leaves a set that can already fill the line alone', () => {
    expect(shareScale([1, 1])).toBe(1)
    expect(shareScale([EMPTY_GROUP_SHARE, 1])).toBe(1)
    expect(shareScale([500, 300, 200])).toBe(1)
  })

  it('scales a small set up until it fills, preserving the split', () => {
    const raw = [0.15, 0.15]
    const scaled = raw.map(weight => weight * shareScale(raw))
    expect(scaled.reduce((sum, weight) => sum + weight, 0)).toBeCloseTo(1, 9)
    // Relative sizes are untouched, so nothing moves on screen.
    expect(scaled[0]).toBeCloseTo(scaled[1], 9)
  })

  it('has nothing to say about an empty set', () => {
    expect(shareScale([])).toBe(1)
    expect(shareScale([0, 0])).toBe(1)
  })
})

describe('dragShares', () => {
  it('converts the pointer delta into share units at the measured scale', () => {
    // A 340px pair carrying 2 shares: 1px is 1/170 of a share.
    const next = dragShares(1, 1, 340, 34)
    expect(next.upper).toBeCloseTo(1.2, 6)
    expect(next.lower).toBeCloseTo(0.8, 6)
  })

  it('preserves the pair total, so neighbours beyond it are never robbed', () => {
    for (const delta of [-500, -37, 0, 37, 500]) {
      const { upper, lower } = dragShares(3, 5, 240, delta)
      expect(upper + lower).toBeCloseTo(8, 6)
    }
  })

  it('never lets either side fall below the minimum fraction', () => {
    const floor = 8 * MIN_GROUP_SHARE_FRACTION
    expect(dragShares(3, 5, 240, -10_000).upper).toBeCloseTo(floor, 6)
    expect(dragShares(3, 5, 240, 10_000).lower).toBeCloseTo(floor, 6)
  })

  it('still trades within a very small pair', () => {
    // The floor is a fraction of the pair, so even a tiny pair has room to move.
    const next = dragShares(0.1, 0.1, 40, 10)
    expect(next.upper).toBeCloseTo(0.15, 6)
    expect(next.upper + next.lower).toBeCloseTo(0.2, 6)
  })

  it('leaves the pair alone when a minimum leaves no room to share', () => {
    // Guard for a misconfigured minimum: at 50% per side there is nothing to trade.
    expect(dragShares(1, 1, 340, 10, 0.5)).toEqual({ upper: 1, lower: 1 })
  })

  it('ignores nonsense input instead of emitting NaN or negative shares', () => {
    // Not laid out yet: no scale to convert with.
    expect(dragShares(1, 1, 0, 10)).toEqual({ upper: 1, lower: 1 })
    expect(dragShares(1, 1, 340, Number.NaN)).toEqual({ upper: 1, lower: 1 })
    // Nothing to trade.
    expect(dragShares(0, 0, 340, 10)).toEqual({ upper: 0, lower: 0 })
    expect(dragShares(Number.NaN, 1, 340, 10)).toEqual({ upper: Number.NaN, lower: 1 })
  })
})
