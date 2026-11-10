/**
 * The History panel's commit list (left column): the commit graph and its rows,
 * virtualized, with paging. The commit detail is rendered by the shared detail
 * pane, so this component owns only the list and the "load more" affordance.
 *
 * A row is exactly {@link COMMIT_ROW_HEIGHT} tall and the list windows itself with
 * {@link useVirtualWindow} — a repository with a hundred thousand commits is a
 * normal thing to open, and one DOM row each is what makes such a history slow to
 * paint and slow to update. Only the rows around the viewport (plus the hook's
 * overscan) are mounted; two spacers stand in for the rest so the scrollbar still
 * measures the whole history.
 *
 * The graph to the left of the text is one small SVG per row, drawn from the lane
 * layout (see history-graph and HistoryGraph.tsx) — the row is the unit that the
 * window mounts and unmounts, so the drawing lives and dies with it.
 * @module dsh-git-panel/client/git/HistoryPanel
 */

import { useMemo, type CSSProperties } from 'react'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import type { CommitRefKind, HistoryCommit, HistoryView } from '../../core/types.ts'
import type { GitPanelKey } from '../locales.ts'
import { formatRelativeTime } from './helpers.ts'
import { laneColor, layoutGraph } from './history-graph.ts'
import { HistoryGraph } from './HistoryGraph.tsx'
import { useVirtualWindow } from './virtual-window.ts'
import css from './git.module.css'

/**
 * The height of one commit row, in pixels.
 *
 * The list is virtualized with fixed rows, so a row's offset is `index × height`
 * rather than a measurement of the rows already on screen. This number therefore
 * has to be the row's height in CSS too (`.commitRow` in git.module.css, where the
 * height is commented with this constant's name) AND the height of the graph SVG:
 * a mismatch does not make the rows merely look off — the spacers stop adding up,
 * the scrollbar points at the wrong commit, and the graph's curves stop lining up
 * between rows. Exported so the panel's tests can scroll by exactly one row.
 */
export const COMMIT_ROW_HEIGHT = 46

/**
 * The chip class each ref kind wears.
 *
 * Read once at module load, like the panel's other class maps: the CSS module map
 * is static, and a lookup keeps the render below free of a switch.
 *
 * COLOUR is not part of this map: every chip on a row is painted with that row's
 * branch colour (the same one its graph line and node use — see `--ref-color`
 * below and the palette in history-graph.ts). A branch's name and its line have to
 * read as one thing, and the line colour is what identifies the branch from row to
 * row, so the chip follows the line rather than a fixed per-kind colour. The four
 * kinds stay distinguishable by MATERIAL and SHAPE, which a colour cannot be
 * relied on for anyway: head is the one solid chip, branch is a tinted pill,
 * remote is a tinted pill with a dashed border, tag is a square-cornered slip.
 */
const REF_BADGE_CLASS: Record<CommitRefKind, string> = {
  head: css.refBadgeHead ?? '',
  branch: css.refBadgeBranch ?? '',
  remote: css.refBadgeRemote ?? '',
  tag: css.refBadgeTag ?? '',
}

/**
 * The copy key naming each ref kind, used as the badge's tooltip lead.
 *
 * The tooltip is what makes the chips honest without widening the row: `origin/
 * main` reads as data, and "Remote branch: origin/main" says what the chip IS.
 */
const REF_BADGE_KIND_KEY: Record<CommitRefKind, GitPanelKey> = {
  head: 'git.history.refHead',
  branch: 'git.history.refBranch',
  remote: 'git.history.refRemote',
  tag: 'git.history.refTag',
}

/**
 * The empty list, shared rather than allocated per render.
 *
 * A fresh `[]` on every render of a null view would give the layout memo a new
 * dependency each time and re-run it for nothing.
 */
const NO_COMMITS: readonly HistoryCommit[] = []

/** Props of the History list. */
export interface HistoryPanelProps {
  view: HistoryView | null
  loading: boolean
  selectedOid: string | null
  onSelect: (oid: string) => void
  onLoadMore: () => void
  t: Translate<GitPanelKey>
}

/**
 * The History list.
 * @param props - see {@link HistoryPanelProps}.
 */
export function HistoryPanel(props: HistoryPanelProps) {
  const { view, loading, selectedOid, onSelect, onLoadMore, t } = props
  const commits = view === null ? NO_COMMITS : view.commits

  /**
   * The lane geometry of the WHOLE loaded list, recomputed when a page is
   * appended. The layout is top-down, so appending older commits only extends the
   * tail — the rows already drawn never move — which is what lets the virtual
   * window and the graph agree on a row's index without extra bookkeeping.
   */
  const layout = useMemo(() => layoutGraph(commits), [commits])

  /**
   * The slice of rows on screen. The reset key is the repository root: switching
   * repositories is a different history, and an offset carried over from the
   * previous one would land the reader in the middle of commits they have never
   * seen.
   */
  const virtual = useVirtualWindow({
    count: commits.length,
    rowHeight: COMMIT_ROW_HEIGHT,
    resetKey: view === null ? null : view.root,
  })
  const visible = useMemo(
    () => commits.slice(virtual.start, virtual.end),
    [commits, virtual.start, virtual.end],
  )

  return (
    <div className={css.listPane} data-gitgraph-part="history">
      <div className={css.scroll} ref={virtual.containerRef} data-gitgraph-history-scroll>
        {commits.length === 0 && (
          <div className={css.empty}>{view === null && loading ? t('git.loading') : t('git.history.empty')}</div>
        )}
        {/* The spacers stand in for the rows outside the viewport, so the scrolled
            content is as tall as the whole history while only the window around it
            is mounted. aria-hidden because they carry no content of their own. */}
        {commits.length > 0 && (
          <div aria-hidden="true" data-gitgraph-history-spacer="top" style={{ height: virtual.paddingTop }} />
        )}
        {visible.map((commit, offset) => {
          const index = virtual.start + offset
          const row = layout.rows[index]
          const active = selectedOid === commit.oid
          // `pushed === false` is the only value the host sends that means "no
          // remote has this commit yet"; undefined is an older host that did not
          // answer, and drawing it as pushed is the honest default.
          const unpushed = commit.pushed === false
          // The chip colour is the ROW's branch colour — the same value the graph
          // paints this row's line and node with — so a branch's name and its line
          // read as one thing. The eight-entry palette is the graph's, not the
          // theme's (see history-graph.ts); a row the layout has not described yet
          // falls back to the first entry, which only happens for a list that is
          // already empty.
          const refColor = laneColor(row?.color ?? 0)
          return (
            <button
              key={commit.oid}
              type="button"
              className={`${css.commitRow ?? ''} ${active ? css.commitRowActive ?? '' : ''}`.trim()}
              data-gitgraph-commit-oid={commit.oid}
              // The hollow node already says it visually; the tooltip is what
              // spells the hollow shape out for a reader who has not met it.
              title={unpushed ? t('git.history.unpushed') : undefined}
              onClick={() => { onSelect(commit.oid) }}
            >
              {row !== undefined && (
                <HistoryGraph
                  row={row}
                  lanes={layout.lanes}
                  height={COMMIT_ROW_HEIGHT}
                  selected={active}
                  pushed={!unpushed}
                />
              )}
              <span className={css.commitMain}>
                <span className={css.commitSubject} title={commit.subject}>{commit.subject}</span>
                <span className={css.commitMeta}>
                  {commit.refs.map(ref => (
                    <span
                      key={`${ref.kind}:${ref.name}`}
                      className={`${css.refBadge ?? ''} ${REF_BADGE_CLASS[ref.kind]}`.trim()}
                      // The chip's colour is handed to CSS as one custom property,
                      // so a single palette entry drives the text, the tint and the
                      // dashed border of every kind.
                      style={{ '--ref-color': refColor } as CSSProperties}
                      data-gitgraph-ref-kind={ref.kind}
                      data-gitgraph-ref-name={ref.name}
                      data-gitgraph-ref-color={refColor}
                      title={`${t(REF_BADGE_KIND_KEY[ref.kind])}: ${ref.name}`}
                    >
                      {ref.name}
                    </span>
                  ))}
                  <span>{commit.author}</span>
                  <span>·</span>
                  <span>{formatRelativeTime(commit.authorTime, t)}</span>
                </span>
              </span>
            </button>
          )
        })}
        {commits.length > 0 && (
          <div aria-hidden="true" data-gitgraph-history-spacer="bottom" style={{ height: virtual.paddingBottom }} />
        )}
      </div>
      {view !== null && view.hasMore && (
        <div className={css.commitBox}>
          <button
            type="button"
            className={css.button}
            disabled={loading}
            onClick={onLoadMore}
            data-gitgraph-history-more
          >
            {t('git.history.loadMore')}
          </button>
        </div>
      )}
    </div>
  )
}
