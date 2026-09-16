/**
 * The History panel's commit list (left column) with paging. The commit
 * detail is rendered by the shared detail pane, so this component owns only
 * the list and the "load more" affordance.
 * @module dsh-git-panel/client/git/HistoryPanel
 */

import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import type { HistoryView } from '../../core/types.ts'
import type { GitPanelKey } from '../locales.ts'
import { formatRelativeTime } from './helpers.ts'
import css from './git.module.css'

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
  if (view === null) {
    return (
      <div className={css.listPane} data-gitgraph-part="history">
        <div className={css.empty}>{loading ? t('git.loading') : t('git.history.empty')}</div>
      </div>
    )
  }
  return (
    <div className={css.listPane} data-gitgraph-part="history">
      <div className={css.scroll}>
        {view.commits.length === 0 && <div className={css.empty}>{t('git.history.empty')}</div>}
        {view.commits.map(commit => (
          <button
            key={commit.oid}
            type="button"
            className={`${css.commitRow ?? ''} ${selectedOid === commit.oid ? css.commitRowActive ?? '' : ''}`.trim()}
            data-gitgraph-commit-oid={commit.oid}
            onClick={() => { onSelect(commit.oid) }}
          >
            <span className={css.commitOid}>{commit.shortOid}</span>
            <span className={css.commitMain}>
              <span className={css.commitSubject} title={commit.subject}>{commit.subject}</span>
              <span className={css.commitMeta}>
                {commit.refs.map(ref => (
                  <span
                    key={ref}
                    className={`${css.refBadge ?? ''} ${ref === view.branch ? css.refBadgeCurrent ?? '' : ''}`.trim()}
                  >
                    {ref}
                  </span>
                ))}
                <span>{commit.author}</span>
                <span>·</span>
                <span>{formatRelativeTime(commit.authorTime, t)}</span>
              </span>
            </span>
          </button>
        ))}
      </div>
      {view.hasMore && (
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
