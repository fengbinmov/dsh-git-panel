/**
 * Lane layout of the History list's commit graph.
 *
 * Git history is a DAG, not a list: a merge commit has several parents, so a draw
 * cannot be a column of dots. This module turns the commits the list holds into the
 * geometry a renderer needs — which lane each commit's node sits in, and which line
 * segments cross each row — with no DOM and no React, so the layout can be tested on
 * plain data.
 *
 * The coordinates are LANES, not pixels: lane `n`'s centre is the renderer's
 * business (it multiplies by its lane width). Every segment names the lane it enters
 * the row on (`from`) and the lane it leaves the row on (`to`), which is what lets
 * one row's drawing line up with the row above and the row below without the
 * renderer knowing anything about the DAG.
 *
 * The layout is recomputed from the WHOLE loaded list whenever a page is appended.
 * That is O(n) and deliberate: lanes are assigned top-down, so appending older
 * commits can never change the rows already drawn — it only extends the tail.
 * @module dsh-git-panel/client/git/history-graph
 */

/** The minimum shape one commit has to expose for the layout. */
export interface GraphCommit {
  oid: string
  parents: readonly string[]
}

/**
 * One line segment crossing one row, in lane coordinates.
 *
 * `from` is the lane at the TOP edge of the row and `to` the lane at the BOTTOM
 * edge, so a straight continuation has `from === to`, and a segment that meets the
 * row's own node has one end in the node's lane and the other in a lane that enters
 * or leaves the row there.
 */
export interface GraphSegment {
  /** Lane index at the top edge of the row. */
  from: number
  /** Lane index at the bottom edge of the row. */
  to: number
  /** Palette index, stable along one branch's line. */
  color: number
}

/** One row's graph geometry. */
export interface GraphRow {
  /** Lane the commit's node is drawn in. */
  lane: number
  /** Palette index of the node (the lane's colour). */
  color: number
  /**
   * Lanes that pass the row without touching its node — the other branches running
   * beside this commit. Each has `from === to` (the same lane runs straight down),
   * so a renderer may draw them as plain vertical lines.
   */
  through: GraphSegment[]
  /** Lines that enter at the top edge and end at this row's node. */
  incoming: GraphSegment[]
  /** Lines that start at this row's node and leave through the bottom edge. */
  outgoing: GraphSegment[]
}

/** The whole list's layout. */
export interface GraphLayout {
  /** One entry per commit, in the order the commits were given. */
  rows: GraphRow[]
  /**
   * How many lanes the widest row spans; never less than 1.
   *
   * The renderer uses this as the width of the whole graph column, so the column is
   * the same width on every row and the commit text starts at one x position.
   */
  lanes: number
}

/**
 * How many palette entries the layout cycles through.
 *
 * A colour INDEX, not a colour: {@link GRAPH_COLORS} maps it to one. Eight is
 * enough that two branches drawn next to each other never share a colour before
 * one of them ends.
 */
export const GRAPH_COLOR_COUNT = 8

/**
 * The lane palette: eight fixed hues, a DATA colour rather than theme chrome.
 *
 * A lane's colour is part of what the graph SAYS — it ties the segments of one
 * branch together from row to row, and keeps two branches running side by side
 * from reading as one line. That makes it the opposite of the panel's tokens: it
 * must NOT change between light and dark, or a branch would silently change
 * colour when the reader switches theme. The eight tones are picked from the One
 * Dark/Light band — saturated enough to separate from a near-white background,
 * light enough to read on a near-black one — and spaced around the hue wheel so
 * adjacent lanes are never close.
 *
 * The ref chips beside the row use the SAME colour (see HistoryPanel): a branch's
 * name and its line must read as one thing, so the palette lives here, next to the
 * colour index the layout hands out, rather than in the renderer.
 */
export const GRAPH_COLORS: readonly string[] = [
  '#4d8fd6', // blue — the trunk in most histories
  '#d05a5a', // red
  '#4f9d5d', // green
  '#c1843f', // amber
  '#9a5fc0', // purple
  '#3a9ca6', // teal
  '#b3a03c', // olive
  '#c25f9c', // magenta
]

/**
 * The colour one palette index stands for.
 *
 * Wraps any integer into the palette, so a renderer never has to guard an index
 * that arrived from another module.
 * @param index - a colour index from the layout.
 * @returns the hex colour.
 */
export function laneColor(index: number): string {
  const wrapped = ((index % GRAPH_COLOR_COUNT) + GRAPH_COLOR_COUNT) % GRAPH_COLOR_COUNT
  return GRAPH_COLORS[wrapped] ?? GRAPH_COLORS[0] ?? '#888888'
}

/**
 * One line running down a lane, still waiting for the commit it points at.
 *
 * A lane is only a column; the LINE is what carries the colour. Keeping the
 * waiting line as `{ oid, color }` is what lets a lane be freed and reopened by a
 * different branch without dragging the old colour along, and it is why the pass
 * never needs to look ahead: it only has to know which oid each lane is waiting
 * for, never which commit will eventually satisfy it.
 */
interface PendingLine {
  /** oid of the commit this line ends at. */
  oid: string
  /** Palette index reported by every row this line crosses. */
  color: number
}

/**
 * Lay out the commit graph of a whole load of commits.
 *
 * The output is parallel to `commits` (`rows[i]` describes `commits[i]`), so a
 * renderer can render a row's graph and its commit text in the same element.
 *
 * The walk is one top-down pass over the list: a lane holds the line waiting for
 * one specific commit, drawing a row consumes the lines waiting for its commit and
 * pushes new lines for its parents. The pass never looks ahead, so it is linear in
 * the number of commits and cannot loop, however odd the input is.
 *
 * Gaps are expected and handled: a parent that is not in the list (a page boundary,
 * a shallow clone, a grafted history) simply keeps waiting in its lane, which is
 * why the list's tail can show a line running off the bottom.
 *
 * Rows never change once pushed — a later row can only add lanes to the right of
 * what earlier rows used — which is what makes it safe to recompute the whole
 * layout from scratch whenever another page is appended.
 * @param commits - the loaded commits, newest first, in topological order.
 * @returns the geometry; `rows` is empty for an empty list.
 */
export function layoutGraph(commits: readonly GraphCommit[]): GraphLayout {
  const rows: GraphRow[] = []

  // `active[lane]` is the line running down that lane toward a commit further down
  // the list, or null when the lane is free. Freed lanes are left as holes instead
  // of being spliced out: a lane index is a coordinate, so renumbering would shift
  // every line below the hole and break the vertical continuity of the rows above.
  const active: (PendingLine | null)[] = []

  // Palette cursor for lines that START in the row being laid out. A line that
  // merely continues (the first-parent chain) inherits its colour instead of
  // consuming an entry, which is how one branch keeps one colour from its tip down
  // to its fork point.
  let paletteCursor = 0

  // Highest lane index any row has touched; the graph column has to be at least
  // this wide so the column width is the same on every row.
  let widest = -1

  // Commits whose node has already been drawn. It filters a parent that is (as
  // topological order forbids) already above the current row, and it makes a
  // repeated oid safe: the second occurrence is laid out as a separate node rather
  // than silently merging into the first one.
  const drawn = new Set<string>()

  /** Lowest free lane, opening a new lane when every existing one is busy. */
  const takeLane = (): number => {
    const free = active.indexOf(null)
    if (free !== -1) return free
    active.push(null)
    return active.length - 1
  }

  /** Next palette entry, wrapping around; the renderer modulo-maps it to a colour. */
  const takeColor = (): number => {
    const color = paletteCursor % GRAPH_COLOR_COUNT
    paletteCursor += 1
    return color
  }

  /** Widen the graph column if this lane sits further right than anything so far. */
  const noteLane = (lane: number): void => {
    if (lane > widest) widest = lane
  }

  for (const commit of commits) {
    // Every lane waiting for exactly this commit. Usually at most one; there are
    // several when more than one branch ran down to the same commit as its parent
    // without being able to share the lane — that is the merge convergence whose
    // diagonals the renderer draws from the far lanes into the node's lane.
    const waiting: number[] = []
    if (!drawn.has(commit.oid)) {
      for (let lane = 0; lane < active.length; lane += 1) {
        if (active[lane]?.oid === commit.oid) waiting.push(lane)
      }
    }

    // The node takes the leftmost waiting lane, so a run of merge nodes stays in
    // one lane instead of zig-zagging. A commit nothing was waiting for is a
    // branch tip (the newest commit, a second root, the top of a later page) and
    // opens a brand new line in the lowest free lane.
    const nodeLane = waiting.length > 0 ? waiting[0] : takeLane()
    const nodeLine = active[nodeLane]
    const nodeColor = nodeLine === null ? takeColor() : nodeLine.color
    noteLane(nodeLane)

    // Lines entering at the top edge and ending at this row's node. The node's own
    // lane is one of them: it is the vertical stub joining the row above to the
    // node, and the renderer cannot infer it, because a fresh branch tip has no
    // line above at all. Extra lanes here are the converging branches, each drawn
    // from its own lane into the node's lane in its own colour.
    const incoming: GraphSegment[] = []
    for (const lane of waiting) {
      if (lane === nodeLane) {
        incoming.push({ from: nodeLane, to: nodeLane, color: nodeColor })
        continue
      }
      const line = active[lane]
      if (line !== null) incoming.push({ from: lane, to: nodeLane, color: line.color })
    }

    // The node consumes every line that was waiting for it, so from this row's
    // bottom edge on those lanes are free for a branch that starts further down.
    for (const lane of waiting) active[lane] = null

    // Branches running beside this commit: lanes nothing consumed go straight
    // through, which is why a neighbouring line does not wobble as rows pass it.
    const through: GraphSegment[] = []
    for (let lane = 0; lane < active.length; lane += 1) {
      const line = active[lane]
      if (line === null) continue
      through.push({ from: lane, to: lane, color: line.color })
      noteLane(lane)
    }

    // One line per parent that still has to be drawn. `drawn` drops a parent already
    // laid out above (only a malformed list can produce one), `seenParents` drops a
    // parent repeated inside one commit (that is one line, not two), and a blank oid
    // is not a commit at all. A parent merely MISSING from the list is kept: its
    // line waits until the list ends, which is the line running off the bottom at a
    // page boundary, in a shallow clone or in a grafted history.
    const outgoing: GraphSegment[] = []
    const seenParents = new Set<string>()
    let continuesNodeLine = true
    drawn.add(commit.oid)

    for (const parent of commit.parents) {
      if (parent === '' || drawn.has(parent) || seenParents.has(parent)) continue
      seenParents.add(parent)

      let lane: number
      let color: number
      if (continuesNodeLine) {
        // First parent: stay in the node's lane, so a first-parent history is one
        // straight lane instead of a diagonal per row. The line belongs to this
        // child, and its colour comes with it — a branch keeps one colour.
        lane = nodeLane
        color = nodeColor
        continuesNodeLine = false
      } else {
        // Every further parent of a merge opens a NEW branch line in the lowest
        // free lane, taking the next palette entry.
        lane = takeLane()
        color = takeColor()
      }

      active[lane] = { oid: parent, color }
      noteLane(lane)
      outgoing.push({ from: nodeLane, to: lane, color })
    }

    rows.push({ lane: nodeLane, color: nodeColor, through, incoming, outgoing })
  }

  // Never zero: the renderer sizes its graph column from this, and even one root
  // commit needs the single lane it sits in.
  return { rows, lanes: Math.max(widest + 1, 1) }
}
