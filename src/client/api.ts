/**
 * Browser client for the host /gitpanel/* routes: typed JSON envelope calls plus
 * the SSE change subscription. Same-origin relative fetch (the page and the
 * routes share the webserver).
 * @module dsh-git-panel/client/api
 */

import { subscribeSharedEvents } from './sse-leader.ts'
import type {
  BranchesView, CommitDetail, CommitDiff, DiffView, GitError, HistoryView, RemoteView, StatusFilesView,
} from '../core/types.ts'

/** One /gitpanel envelope response. */
export type ApiResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: GitError }

/** Transport failure (fetch threw or the response was not JSON). */
const TRANSPORT_ERROR: GitError = { code: 'internal', message: 'git route unavailable' }

/** POST one JSON payload and decode the envelope; never throws. */
async function post<T>(path: string, payload: Record<string, unknown>): Promise<ApiResult<T>> {
  let response: Response
  try {
    response = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
  } catch {
    return { ok: false, error: TRANSPORT_ERROR }
  }
  try {
    const envelope = await response.json() as unknown
    if (typeof envelope !== 'object' || envelope === null) return { ok: false, error: TRANSPORT_ERROR }
    const record = envelope as Record<string, unknown>
    if (record.ok === true) return { ok: true, value: record.value as T }
    return { ok: false, error: (record.error as GitError | undefined) ?? TRANSPORT_ERROR }
  } catch {
    return { ok: false, error: TRANSPORT_ERROR }
  }
}

/** Typed git operations over the wire. */
export class GitApi {
  /** The file-level change list plus branch and sync state (the Changes panel). */
  statusFiles(path: string): Promise<ApiResult<StatusFilesView | null>> {
    return post('/gitpanel/status-files', { path })
  }

  /** Local branches with the current one marked (the branch menu). */
  branches(path: string): Promise<ApiResult<BranchesView | null>> {
    return post('/gitpanel/branches', { path })
  }

  /** Workspace-level `git switch --no-guess <branch>`. */
  switchBranch(path: string, branch: string): Promise<ApiResult<{ branch: string }>> {
    return post('/gitpanel/switch', { path, branch })
  }

  /** One path's unified diff; `staged` selects the index-versus-HEAD side. */
  diff(path: string, file: string, staged: boolean): Promise<ApiResult<DiffView | null>> {
    return post('/gitpanel/diff', { path, file, staged })
  }

  /** Stage the given repo-relative paths. */
  stage(path: string, paths: readonly string[]): Promise<ApiResult<{ summary: string }>> {
    return post('/gitpanel/stage', { path, paths })
  }

  /** Unstage the given repo-relative paths (worktree untouched). */
  unstage(path: string, paths: readonly string[]): Promise<ApiResult<{ summary: string }>> {
    return post('/gitpanel/unstage', { path, paths })
  }

  /** Discard the given paths back to HEAD (destructive; the host buckets untracked paths itself). */
  discard(path: string, paths: readonly string[]): Promise<ApiResult<{ summary: string }>> {
    return post('/gitpanel/discard', { path, paths })
  }

  /**
   * Apply one line selection: a patch fragment covering only the chosen rows of one
   * file, staged, unstaged or discarded.
   */
  applySelection(
    path: string,
    file: string,
    direction: 'stage' | 'unstage' | 'discard',
    fragment: string,
  ): Promise<ApiResult<{ summary: string }>> {
    return post('/gitpanel/apply-selection', { path, file, direction, fragment })
  }

  /** Commit the staged changes. */
  commit(path: string, message: string, amend = false): Promise<ApiResult<{ oid: string; subject: string }>> {
    return post('/gitpanel/commit', { path, message, amend })
  }

  /** A page of the current branch's history. */
  history(path: string, limit?: number, skip?: number): Promise<ApiResult<HistoryView | null>> {
    const payload: Record<string, unknown> = { path }
    if (limit !== undefined) payload.limit = limit
    if (skip !== undefined) payload.skip = skip
    return post('/gitpanel/history', payload)
  }

  /** One commit's metadata, file statistics, and patch. */
  commitDetail(path: string, oid: string): Promise<ApiResult<CommitDetail | null>> {
    return post('/gitpanel/commit-detail', { path, oid })
  }

  /** One file's patch out of a commit. */
  commitDiff(path: string, oid: string, file: string): Promise<ApiResult<CommitDiff | null>> {
    return post('/gitpanel/commit-diff', { path, oid, file })
  }

  /** Branch, upstream, ahead/behind, and configured remotes. */
  remote(path: string): Promise<ApiResult<RemoteView | null>> {
    return post('/gitpanel/remote', { path })
  }

  /** `git fetch --prune`. */
  fetch(path: string): Promise<ApiResult<{ summary: string }>> {
    return post('/gitpanel/fetch', { path })
  }

  /** `git pull --no-edit`. */
  pull(path: string): Promise<ApiResult<{ summary: string }>> {
    return post('/gitpanel/pull', { path })
  }

  /** `git push` (setting the upstream on a first push). */
  push(path: string): Promise<ApiResult<{ summary: string }>> {
    return post('/gitpanel/push', { path })
  }

  /** Merge a local branch into the current one. */
  merge(path: string, branch: string): Promise<ApiResult<{ summary: string }>> {
    return post('/gitpanel/merge', { path, branch })
  }

  /** Rebase the current branch onto a local branch. */
  rebase(path: string, branch: string): Promise<ApiResult<{ summary: string }>> {
    return post('/gitpanel/rebase', { path, branch })
  }

  /** Abort the merge or rebase currently in progress. */
  abortOperation(path: string): Promise<ApiResult<{ summary: string }>> {
    return post('/gitpanel/abort', { path })
  }
}

/**
 * Subscribe to host-pushed workspace changes for one workspace path (the host
 * polls while a subscriber is connected). The EventSource handles reconnects;
 * the caller re-subscribes when the path changes.
 * @param path - workspace root to watch.
 * @param onChange - fired on every pushed change.
 * @returns the disposer closing the stream.
 */
export function subscribeChanges(path: string, onChange: () => void): () => void {
  // The stream is shared browser-wide through the cross-tab leader relay: two
  // tabs of the same workspace must not pin two SSE connections against the
  // per-origin HTTP pool.
  return subscribeSharedEvents(
    `/gitpanel/events?path=${encodeURIComponent(path)}`,
    'change',
    () => { onChange() },
  )
}
