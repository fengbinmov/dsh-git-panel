/**
 * /gitpanel/* route layer: a JSON envelope (ok/error with stable codes) for the
 * query and mutation operations, plus an SSE stream that tells the open Git
 * panel when the workspace changed underneath it.
 *
 * The service owns workspace gating and the git guards; this layer owns the HTTP
 * shape, the request validation, and the SSE subscriber bookkeeping. Routes are
 * loopback-only by default; a live paired-device cookie is an extra allow path
 * when remote-web-ui is loaded.
 *
 * The `/gitpanel` prefix is deliberately distinct from any other plugin's git
 * routes, so two git plugins installed side by side cannot fight over dispatch.
 * @module dsh-git-panel/host/routes
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import {
  isBranchesView, isCommitDetail, isDiffView, isGitError, isHistoryView, isRemoteView,
  isStatusFilesView,
  type GitError,
} from '../core/types.ts'
import { PollGuard } from './poll-guard.ts'
import { isGitPanelAllowed } from './access.ts'
import { readJsonBody, writeJson } from './http.ts'
import type { GitService } from './git-service.ts'

/** Envelope every /gitpanel JSON response carries. */
export type GitEnvelope<T> =
  | { ok: true; value: T }
  | { ok: false; error: GitError }

const OK = (value: unknown): GitEnvelope<unknown> => ({ ok: true, value })
const FAIL = (error: GitError): GitEnvelope<never> => ({ ok: false, error })

/** Git operation error for structurally invalid requests (never a workspace fault). */
const BAD_REQUEST: GitError = { code: 'internal', message: 'malformed request' }

/** Git operation error for a structurally invalid service view (never a workspace fault). */
const MALFORMED_VIEW: GitError = { code: 'internal', message: 'malformed git response' }

/** One SSE subscriber: a workspace path and its last pushed state key. */
interface Subscriber {
  path: string
  last: string
  /** Last successfully read file-level porcelain digest (kept across failed probes). */
  lastFileDigest?: string
  res: ServerResponse
  probeAbort?: AbortController
}

/**
 * Poll interval for external git-state changes while subscribers are connected.
 * Kept deliberately long (30s): each tick spawns several git processes per
 * subscriber, and on Windows a cold git.exe costs ~0.7s per spawn — a short
 * interval turns the poll itself into a self-exciting storm. Window focus and
 * the client's own post-mutation refresh cover the interactive freshness path.
 */
const POLL_INTERVAL_MS = 30_000
/** SSE keep-alive comment interval (proxies drop idle connections). */
const HEARTBEAT_INTERVAL_MS = 15_000

/**
 * Route-layer deadline for one status request. On expiry the controller aborts
 * the read path so the subprocess can terminate; the JSON handler keeps the
 * stable envelope and the SSE poll loop can clear its overlap guard.
 */
const STATUS_TIMEOUT_MS = 15_000
const STATUS_TIMEOUT_MESSAGE = 'git status timed out'

/**
 * PollGuard lifetime bound. The SSE loop must live exactly as long as the
 * subscriber set (start on first join, stop on empty), so there is no natural
 * server-side expiry: the deadline is set to a sentinel that never fires and the
 * loop is terminated by {@link PollGuard.stop} when the last subscriber closes.
 */
const POLL_LIFETIME_MS = Number.MAX_SAFE_INTEGER

/** Extract the required string field from a JSON object payload. */
function pathOf(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null
  const path = (payload as Record<string, unknown>).path
  return typeof path === 'string' && path !== '' ? path : null
}

/** The payload as a plain object; an absent or non-object payload reads as empty. */
function recordOf(payload: unknown): Record<string, unknown> {
  return typeof payload === 'object' && payload !== null ? payload as Record<string, unknown> : {}
}

/**
 * Extract a non-empty array of repo-relative paths.
 * @returns the list, or null when the field is absent or holds a non-string entry.
 */
function pathListOf(payload: unknown): string[] | null {
  const value = recordOf(payload).paths
  if (!Array.isArray(value)) return null
  if (!value.every(entry => typeof entry === 'string' && entry !== '')) return null
  return value as string[]
}

/** Extract a required non-empty branch name. */
function branchOf(payload: unknown): string | null {
  const value = recordOf(payload).branch
  return typeof value === 'string' && value !== '' ? value : null
}

/** Clamp an optional numeric body field into a safe range, falling back when it is not a finite number. */
function clampCount(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.floor(value)))
}

/**
 * Send a service view under the ok envelope, rejecting structurally invalid
 * values (a malformed view would otherwise leak to the browser as a
 * typed-but-wrong payload). A null view is legitimate: it means "not a git
 * repository".
 */
function okView(res: ServerResponse, value: unknown, guard: (view: unknown) => boolean): void {
  if (value !== null && !guard(value)) {
    writeJson(res, 200, FAIL(MALFORMED_VIEW))
    return
  }
  writeJson(res, 200, OK(value))
}

/** Write a mutation result under the shared envelope, guarding the error arm. */
function writeMutation(res: ServerResponse, result: { ok: true; summary: string } | { ok: false; error: GitError }): void {
  writeJson(res, 200, result.ok ? OK({ summary: result.summary }) : FAIL(isGitError(result.error) ? result.error : MALFORMED_VIEW))
}

/**
 * Register the /gitpanel routes (prefix for the JSON operations, exact for the
 * SSE stream — longest-prefix-wins keeps them disjoint).
 * @param ctx - context carrying the webServer service.
 * @param service - the workspace-gated git service.
 * @returns the route disposers.
 */
export function registerGitPanelRoutes(ctx: Context, service: GitService): () => void {
  const subscribers = new Set<Subscriber>()
  // The poll loop's lifetime is bound to the subscriber set: created/started
  // when the first subscriber joins, stopped when the last one closes.
  let guard: PollGuard | undefined
  let heartbeatTimer: NodeJS.Timeout | undefined

  const removeSubscriber = (subscriber: Subscriber): void => {
    subscriber.probeAbort?.abort(new Error('git panel subscriber closed'))
    subscriber.probeAbort = undefined
    subscribers.delete(subscriber)
    if (subscribers.size === 0) {
      guard?.stop()
      guard = undefined
      if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer)
      heartbeatTimer = undefined
    }
  }

  const push = (subscriber: Subscriber, payload: unknown): void => {
    subscriber.res.write(`event: change\ndata: ${JSON.stringify(payload)}\n\n`)
  }

  const statusWithDeadline = async (
    path: string,
    controller: AbortController = new AbortController(),
  ): Promise<Awaited<ReturnType<GitService['statusFiles']>>> => {
    let timeout: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        const error = new Error(STATUS_TIMEOUT_MESSAGE)
        controller.abort(error)
        reject(error)
      }, STATUS_TIMEOUT_MS)
    })
    try {
      return await Promise.race([service.statusFiles(path, controller.signal), deadline])
    } finally {
      if (timeout !== undefined) clearTimeout(timeout)
    }
  }

  /**
   * One poll round. The change key carries the branch/head probe AND a
   * single-spawn digest of the file-level porcelain, so the panel refreshes for
   * a commit (branch/head), a branch switch elsewhere, and a plain file edit or
   * stage/unstage (digest) alike.
   */
  const runPoll = async (): Promise<void> => {
    await Promise.all([...subscribers].map(async (subscriber) => {
      const controller = new AbortController()
      subscriber.probeAbort = controller
      try {
        const probe = await service.probe(subscriber.path, controller.signal)
        // A failed digest keeps the previous value so a transient error never
        // flaps the stream.
        let fileDigest = subscriber.lastFileDigest ?? ''
        try {
          const digest = await service.statusDigest(subscriber.path, controller.signal)
          if (digest !== null) {
            fileDigest = digest
            subscriber.lastFileDigest = digest
          }
        } catch {
          // tolerate: the probe half still covers branch and head changes
        }
        const key = probe === null
          ? 'no-repo'
          : `${probe.root}|${probe.branch}|${probe.head}|f:${fileDigest}`
        if (key === subscriber.last) return
        subscriber.last = key
        push(subscriber, { path: subscriber.path, branch: probe?.branch ?? '', head: probe?.head ?? '' })
      } catch (error: unknown) {
        if (subscribers.has(subscriber)) {
          ctx.logger.warn(`dsh-git-panel: state poll failed for ${subscriber.path}: ${String(error)}`)
        }
      } finally {
        if (subscriber.probeAbort === controller) subscriber.probeAbort = undefined
      }
    }))
  }

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // Trust fence first: never let an unpaired LAN client reach any git
    // operation, regardless of method or content-type.
    if (!isGitPanelAllowed(ctx, req)) {
      writeJson(res, 403, { error: 'forbidden: loopback-only' })
      return
    }
    if (req.method !== 'POST') {
      res.writeHead(405)
      res.end()
      return
    }
    // CSRF hardening: the mutations act on the real repository and there is no
    // origin/referer check, so require a JSON content-type — a cross-site form
    // cannot set application/json without a CORS preflight, which the
    // same-origin client always sends.
    const contentType = req.headers['content-type'] ?? ''
    if (!contentType.toLowerCase().startsWith('application/json')) {
      res.writeHead(415)
      res.end()
      return
    }
    const pathname = new URL(req.url ?? '/', 'http://x').pathname
    const payload = await readJsonBody(req, { maxBytes: 1024 * 1024 })
    const path = pathOf(payload)
    if (path === null) {
      writeJson(res, 200, FAIL(BAD_REQUEST))
      return
    }
    switch (pathname) {
      case '/gitpanel/status-files':
        try {
          okView(res, await statusWithDeadline(path), isStatusFilesView)
        } catch (error: unknown) {
          ctx.logger.warn(`dsh-git-panel: status request failed for ${path}: ${String(error)}`)
          writeJson(res, 200, FAIL({ code: 'internal', message: STATUS_TIMEOUT_MESSAGE }))
        }
        return
      case '/gitpanel/branches':
        okView(res, await service.branches(path), isBranchesView)
        return
      case '/gitpanel/switch': {
        const branch = branchOf(payload)
        if (branch === null) {
          writeJson(res, 200, FAIL(BAD_REQUEST))
          return
        }
        const result = await service.switchBranch(path, branch)
        writeJson(res, 200, result.ok
          ? OK({ branch: result.branch })
          : FAIL(isGitError(result.error) ? result.error : MALFORMED_VIEW))
        return
      }
      case '/gitpanel/diff': {
        const record = recordOf(payload)
        const file = record.file
        if (typeof file !== 'string' || file === '') {
          writeJson(res, 200, FAIL(BAD_REQUEST))
          return
        }
        okView(res, await service.diff(path, file, record.staged === true), isDiffView)
        return
      }
      case '/gitpanel/stage':
      case '/gitpanel/unstage': {
        const paths = pathListOf(payload)
        if (paths === null) {
          writeJson(res, 200, FAIL(BAD_REQUEST))
          return
        }
        writeMutation(res, pathname === '/gitpanel/stage'
          ? await service.stage(path, paths)
          : await service.unstage(path, paths))
        return
      }
      case '/gitpanel/discard': {
        const paths = pathListOf(payload)
        if (paths === null) {
          writeJson(res, 200, FAIL(BAD_REQUEST))
          return
        }
        writeMutation(res, await service.discard(path, paths))
        return
      }
      case '/gitpanel/apply-selection': {
        // A line selection: the client rebuilt a patch for just those rows, and the
        // service checks it names nothing but the file it claims before git sees it.
        const record = recordOf(payload)
        const file = record.file
        const fragment = record.fragment
        const direction = record.direction
        if (typeof file !== 'string' || file === '' || typeof fragment !== 'string' || fragment === ''
          || (direction !== 'stage' && direction !== 'unstage' && direction !== 'discard')) {
          writeJson(res, 200, FAIL(BAD_REQUEST))
          return
        }
        writeMutation(res, await service.applySelection(path, file, direction, fragment))
        return
      }
      case '/gitpanel/commit': {
        const message = recordOf(payload).message
        if (typeof message !== 'string') {
          writeJson(res, 200, FAIL(BAD_REQUEST))
          return
        }
        const result = await service.commit(path, message, recordOf(payload).amend === true)
        writeJson(res, 200, result.ok
          ? OK({ oid: result.oid, subject: result.subject })
          : FAIL(isGitError(result.error) ? result.error : MALFORMED_VIEW))
        return
      }
      case '/gitpanel/history': {
        const record = recordOf(payload)
        // Clamp rather than reset: an out-of-range value from a future client
        // must not silently collapse to the default page.
        const limit = clampCount(record.limit, 50, 1, 500)
        const skip = clampCount(record.skip, 0, 0, 100_000)
        okView(res, await service.history(path, limit, skip), isHistoryView)
        return
      }
      case '/gitpanel/commit-detail': {
        const oid = recordOf(payload).oid
        if (typeof oid !== 'string' || oid === '') {
          writeJson(res, 200, FAIL(BAD_REQUEST))
          return
        }
        okView(res, await service.commitDetail(path, oid), isCommitDetail)
        return
      }
      case '/gitpanel/remote':
        okView(res, await service.remoteView(path), isRemoteView)
        return
      case '/gitpanel/fetch':
      case '/gitpanel/pull':
      case '/gitpanel/push': {
        const result = pathname === '/gitpanel/fetch'
          ? await service.fetch(path)
          : pathname === '/gitpanel/pull' ? await service.pull(path) : await service.push(path)
        writeMutation(res, result)
        return
      }
      case '/gitpanel/merge':
      case '/gitpanel/rebase': {
        const branch = branchOf(payload)
        if (branch === null) {
          writeJson(res, 200, FAIL(BAD_REQUEST))
          return
        }
        writeMutation(res, pathname === '/gitpanel/merge'
          ? await service.merge(path, branch)
          : await service.rebase(path, branch))
        return
      }
      case '/gitpanel/abort':
        writeMutation(res, await service.abortOperation(path))
        return
      default:
        res.writeHead(404)
        res.end()
    }
  }

  const sse = (req: IncomingMessage, res: ServerResponse): void => {
    // Reject unpaired non-loopback clients before the stream opens.
    if (!isGitPanelAllowed(ctx, req)) {
      writeJson(res, 403, { error: 'forbidden: loopback-only' })
      return
    }
    const url = new URL(req.url ?? '/', 'http://x')
    const path = url.searchParams.get('path')
    if (path === null || path === '') {
      res.writeHead(400)
      res.end()
      return
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    res.write('retry: 2000\n\n')
    const subscriber: Subscriber = { path, last: '', res }
    subscribers.add(subscriber)
    // A push/heartbeat write racing socket teardown emits 'error' on the
    // response stream; unhandled, that can crash the host. Dropping the
    // subscriber degrades the race to a lost write; req 'close' finishes the
    // remaining cleanup.
    res.on('error', () => { removeSubscriber(subscriber) })
    if (guard === undefined) {
      guard = new PollGuard({
        intervalMs: POLL_INTERVAL_MS,
        deadlineMs: POLL_LIFETIME_MS,
        maxBackoffMs: POLL_INTERVAL_MS,
        onRun: runPoll,
      })
    }
    guard.start()
    if (heartbeatTimer === undefined) {
      heartbeatTimer = setInterval(() => {
        for (const current of subscribers) current.res.write(': ping\n\n')
      }, HEARTBEAT_INTERVAL_MS)
    }
    req.on('close', () => { removeSubscriber(subscriber) })
  }

  const disposers = [
    ctx.webServer.register({ kind: 'prefix', path: '/gitpanel', handler }),
    ctx.webServer.register({ kind: 'exact', path: '/gitpanel/events', handler: sse }),
  ]
  return () => {
    for (const dispose of disposers) dispose()
    guard?.stop()
    if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer)
    for (const subscriber of subscribers) {
      subscriber.probeAbort?.abort(new Error('git panel routes disposed'))
      subscriber.res.end()
    }
    subscribers.clear()
  }
}
