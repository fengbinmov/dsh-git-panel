/**
 * Tests for the pure lane layout behind the History graph.
 *
 * The layout is a contract with the renderer, not a picture: these cases pin the
 * coordinates — lane indexes, segment directions, palette order — for the shapes
 * the History list actually meets (a linear history, one merge, a fork, a
 * truncated page, malformed input). They run on plain data with no DOM, which is
 * the reason the layout was split out of the component: a rendering change must
 * not be able to quietly renumber a lane and shift every line below it.
 */
import { describe, expect, it } from 'vitest'
import {
  GRAPH_COLOR_COUNT, GRAPH_COLORS, laneColor, layoutGraph,
  type GraphCommit, type GraphLayout, type GraphSegment,
} from '../src/client/git/history-graph.ts'

/**
 * One commit written the way a history reads: `oid<-p1,p2`, or `oid<-` for a
 * commit with no parents. The helper keeps each fixture about the ancestry
 * instead of a wall of object literals, while the layout still receives the same
 * minimal shape the real commit list reduces to.
 */
function commit(spec: string): GraphCommit {
  const [oid = '', parents = ''] = spec.split('<-')
  return { oid, parents: parents === '' ? [] : parents.split(',') }
}

/** The layout of a history written as `oid<-parents` strings, newest first. */
function layoutOf(...specs: string[]): GraphLayout {
  return layoutGraph(specs.map(commit))
}

/** A row's segments as `from->to:color`, so an assertion reads as one value. */
function segmentsOf(segments: readonly GraphSegment[]): string[] {
  return segments.map(segment => `${segment.from}->${segment.to}:${segment.color}`)
}

describe('layoutGraph', () => {
  it('returns an empty layout for an empty list', () => {
    // The History panel renders before the first page arrives, so this is the
    // normal first call rather than an edge case: no rows, and a column wide
    // enough for one lane so the renderer is never asked for a zero-width graph.
    expect(layoutGraph([])).toEqual({ rows: [], lanes: 1 })
  })

  it('lays out a single root commit in lane 0 with no line down', () => {
    // A root has nothing to point at, which is the one row that legitimately has
    // no `outgoing` at all.
    const layout = layoutOf('R<-')
    expect(layout.lanes).toBe(1)
    expect(layout.rows).toEqual([{ lane: 0, color: 0, through: [], incoming: [], outgoing: [] }])
  })

  it('keeps a linear history in one lane with one line between rows', () => {
    const layout = layoutOf('C<-B', 'B<-A', 'A<-')
    expect(layout.lanes).toBe(1)
    // One branch, so one lane and one colour: the first-parent chain stays put
    // instead of stepping right on every row.
    expect(layout.rows.map(row => row.lane)).toEqual([0, 0, 0])
    expect(layout.rows.map(row => row.color)).toEqual([0, 0, 0])
    // Nothing runs beside this branch and nothing merges, so `through` is empty
    // everywhere; the only segments are the node's own stub from the row above and
    // the line down to its parent.
    expect(layout.rows.map(row => segmentsOf(row.through))).toEqual([[], [], []])
    expect(layout.rows.map(row => segmentsOf(row.incoming)))
      .toEqual([[], ['0->0:0'], ['0->0:0']])
    expect(layout.rows.map(row => segmentsOf(row.outgoing)))
      .toEqual([['0->0:0'], ['0->0:0'], []])
  })

  it('draws a merge as two lines down and one convergence at the fork point', () => {
    // M merges A and B; both lead back to R.
    const layout = layoutOf('M<-A,B', 'A<-R', 'B<-R', 'R<-')
    expect(layout.lanes).toBe(2)
    // The merge keeps its first parent (A) in its own lane and opens a second lane
    // for B, so the first-parent chain never leaves lane 0.
    expect(layout.rows[0]).toMatchObject({ lane: 0, color: 0 })
    expect(segmentsOf(layout.rows[0].outgoing)).toEqual(['0->0:0', '0->1:1'])
    expect(layout.rows[1]).toMatchObject({ lane: 0, color: 0 })
    expect(layout.rows[2]).toMatchObject({ lane: 1, color: 1 })
    // B's row is passed by A's line, which is still waiting for R in lane 0.
    expect(segmentsOf(layout.rows[2].through)).toEqual(['0->0:0'])
    // Both lines reach R, so R's row shows the two lanes converging into the node,
    // each in the colour it ran with.
    expect(layout.rows[3]).toMatchObject({ lane: 0 })
    expect(segmentsOf(layout.rows[3].incoming)).toEqual(['0->0:0', '1->0:1'])
    expect(layout.rows[3].outgoing).toEqual([])
  })

  it('gives the two children of one parent their own lanes', () => {
    const layout = layoutOf('A<-R', 'B<-R', 'R<-')
    expect(layout.lanes).toBe(2)
    expect(layout.rows[0]).toMatchObject({ lane: 0, color: 0 })
    expect(layout.rows[1]).toMatchObject({ lane: 1, color: 1 })
    // B is a branch tip, so nothing enters above it; A's line instead passes B's
    // row on its way down to R.
    expect(layout.rows[1].incoming).toEqual([])
    expect(segmentsOf(layout.rows[1].through)).toEqual(['0->0:0'])
    expect(segmentsOf(layout.rows[2].incoming)).toEqual(['0->0:0', '1->0:1'])
  })

  it('hands out palette entries in order and wraps at GRAPH_COLOR_COUNT', () => {
    // A commit with more parents than the palette has colours: every extra parent
    // opens a lane with the next entry, so the ninth lane wraps back to entry 0.
    const parents = ['P0', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8']
    const layout = layoutOf(`M<-${parents.join(',')}`, ...parents.map(oid => `${oid}<-`))
    expect(layout.lanes).toBe(parents.length)
    const expected = parents.map((_, index) => index === 0
      // The first parent continues the node's own line, so it keeps the node's
      // colour rather than consuming a palette entry of its own.
      ? '0->0:0'
      : `0->${index}:${index % GRAPH_COLOR_COUNT}`)
    expect(segmentsOf(layout.rows[0].outgoing)).toEqual(expected)
  })

  it('reuses the lowest freed lane for a branch that starts later', () => {
    // B (lane 0) and D (lane 1) are tips of their own lines; after B is drawn its
    // lane is free again even while C's line still waits in lane 1, and the third
    // tip (E) must take the lowest free lane instead of widening the graph.
    const layout = layoutOf('A<-B', 'C<-D', 'B<-', 'D<-', 'E<-')
    expect(layout.rows.map(row => row.lane)).toEqual([0, 1, 0, 1, 0])
    expect(layout.lanes).toBe(2)
    // The reopened lane carries a NEW line, not a continuation of A's, so it takes
    // the next palette entry instead of inheriting lane 0's old colour.
    expect(layout.rows[4]).toMatchObject({ lane: 0, color: 2 })
  })

  it('keeps a line waiting for a parent the page does not contain', () => {
    // `git log --max-count=n` cuts between a commit and its parent. The layout must
    // not throw or drop a row, and the waiting line is expected to run off the
    // bottom of the list until the next page is appended.
    const layout = layoutOf('A<-B', 'B<-C')
    expect(layout.rows).toHaveLength(2)
    expect(segmentsOf(layout.rows[1].outgoing)).toEqual(['0->0:0'])
    expect(layout.lanes).toBe(1)
  })

  it('runs a lane that never gets its commit to the end of the list', () => {
    // It is not the cut here that removes B — the list just stops after A. B's lane
    // therefore passes A's row and ends there: a line running off the bottom on a
    // lane of its own, which is why the graph column is two lanes wide.
    const layout = layoutOf('M<-A,B', 'A<-')
    expect(layout.rows).toHaveLength(2)
    expect(segmentsOf(layout.rows[1].through)).toEqual(['1->1:1'])
    expect(layout.lanes).toBe(2)
  })

  it('survives a repeated oid instead of throwing or looping', () => {
    // Git never emits the same oid twice, but a buggy page merge or a hand-built
    // list could. The second occurrence is laid out as its own node; what matters
    // is that nothing hangs and the rows stay parallel to the input.
    const layout = layoutOf('A<-B', 'A<-B', 'B<-')
    expect(layout.rows).toHaveLength(3)
    for (const row of layout.rows) {
      expect(Number.isInteger(row.lane)).toBe(true)
      expect(row.lane).toBeGreaterThanOrEqual(0)
    }
    expect(layout.lanes).toBeGreaterThanOrEqual(1)
  })

  it('keeps every segment inside the reported columns and pointing the right way', () => {
    // The renderer trusts these directions: a `through` must be straight, an
    // `incoming` must end in the row's lane and an `outgoing` must start there.
    // Check the whole contract over a history with a merge, a fork and a re-fork.
    const layout = layoutOf('A<-B,C', 'B<-D', 'C<-D', 'D<-E,F', 'E<-G', 'F<-G', 'G<-')
    expect(layout.lanes).toBe(2)
    for (const row of layout.rows) {
      expect(row.lane).toBeGreaterThanOrEqual(0)
      expect(row.lane).toBeLessThan(layout.lanes)
      expect(row.color).toBeGreaterThanOrEqual(0)
      expect(row.color).toBeLessThan(GRAPH_COLOR_COUNT)
      for (const segment of row.through) {
        expect(segment.from).toBe(segment.to)
        expect(segment.from).toBeGreaterThanOrEqual(0)
        expect(segment.from).toBeLessThan(layout.lanes)
      }
      for (const segment of row.incoming) {
        expect(segment.to).toBe(row.lane)
        expect(segment.from).toBeGreaterThanOrEqual(0)
        expect(segment.from).toBeLessThan(layout.lanes)
      }
      for (const segment of row.outgoing) {
        expect(segment.from).toBe(row.lane)
        expect(segment.to).toBeGreaterThanOrEqual(0)
        expect(segment.to).toBeLessThan(layout.lanes)
      }
    }
    // The column width is the widest lane any row used plus one — the renderer
    // sizes the whole graph from this single number, so it has to be the maximum.
    const widest = Math.max(...layout.rows.map(row => row.lane))
    expect(layout.lanes).toBe(widest + 1)
  })
})

describe('laneColor', () => {
  it('maps a palette index onto the palette and wraps in every direction', () => {
    expect(laneColor(0)).toBe(GRAPH_COLORS[0])
    expect(laneColor(GRAPH_COLOR_COUNT - 1)).toBe(GRAPH_COLORS[GRAPH_COLOR_COUNT - 1])
    // The renderer and the ref chips both read colours through this function, so a
    // wrapped index must never fall outside the palette.
    expect(laneColor(GRAPH_COLOR_COUNT)).toBe(GRAPH_COLORS[0])
    expect(laneColor(GRAPH_COLOR_COUNT * 5 + 2)).toBe(GRAPH_COLORS[2])
    expect(laneColor(-1)).toBe(GRAPH_COLORS[GRAPH_COLOR_COUNT - 1])
    // Every entry is a real colour, not a placeholder.
    for (const color of GRAPH_COLORS) expect(color).toMatch(/^#[0-9a-f]{6}$/)
  })
})
