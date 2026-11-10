/**
 * One row's slice of the History list's commit graph, drawn as a small SVG.
 *
 * The layout (see history-graph) hands this component LANE coordinates: where the
 * row's node sits, and which lines cross the row's top edge, its bottom edge, and
 * its own node. Rendering is the only thing that needs pixels, so this module is
 * the single place that knows a lane's width and a row's height — the layout never
 * does, and can be tested on plain data.
 *
 * One SVG PER ROW, rather than one picture spanning the whole list, because the
 * list is virtualized: the mounted rows are a moving window, so a single canvas
 * would have to be redrawn (or scrolled by hand) as the reader scrolls, and would
 * have to be clipped exactly where the row is clipped. A row-sized SVG simply
 * travels with its row — it is created and dropped with the window, needs no
 * scroll listener, and its strokes line up with the row above and below because
 * every row is drawn from the same geometry.
 *
 * The dot marks the commit; the curves are branch structure. A merge or a fork
 * enters or leaves the row at a lane other than the node's, which is why the two
 * curve families exist: `incoming` arrives from the top edge, `outgoing` departs
 * through the bottom edge, and a lane that passes straight down is a line.
 * @module dsh-git-panel/client/git/HistoryGraph
 */

import type { GraphRow, GraphSegment } from './history-graph.ts'
import { laneColor } from './history-graph.ts'
import css from './git.module.css'

/**
 * The width of one graph lane, in pixels.
 *
 * The layout speaks in lane indices and never converts; the renderer is the only
 * side that knows how wide a lane is. 14px holds a 3.5px dot with more than 3px of
 * air on each side — roughly the density VSCode's own Source Control Graph uses —
 * so a history with several concurrent branches still leaves room for the text.
 */
export const LANE_WIDTH = 14

/** Radius of a commit's node dot, in pixels. */
const NODE_RADIUS = 3.5

/**
 * Radius of the ring around the SELECTED row's node.
 *
 * Drawn outside the dot rather than by making the dot bigger: the dot's size is
 * the pushed/unpushed signal, and selection must not be able to be mistaken for it.
 */
const SELECTED_RING_RADIUS = 6.5

/**
 * Props of one row's graph.
 */
export interface HistoryGraphProps {
  /** This row's geometry, from {@link layoutGraph}. */
  row: GraphRow
  /**
   * How many lanes the whole graph spans, from the same layout.
   *
   * The same number on every row: the graph column's width is fixed for the whole
   * list, so the commit text starts at one x position and rows cannot jitter
   * horizontally as their lanes change.
   */
  lanes: number
  /**
   * The height of one row, in pixels.
   *
   * The caller virtualizes with a fixed row height, so this is the same value as
   * `COMMIT_ROW_HEIGHT` in HistoryPanel.tsx and the row's CSS height: the SVG must
   * be exactly as tall as the row it is drawn in, or a curve would stop short of
   * the boundary and the line would visibly break between rows.
   */
  height: number
  /** Whether this commit is the selected one: its node gains an outer ring. */
  selected: boolean
  /**
   * Whether the commit is already on every remote.
   *
   * False draws a HOLLOW node — stroke only, filled with the panel's own surface —
   * so an unpushed commit reads as a ring next to the filled dots of pushed ones.
   * A host too old to report the flag passes `true`: absence of information is not
   * a claim that the commit is local.
   */
  pushed: boolean
}

/**
 * The lane palette and the wrapping lookup both live in history-graph.ts: the ref
 * chips beside each row use the SAME colours, so the palette belongs to the
 * layout's vocabulary rather than to this renderer. See {@link laneColor}.
 */

/**
 * The x coordinate of a lane's centre, in pixels.
 * @param lane - a lane index (0-based).
 */
function laneX(lane: number): number {
  return lane * LANE_WIDTH + LANE_WIDTH / 2
}

/**
 * The path of one segment that enters the row at `from` and ends at the node.
 *
 * The curve leaves the top edge vertically and reaches the node horizontally,
 * with BOTH control points on the row's vertical middle — the shape VSCode's graph
 * uses for a branch bending into a commit. Control points at the middle is what
 * makes the bend happen in the row the reader is looking at, so the line from the
 * row above flows into the node instead of crossing it diagonally.
 * @param segment - the incoming segment, in lane coordinates.
 * @param middle - the row's vertical middle, in pixels.
 */
function incomingPath(segment: GraphSegment, middle: number): string {
  const startX = laneX(segment.from)
  const endX = laneX(segment.to)
  const controlX = (startX + endX) / 2
  return `M ${startX} 0 C ${startX} ${middle}, ${controlX} ${middle}, ${endX} ${middle}`
}

/**
 * The path of one segment that starts at the node and leaves through the bottom
 * edge: the mirror of {@link incomingPath}, horizontal at the node and vertical at
 * the edge.
 * @param segment - the outgoing segment, in lane coordinates.
 * @param middle - the row's vertical middle, in pixels.
 * @param height - the row's height, in pixels.
 */
function outgoingPath(segment: GraphSegment, middle: number, height: number): string {
  const startX = laneX(segment.from)
  const endX = laneX(segment.to)
  const controlX = (startX + endX) / 2
  return `M ${startX} ${middle} C ${controlX} ${middle}, ${endX} ${middle}, ${endX} ${height}`
}

/**
 * One row's commit graph.
 * @param props - see {@link HistoryGraphProps}.
 */
export function HistoryGraph({ row, lanes, height, selected, pushed }: HistoryGraphProps) {
  // `lanes` is at least 1 by the layout's contract; the clamp keeps a malformed
  // one from producing a zero-width SVG that the row then has to lay out.
  const width = Math.max(lanes, 1) * LANE_WIDTH
  const middle = height / 2
  const nodeX = laneX(row.lane)
  const nodeColor = laneColor(row.color)

  return (
    <svg
      className={css.commitGraph}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      // Decorative: the commit's text next to it already names everything the
      // drawing shows, and a screen reader's job on this row is to read the row.
      aria-hidden="true"
      data-gitgraph-history-graph=""
      data-gitgraph-history-graph-lane={row.lane}
    >
      {/* Lanes running straight past this row: the other branches alongside it. */}
      {row.through.map((segment, index) => (
        <line
          key={`through-${index}`}
          x1={laneX(segment.from)}
          y1={0}
          x2={laneX(segment.to)}
          y2={height}
          stroke={laneColor(segment.color)}
          strokeWidth={1.5}
          strokeLinecap="round"
        />
      ))}
      {/* Lines arriving from the row above and ending at this commit. */}
      {row.incoming.map((segment, index) => (
        <path
          key={`incoming-${index}`}
          d={incomingPath(segment, middle)}
          fill="none"
          stroke={laneColor(segment.color)}
          strokeWidth={1.5}
          strokeLinecap="round"
        />
      ))}
      {/* Lines leaving this commit towards the row below. */}
      {row.outgoing.map((segment, index) => (
        <path
          key={`outgoing-${index}`}
          d={outgoingPath(segment, middle, height)}
          fill="none"
          stroke={laneColor(segment.color)}
          strokeWidth={1.5}
          strokeLinecap="round"
        />
      ))}
      {/* The selected row's ring goes UNDER the dot: it is an emphasis of the
          node, not another mark beside it. */}
      {selected && (
        <circle
          cx={nodeX}
          cy={middle}
          r={SELECTED_RING_RADIUS}
          fill="none"
          stroke={nodeColor}
          strokeWidth={1}
          opacity={0.75}
          data-gitgraph-history-selected-ring=""
        />
      )}
      <circle
        cx={nodeX}
        cy={middle}
        r={NODE_RADIUS}
        // Hollow for a commit no remote has yet: the surface shows THROUGH the
        // ring, which is the same visual grammar the panel uses for "draft" or
        // "not yet published" elsewhere. The filled dot is the default, so a host
        // that cannot answer `pushed` draws the ordinary graph rather than a
        // history that wrongly reads as unpushed.
        //
        // The hollow fill goes through `style`, not the `fill` attribute: SVG
        // presentation attributes do not accept var(), and the surface colour has
        // to follow the theme token rather than be baked into the bundle.
        fill={pushed ? nodeColor : undefined}
        style={pushed ? undefined : { fill: 'var(--dsw-alias-bg-base)' }}
        stroke={nodeColor}
        strokeWidth={pushed ? 0 : 1.5}
        data-gitgraph-history-node=""
        data-gitgraph-history-pushed={pushed ? 'true' : 'false'}
        data-gitgraph-history-node-lane={row.lane}
      />
    </svg>
  )
}
