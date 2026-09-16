/**
 * Presentation-only helpers for the Git view tab: the badge a change row
 * shows and the relative timestamp a commit row renders. Pure functions, no
 * component state, so both the change list and the history list share them.
 * @module dsh-git-panel/client/git/helpers
 */

import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import type { FileChange, FileChangeKind, LineStat } from '../../core/types.ts'
import type { GitPanelKey } from '../locales.ts'
import css from './git.module.css'

/**
 * The kind of ONE side of a change.
 *
 * {@link FileChange.kind} is coarse and lets the staged side win, which is right
 * for the staged row and WRONG for the row that lists the worktree side: a file
 * staged as an addition and then edited again ('AM') is an addition in the index
 * and a modification in the worktree, and each row must badge the side it is
 * actually listing.
 * @param change - the parsed change row.
 * @param staged - true for the index side, false for the worktree side.
 * @returns the kind of that side.
 */
export function sideKindOf(change: FileChange, staged: boolean): FileChangeKind {
  const status = staged ? change.index : change.worktree
  switch (status) {
    case 'A': return 'added'
    case 'M': return 'modified'
    case 'D': return 'deleted'
    case 'R': return 'renamed'
    case 'C': return 'copied'
    case 'T': return 'typechange'
    case '?': return 'untracked'
    case 'U': return 'conflicted'
    // ' ' (this side did not move) or a code we do not model: the coarse kind is
    // the best answer available.
    default: return change.kind
  }
}

/**
 * The single-letter status badge for one change row. Porcelain reports two
 * status characters (index and worktree); the row shows one letter, for the side
 * the row belongs to, and the raw characters stay available as a tooltip.
 * @param change - the parsed change row.
 * @param staged - true for a row in the staged group, false for the other side.
 */
export function badgeOf(change: FileChange, staged: boolean): string {
  switch (sideKindOf(change, staged)) {
    case 'added': return 'A'
    case 'modified': return 'M'
    case 'deleted': return 'D'
    case 'renamed': return 'R'
    case 'copied': return 'C'
    case 'typechange': return 'T'
    case 'untracked': return '?'
    case 'conflicted': return 'U'
  }
}

/**
 * The line counts of ONE side of a change, as the host reported them.
 *
 * Same rule as {@link sideKindOf}: the row badges the side it lists, and it shows
 * that side's numbers — a path staged and then edited again has two rows standing
 * for two different changes.
 * @param change - the parsed change row.
 * @param staged - true for the index side, false for the worktree side.
 * @returns the pair, or undefined when git reported none for that side.
 */
export function sideStatOf(change: FileChange, staged: boolean): LineStat | undefined {
  return staged ? change.indexStat : change.worktreeStat
}

/** The badge's tone class, grouping related kinds onto one colour. */
export function badgeClassOf(change: FileChange, staged: boolean): string {
  switch (sideKindOf(change, staged)) {
    case 'added': return css.badgeAdded ?? ''
    case 'deleted': return css.badgeDeleted ?? ''
    case 'renamed':
    case 'copied': return css.badgeRenamed ?? ''
    case 'untracked': return css.badgeUntracked ?? ''
    case 'conflicted': return css.badgeConflicted ?? ''
    case 'modified':
    case 'typechange': return css.badgeModified ?? ''
  }
}

/**
 * Split a path into the part that may be shortened and the part that must stay
 * readable.
 *
 * A list that ellipsizes the whole path hides the FILE NAME — the useful end —
 * and keeps the directory prefix, because `text-overflow` cuts the tail. Rendering
 * the two halves separately lets the directory absorb the clipping (with its own
 * ellipsis at its start, right before the name) while the name is never shortened.
 * @param path - a repo-relative path, or any slash-separated label.
 * @returns the leading directory (with its trailing slash) and the final segment.
 */
export function splitPath(path: string): { directory: string; name: string } {
  const cut = path.lastIndexOf('/')
  if (cut < 0) return { directory: '', name: path }
  return { directory: path.slice(0, cut + 1), name: path.slice(cut + 1) }
}

/** Seconds per relative-time bucket. */
const MINUTE = 60
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/**
 * A compact relative timestamp, falling back to a plain date past 30 days.
 * Reuses the graph dictionary's time keys so the two surfaces never drift.
 * @param epochSeconds - commit author time in seconds.
 * @param t - the git-panel namespace translate seat.
 */
export function formatRelativeTime(epochSeconds: number, t: Translate<GitPanelKey>): string {
  if (epochSeconds <= 0) return ''
  const elapsed = Math.max(0, Math.floor(Date.now() / 1000) - epochSeconds)
  if (elapsed < MINUTE) return t('graph.time.justNow')
  if (elapsed < HOUR) return t('graph.time.minutesAgo', { count: Math.floor(elapsed / MINUTE) })
  if (elapsed < DAY) return t('graph.time.hoursAgo', { count: Math.floor(elapsed / HOUR) })
  if (elapsed < 30 * DAY) return t('graph.time.daysAgo', { count: Math.floor(elapsed / DAY) })
  const date = new Date(epochSeconds * 1000)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/* ------------------------------------------------------------------ *
 * Drag-and-drop staging rules
 * ------------------------------------------------------------------ */

/**
 * The two change groups: one side of the index boundary each.
 *
 * The panel is deliberately a two-region view. Everything that is NOT in the
 * index — untracked files, worktree modifications, unresolved conflicts — lives
 * in `unstaged`; everything the index holds lives in `staged`. Splitting the
 * pending side further (untracked / modified / conflicted) produced regions that
 * appeared and disappeared as work was staged, and that hid a file whose index
 * side and worktree side had BOTH moved. The row badge ('?', 'M', 'U', …) is
 * what tells the kinds apart.
 */
export type ChangeGroupKey = 'unstaged' | 'staged'

/**
 * Canonical group order, top to bottom — the single source of truth for both the
 * render order and where a drop lands.
 *
 * The pending group comes first and the staged group sits LAST, directly above
 * the commit box. Staging is then a DOWNWARD drag: the row travels toward the
 * commit box exactly as it becomes ready to commit, and unstaging is the reverse
 * upward drag.
 */
export const CHANGE_GROUP_ORDER: readonly ChangeGroupKey[] = ['unstaged', 'staged']

/**
 * The staging side a drop on this group means.
 *
 * The two groups straddle the index boundary, so the mapping is direct: a drop on
 * the staged group stages, a drop on the pending group unstages. (An earlier
 * version also had to answer for a conflict list that accepted no drop; conflicts
 * are now ordinary rows of the pending group, and they are undraggable rows
 * rather than an un-targetable region.)
 * @param key - the change group.
 * @returns the target the drop acts on.
 */
export function dropTargetOf(key: ChangeGroupKey): 'staged' | 'unstaged' {
  return key === 'staged' ? 'staged' : 'unstaged'
}

/**
 * What one row drag carries, grouped by the side each path is dragged from. A
 * multi-row drag can hold both sides at once (a selection may span the staged
 * and unstaged groups), which is why the direction of a drop is decided from
 * the payload rather than from a single "source side" flag.
 */
export interface DragPayload {
  /** Paths dragged out of the staged group. */
  readonly staged: readonly string[]
  /** Paths dragged out of the pending group. */
  readonly unstaged: readonly string[]
}

/**
 * The paths a drop on this group would move, and in which direction.
 *
 * Only the staged boundary is crossable, so a drop does something only when the
 * payload carries paths on the OTHER side:
 *   - onto the staged group, the pending paths are staged;
 *   - onto the pending group, the staged paths are unstaged.
 *
 * A payload already on the target's side yields null rather than an empty
 * batch, so the caller can refuse the drop (and the browser shows a "no drop"
 * cursor) instead of firing a git command that would be a no-op or an ERROR —
 * `git reset HEAD -- <path>` on a path with no index entry FAILS rather than
 * doing nothing.
 * @param payload - the dragged paths, grouped by source side.
 * @param key - the target change group.
 * @returns the action and its paths, or null when the drop means nothing.
 */
export function dropPaths(payload: DragPayload, key: ChangeGroupKey): { action: 'stage' | 'unstage'; paths: string[] } | null {
  const target = dropTargetOf(key)
  const paths = [...(target === 'staged' ? payload.unstaged : payload.staged)]
  if (paths.length === 0) return null
  return { action: target === 'staged' ? 'stage' : 'unstage', paths }
}

/**
 * Whether a drop on this group would move anything.
 * @param payload - the dragged paths, grouped by source side.
 * @param key - the target change group.
 */
export function acceptsDrop(payload: DragPayload, key: ChangeGroupKey): boolean {
  return dropPaths(payload, key) !== null
}

/* ------------------------------------------------------------------ *
 * Group splitter arithmetic
 * ------------------------------------------------------------------ */

/**
 * Group shares: unitless weights, so only the RATIOS matter. A missing key
 * means the default share.
 */
export type GroupShares = Partial<Record<ChangeGroupKey, number>>

/**
 * The share every group carries before the user has dragged anything. Equal
 * shares mean the groups split the list between them evenly.
 */
export const DEFAULT_GROUP_SHARE = 1

/**
 * The share an EMPTY group carries before the user has dragged anything.
 *
 * A group that is on screen but holds nothing is just a header with a note in
 * it, so it starts on a small share: the height files need belongs to the groups
 * that have files. It is only an initial value — the first divider drag re-seeds
 * every group from what is on screen, in pixels, and after that emptiness stops
 * mattering.
 */
export const EMPTY_GROUP_SHARE = 0.15

/**
 * The factor that keeps a set of shares able to fill its flex line.
 *
 * A flex line distributes spare space strictly by grow factor only while those
 * factors sum to at least one. Below that it gives each item its factor TIMES
 * the spare space and leaves the remainder UNDISTRIBUTED — with both groups empty
 * that reopened a 195px void above the commit box (measured in Chrome at 0.15 per
 * group). Shares are relative, so scaling the whole set leaves the split on
 * screen identical while removing the failure mode.
 * @param weights - the raw shares of the groups actually being rendered.
 * @returns the multiplier to apply to all of them; 1 when they already sum to 1+.
 */
export function shareScale(weights: readonly number[]): number {
  const total = weights.reduce((sum, weight) => sum + weight, 0)
  return total > 0 && total < 1 ? 1 / total : 1
}

/* ------------------------------------------------------------------ *
 * The changes view's horizontal split
 * ------------------------------------------------------------------ */

/**
 * The two columns of the Changes and History tabs, as weights: the file/commit
 * list on the left, the detail pane on the right. Same unitless-share model as
 * the vertical split — only the RATIO matters, and the browser turns it into
 * pixels — so neither pane can be sized wrongly by a bad pixel conversion.
 */
export interface PaneSplit {
  readonly list: number
  readonly detail: number
}

/**
 * The split before the user has dragged anything: the list takes a little less
 * than half, which is what the panel shipped with as a fixed `width: 46%`.
 */
export const DEFAULT_PANE_SPLIT: PaneSplit = { list: 0.85, detail: 1 }

/** The smallest fraction of the pair's width either column may be dragged to. */
export const MIN_PANE_SHARE_FRACTION = 0.2

/**
 * Read a remembered split out of storage. Storage is untrusted input (another
 * script may have written it, and it survives schema changes), so anything that
 * is not two finite positive numbers is rejected outright rather than clamped
 * into a lopsided layout.
 * @param value - the parsed JSON value, or null when there is nothing stored.
 * @returns the split, or the default when the stored value is unusable.
 */
export function paneSplitOf(value: unknown): PaneSplit {
  if (typeof value !== 'object' || value === null) return DEFAULT_PANE_SPLIT
  const record = value as Record<string, unknown>
  const list = record.list
  const detail = record.detail
  if (typeof list !== 'number' || !Number.isFinite(list) || list <= 0) return DEFAULT_PANE_SPLIT
  if (typeof detail !== 'number' || !Number.isFinite(detail) || detail <= 0) return DEFAULT_PANE_SPLIT
  return { list, detail }
}

/**
 * The split one divider drag produces. Shares are relative, so a drag moves width
 * between the two columns and changes nothing else; the pair's total is preserved,
 * which is what keeps the pane boundary from disturbing the rest of the row.
 * @param start - the split when the drag began, in whichever units it was seeded.
 * @param pairPx - the two columns' combined width on screen, used ONLY to convert
 *   the pointer's pixel movement into share units.
 * @param deltaPx - pointer movement in px; positive is to the right.
 * @returns the adjusted split.
 */
export function dragPaneSplit(start: PaneSplit, pairPx: number, deltaPx: number): PaneSplit {
  const next = dragShares(start.list, start.detail, pairPx, deltaPx, MIN_PANE_SHARE_FRACTION)
  return { list: next.upper, detail: next.lower }
}

/**
 * The share one group carries: the split the user dragged for this repository,
 * or — before they have dragged anything — the default for whether the group
 * holds files.
 * @param key - the group.
 * @param rows - how many rows the group is rendering.
 * @param shares - the remembered shares (a missing key means "no choice made").
 * @returns the group's flex weight in the list column.
 */
export function shareOf(key: ChangeGroupKey, rows: number, shares: GroupShares): number {
  const remembered = shares[key]
  if (remembered !== undefined) return remembered
  return rows === 0 ? EMPTY_GROUP_SHARE : DEFAULT_GROUP_SHARE
}

/**
 * The smallest fraction of the pair's space one side may be dragged to. It is a
 * fraction rather than a pixel count because shares are relative; the VISIBLE
 * floor is the rows area's `min-height` in git.module.css (keep the two roughly
 * in step).
 */
export const MIN_GROUP_SHARE_FRACTION = 0.2

/**
 * The shares one divider drag produces.
 *
 * Shares are unitless on purpose, and the list is a flex column whose groups
 * carry `flex: <share> 1 0`. The BROWSER therefore divides whatever height is
 * left after the dividers, and the groups always fill the list exactly. There is
 * no height arithmetic here to get wrong: a bad pixel-to-share conversion can
 * only make the drag feel more or less sensitive, never produce a gap (all the
 * space is distributed) or an overflow (nothing is sized in absolute pixels, so
 * a window resize just re-divides).
 *
 * The pair's combined share is preserved, so a drag moves space between its two
 * neighbours and nowhere else.
 * @param startUpper - the upper group's share at drag start.
 * @param startLower - the lower group's share at drag start.
 * @param pairPx - the two groups' combined height on screen (px), used ONLY to
 *   convert the pointer's pixel movement into share units.
 * @param deltaPx - pointer movement in px; positive is downward.
 * @param minFraction - the smallest share either side may be dragged to, as a
 *   fraction of the pair's combined share.
 * @returns the adjusted pair.
 */
export function dragShares(
  startUpper: number,
  startLower: number,
  pairPx: number,
  deltaPx: number,
  minFraction = MIN_GROUP_SHARE_FRACTION,
): { upper: number; lower: number } {
  const total = startUpper + startLower
  const perPixel = pairPx > 0 ? total / pairPx : 0
  const floor = total * minFraction
  // Nonsense input, a pair too small to share, or a not-yet-laid-out pair is
  // left exactly as it is rather than producing a negative or NaN share.
  if (!Number.isFinite(total) || !(total > floor * 2)) return { upper: startUpper, lower: startLower }
  if (!Number.isFinite(deltaPx) || !(perPixel > 0)) return { upper: startUpper, lower: startLower }
  const upper = Math.min(Math.max(startUpper + deltaPx * perPixel, floor), total - floor)
  return { upper, lower: total - upper }
}