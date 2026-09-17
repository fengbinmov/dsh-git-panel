/**
 * The Git view tab: a fourth Conversation View beside Chat and Trajectory,
 * registering into the `conversation.view` slot. It hosts the index/commit
 * controls (Changes) and the branch history (History), plus the
 * branch/merge/rebase and fetch/pull/push toolbars.
 *
 * All git facts arrive through this package's host /git routes; the component
 * is pure props over the injected verbs, so it holds no git knowledge of its
 * own beyond rendering.
 * @module dsh-git-panel/client/git/GitView
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { predictCommitted, predictDiscarded, predictLineSelection, predictStaged, isBinaryPatch, type BranchRow, type CommitDetail, type CommitDiff, type DiffView, type GitError, type HistoryView, type LineStat, type RemoteView, type StatusFilesView } from '../../core/types.ts'
import type { GitPanelKey } from '../locales.ts'
import type { GitPanelInjected } from '../index.ts'
import { errorMessage } from '../error-copy.ts'
import { BranchMenu } from './BranchMenu.tsx'
import { ChangesPanel, type FileSelection } from './ChangesPanel.tsx'
import { CommitReview } from './CommitReview.tsx'
import { DetailPane } from './DetailPane.tsx'
import { HistoryPanel } from './HistoryPanel.tsx'
import { cachedStatus, markPanelMounted, rememberStatus } from './panel-cache.ts'
import { sectionOf } from './diff-parse.ts'
import { sideStatOf } from './helpers.ts'
import { usePaneSplit } from './pane-split.ts'
import css from './git.module.css'

/** Full props of the Git view: the view slot's runtime share + the injected verbs + the locale seat. */
export type GitViewProps = PropsRuntime<'conversation.view'> & GitPanelInjected & PropsLocale<'git-panel'>

/** The view's own sub-tabs. */
type Tab = 'changes' | 'history'

/**
 * What the view is looking at: nothing, a file in the change list, or a commit in
 * the history.
 *
 * The two tabs read different parts of it. A file selection drives the change
 * list's highlight and the preview beside it; a commit selection drives which
 * history row is highlighted and what the History tab's review opens. The commit
 * variant deliberately never reaches the change list's preview — it is the
 * History tab's own state, kept here because the row highlight and the detail
 * fetch share one effect.
 */
type DetailSelection =
  | { kind: 'none' }
  | { kind: 'file'; path: string; staged: boolean }
  | { kind: 'commit'; oid: string }

/** Page size of one history fetch. */
const HISTORY_PAGE = 50

/**
 * Minimum gap between window-focus refreshes (ms). The host pushes changes
 * over SSE, but a focus refresh covers the cases the stream misses (a push
 * from another machine, an SSE reconnect).
 */
const FOCUS_REFRESH_MIN_MS = 5_000

/** How long a SUCCESS notice lingers before clearing itself (ms). */
const INFO_NOTICE_MS = 4_000

/**
 * How long the pointer must rest on a row before its diff is fetched (ms).
 *
 * Long enough that sweeping the pointer down the list does not fire a git spawn
 * for every row it crosses, short enough that picking a row still finds the patch
 * waiting.
 */
const PEEK_DELAY_MS = 90

/**
 * How long a wait has to last before the preview says it is loading (ms).
 *
 * A patch that arrives in the next frame must not flash 加载中 at the user first —
 * the note is for a wait the user would otherwise read as "nothing happened".
 */
const SLOW_NOTE_MS = 200

/** The cache key of one file's diff: the side matters, a path can be in both lists. */
function diffKey(path: string, staged: boolean): string {
  return `${staged ? 'index' : 'worktree'}|${path}`
}

/**
 * A flag that turns on only once `active` has lasted `delayMs`.
 *
 * Used for the preview's loading note: an operation that finishes promptly shows
 * nothing at all, and one that really takes time still says so.
 * @param active - whether the operation is in flight.
 * @param delayMs - how long it must stay in flight to be worth reporting.
 */
function useSlowFlag(active: boolean, delayMs: number): boolean {
  const [slow, setSlow] = useState(false)
  useEffect(() => {
    if (!active) {
      setSlow(false)
      return undefined
    }
    const timer = setTimeout(() => { setSlow(true) }, delayMs)
    return () => { clearTimeout(timer) }
  }, [active, delayMs])
  return slow
}

/** Fallback rejection when a verb throws instead of resolving to an envelope. */
const INTERNAL_ERROR: GitError = { code: 'internal', message: 'git request failed' }

/**
 * The Git view tab.
 * @param props - see {@link GitViewProps}.
 */
export function GitView(props: GitViewProps) {
  const sessionId = props.sessionId
  const { t } = props

  const [tab, setTab] = useState<Tab>('changes')
  /** undefined = loading, null = not a repository, else the snapshot. */
  const [status, setStatus] = useState<StatusFilesView | null | undefined>(cachedStatus)
  const [remote, setRemote] = useState<RemoteView | null>(null)
  const [branches, setBranches] = useState<BranchRow[]>([])
  const [menuOpen, setMenuOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ tone: 'error' | 'info'; text: string } | null>(null)

  const [selection, setSelection] = useState<DetailSelection>({ kind: 'none' })
  const [diff, setDiff] = useState<DiffView | null>(null)
  const [detail, setDetail] = useState<CommitDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  // The preview's loading note waits: a patch already in the cache never shows it,
  // and neither does one that arrives while the user is still reading the click.
  // Declared here, above the view's early returns, because a hook may not sit
  // behind a branch.
  const slowDetailLoading = useSlowFlag(detailLoading && diff === null && detail === null, SLOW_NOTE_MS)

  /**
   * Diffs already resolved, keyed by `<side>|<path>`, plus the requests still on
   * the wire for them.
   *
   * A click must never wait. Most patches never reach this cache at all: both
   * sides' patches arrive WITH the file list, and a tracked file's diff is cut out
   * of that text synchronously (see `batchPatches`). What lands here is what the
   * batch could not answer — an untracked path (which is in neither diff), a path
   * whose section was missing or cut short, and the per-file fallback results —
   * plus the hover prefetch that warms those before the click.
   *
   * The entries are dropped on every refresh (see `refreshFiles`) — a refresh is
   * git reporting a new state — and `generation` stops a request that was in
   * flight across one from storing a patch that no longer matches.
   */
  const diffCache = useRef(new Map<string, DiffView>())
  const inFlight = useRef(new Map<string, Promise<DiffView | null>>())
  const generation = useRef(0)
  /**
   * Bumped on every refresh, so the effect that resolves the preview re-runs.
   *
   * Without it the preview kept showing whatever patch it had resolved when the row
   * was first clicked: staging a few LINES changes the file's diff without changing
   * which row is selected, so nothing re-resolved it and the pane stayed stale until
   * the user clicked another file. (The whole-file verbs had the same hole.)
   */
  const [revision, setRevision] = useState(0)
  /**
   * Which file selection the `diff` in state belongs to.
   *
   * A refresh re-resolves the preview against the fresh patches, and a path the
   * batch cannot answer (an untracked file, or a section the cap cut short) costs a
   * host round trip. Clearing the diff for that wait unmounted the viewer and took
   * the reader's scroll position with it, so the diff already on screen for the SAME
   * selection stays there until the answer replaces it. A newly picked file has
   * nothing worth keeping and still starts empty.
   */
  const previewKey = useRef<string | null>(null)
  /** The resolved diff as a ref, so the effect can tell "nothing to keep" from "keep what is there". */
  const diffRef = useRef<DiffView | null>(null)
  diffRef.current = diff
  /**
   * Which commit the `detail` in state belongs to — the same idea for the History tab.
   *
   * A refresh re-fetches the commit under review, and blanking the pane for the wait
   * unmounted the whole review: its picked file, the file list's scroll and the diff's
   * scroll all lived in that DOM. Keeping the loaded detail on screen while the same
   * commit re-resolves leaves all three where the reader left them; a different commit
   * has nothing worth keeping and starts empty.
   */
  const reviewKey = useRef<string | null>(null)
  /** The loaded commit detail as a ref, so the effect can tell "keep" from "start empty". */
  const detailRef = useRef<CommitDetail | null>(null)
  detailRef.current = detail
  const peekTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /**
   * Both sides' patches, exactly as the last refresh handed them over.
   *
   * Held in a ref rather than passed down: the row handlers must not change
   * identity every time the list does, or the whole list re-renders on every
   * refresh for nothing.
   */
  const batchPatches = useRef<{ worktree: string; staged: string; truncated: boolean } | null>(
    // Seeded from the cache too: a re-opened tab can preview a file immediately.
    cachedStatus()?.patches ?? null,
  )

  const [history, setHistory] = useState<HistoryView | null>(null)
  const [historyLoading, setHistoryLoading] = useState(false)

  // The horizontal split between the list and the detail pane, remembered per
  // repository (a different root re-reads it).
  const panes = usePaneSplit('changes', status?.root ?? '')

  const refreshFiles = useCallback((): (() => void) => {
    let live = true
    props.files(sessionId)
      .then(next => {
        if (!live) return
        // A refresh is git answering with a new state, so every patch resolved
        // against the previous one is no longer known to describe it — including
        // the two whole-side patches, which are replaced wholesale.
        generation.current += 1
        diffCache.current.clear()
        inFlight.current.clear()
        batchPatches.current = next?.patches ?? null
        rememberStatus(next)
        setStatus(next)
        // The patches just changed under the preview, so whatever it is showing has
        // to be resolved again against them.
        setRevision(current => current + 1)
      })
      .catch(() => {
        if (!live) return
        batchPatches.current = null
        rememberStatus(null)
        setStatus(null)
      })
    return () => { live = false }
  }, [props.files, sessionId])

  // The cache is what makes RE-opening the tab instant, so whether the panel is on
  // screen is recorded for the warm-up in `index.ts` to skip.
  useEffect(() => {
    markPanelMounted(true)
    return () => { markPanelMounted(false) }
  }, [])

  /**
   * The fallback for a host that does not answer with the remote list yet.
   *
   * With a current host the branch bar is filled from the file list's own response
   * (one round trip for the whole tab); only an older host — a page refreshed
   * before `dsh web` was restarted — still needs this second call.
   */
  const legacyRemote = status !== undefined && status !== null && status.remotes === undefined
  useEffect(() => {
    if (!legacyRemote) return undefined
    let live = true
    props.remote(sessionId)
      .then(next => { if (live) setRemote(next) })
      .catch(() => { if (live) setRemote(null) })
    return () => { live = false }
  }, [legacyRemote, props.remote, sessionId])

  const refresh = useCallback((): (() => void) => refreshFiles(), [refreshFiles])

  /**
   * Apply a predicted status right now, so a verb's effect is on screen before
   * git has answered. The refresh that follows replaces it with git's answer.
   */
  const predict = useCallback((update: (current: StatusFilesView) => StatusFilesView): void => {
    setStatus(current => (current === null || current === undefined ? current : update(current)))
  }, [])

  useEffect(() => refresh(), [refresh])

  // An informational notice reports a verb whose effect is not on screen (a fetch,
  // a push). It clears itself so it cannot sit there as clutter; a failure
  // stays until it is dismissed, because it needs reading.
  useEffect(() => {
    if (notice === null || notice.tone !== 'info') return undefined
    const timer = setTimeout(() => { setNotice(null) }, INFO_NOTICE_MS)
    return () => { clearTimeout(timer) }
  }, [notice])

  // The host pushes file-level and branch changes over SSE while a subscriber
  // is connected; focus covers what the 30s poll and a dropped stream miss.
  useEffect(() => {
    let lastFocus = 0
    const unsubscribe = props.subscribeChanges(sessionId, () => { refresh() })
    const onFocus = (): void => {
      const now = Date.now()
      if (now - lastFocus < FOCUS_REFRESH_MIN_MS) return
      lastFocus = now
      refresh()
    }
    window.addEventListener('focus', onFocus)
    return () => {
      unsubscribe()
      window.removeEventListener('focus', onFocus)
    }
  }, [props.subscribeChanges, sessionId, refresh])

  /**
   * One file's diff, from the cache when it is there and from the host when it is
   * not. Concurrent callers — a prefetch and the click that follows it — share one
   * request instead of racing two.
   */
  /**
   * One file's diff out of the patches the last refresh already delivered.
   *
   * `null` means the batch cannot answer — an untracked path (in neither diff), a
   * path whose section is missing, or the last section of a patch that was cut at
   * the host's cap — and the caller falls back to the per-file route.
   */
  const fromBatch = useCallback((path: string, staged: boolean): DiffView | null => {
    const batch = batchPatches.current
    if (batch === null) return null
    const patch = staged ? batch.staged : batch.worktree
    const section = sectionOf(patch, path, batch.truncated)
    if (section === null) return null
    return {
      path,
      staged,
      // The same predicate the per-file route uses, and for the same reason: a
      // patch BODY line quoting git's marker is not a binary file.
      binary: isBinaryPatch(section),
      // The section itself is whole by construction; the cap applied to the whole
      // patch, not to this cut.
      truncated: false,
      patch: section,
    }
  }, [])

  const loadDiff = useCallback((path: string, staged: boolean): Promise<DiffView | null> => {
    const key = diffKey(path, staged)
    const cached = diffCache.current.get(key)
    if (cached !== undefined) return Promise.resolve(cached)
    // The batch first: both sides' patches are already in memory, so a tracked
    // file is answered with a string scan and no request at all.
    const batched = fromBatch(path, staged)
    if (batched !== null) {
      diffCache.current.set(key, batched)
      return Promise.resolve(batched)
    }
    const pending = inFlight.current.get(key)
    if (pending !== undefined) return pending
    const started = generation.current
    const request = props.diff(sessionId, path, staged).then((next) => {
      // A patch fetched before a refresh describes a state git has since moved on
      // from, so it is shown once and not remembered.
      if (next !== null && generation.current === started) diffCache.current.set(key, next)
      return next
    })
    inFlight.current.set(key, request)
    void request.finally(() => {
      if (inFlight.current.get(key) === request) inFlight.current.delete(key)
    })
    return request
  }, [props.diff, sessionId, fromBatch])

  /**
   * The commit review's per-file fetch, or `undefined` when this shell cannot
   * provide it.
   *
   * The declared verb is optional, and a shell that drops unknown inject keys (or a
   * host half from an older build) hands the view a props object without it. The
   * check therefore has to happen HERE, on the verb itself: passing down a wrapper
   * that closes over a missing verb would hide the absence from the review, which
   * would then call the wrapper and throw — an error in an effect takes the whole
   * view down, which is exactly how this turned the History tab blank once already.
   */
  const loadCommitDiff = useMemo((): ((oid: string, file: string) => Promise<CommitDiff | null>) | undefined => {
    const verb = props.commitDiff
    if (typeof verb !== 'function') return undefined
    return (oid: string, file: string) => verb(sessionId, oid, file)
  }, [props.commitDiff, sessionId])

  /**
   * Open one change row.
   *
   * The preview is seeded HERE, in the same batch as the selection, rather than
   * left to the effect: an effect runs after the paint, so a diff that was already
   * in memory would still have cost a frame of header-with-no-body. The effect
   * still runs — it is what handles the paths this cannot answer — and finds the
   * same object waiting, which React bails out of.
   */
  const openFile = useCallback((next: FileSelection): void => {
    const key = diffKey(next.path, next.staged)
    const ready = diffCache.current.get(key) ?? fromBatch(next.path, next.staged) ?? null
    if (ready !== null) diffCache.current.set(key, ready)
    setDiff(ready)
    setDetail(null)
    setDetailLoading(ready === null)
    setSelection({ kind: 'file', path: next.path, staged: next.staged })
  }, [fromBatch])

  /**
   * Fetch a row's diff before it is clicked.
   *
   * The pointer resting on a row is the signal that a click is coming; the short
   * delay keeps a sweep down the list from firing a spawn for every row it crosses.
   * With the batch in place this only matters for the paths the batch cannot
   * answer — untracked files above all.
   */
  const peek = useCallback((next: FileSelection): void => {
    if (peekTimer.current !== null) clearTimeout(peekTimer.current)
    peekTimer.current = setTimeout(() => {
      peekTimer.current = null
      void loadDiff(next.path, next.staged)
    }, PEEK_DELAY_MS)
  }, [loadDiff])

  useEffect(() => () => {
    if (peekTimer.current !== null) clearTimeout(peekTimer.current)
  }, [])

  // Detail data follows the selection. Each fetch is guarded by `live` so a
  // fast re-selection cannot let an older response overwrite a newer one.
  useEffect(() => {
    if (selection.kind === 'none') {
      previewKey.current = null
      reviewKey.current = null
      setDiff(null)
      setDetail(null)
      setDetailLoading(false)
      return undefined
    }
    let live = true
    // A diff already in memory — the pointer's prefetch, or a section cut out of the
    // patches the last refresh delivered — needs no loading state at all: it is shown
    // in the frame this runs in. Consulting the batch here is also what makes a
    // REFRESH re-render the preview in place (see `revision`): a tracked file is
    // re-cut from the fresh patches without a request, and without blanking the pane.
    if (selection.kind === 'file') {
      const key = diffKey(selection.path, selection.staged)
      const ready = diffCache.current.get(key) ?? fromBatch(selection.path, selection.staged)
      if (ready !== null) {
        diffCache.current.set(key, ready)
        previewKey.current = key
        setDetail(null)
        setDiff(ready)
        setDetailLoading(false)
        return undefined
      }
      // The batch cannot answer this path, so it takes a host round trip. A refresh
      // of the file already on screen keeps that diff until the answer lands; blanking
      // it would unmount the viewer and send the reader's scroll position back to the
      // top. A different selection has nothing worth keeping and starts empty.
      const keep = previewKey.current === key && diffRef.current !== null
      previewKey.current = key
      setDetail(null)
      setDetailLoading(true)
      if (!keep) setDiff(null)
      void loadDiff(selection.path, selection.staged)
        .then(next => { if (live) setDiff(next) })
        // A failed refresh keeps the last known answer on screen rather than
        // replacing it with an empty pane the user did not ask for.
        .catch(() => { if (live && !keep) setDiff(null) })
        .finally(() => { if (live) setDetailLoading(false) })
      return () => { live = false }
    }
    // The commit branch: a refresh re-fetches the SAME commit, and blanking the pane
    // for the wait unmounted the review — losing its picked file and both scroll
    // positions. The loaded detail stays until the answer replaces it; a different
    // commit has nothing worth keeping and still starts empty.
    const keep = reviewKey.current === selection.oid && detailRef.current !== null
    reviewKey.current = selection.oid
    setDetailLoading(true)
    if (!keep) {
      setDetail(null)
      setDiff(null)
    }
    void props.commitDetail(sessionId, selection.oid)
      .then(next => { if (live) setDetail(next) })
      // A failed refresh keeps the last known answer on screen rather than
      // replacing it with an empty pane the user did not ask for.
      .catch(() => { if (live && !keep) setDetail(null) })
      .finally(() => { if (live) setDetailLoading(false) })
    return () => { live = false }
  }, [selection, revision, loadDiff, fromBatch, props.commitDetail, sessionId])

  const loadHistory = useCallback((skip: number): void => {
    setHistoryLoading(true)
    props.history(sessionId, HISTORY_PAGE, skip)
      .then((next) => {
        setHistory((previous) => {
          if (next === null) return null
          if (skip === 0 || previous === null) return next
          return { ...next, commits: [...previous.commits, ...next.commits] }
        })
      })
      .catch(() => { setHistory(null) })
      .finally(() => { setHistoryLoading(false) })
  }, [props.history, sessionId])

  useEffect(() => {
    if (tab !== 'history' || history !== null) return undefined
    loadHistory(0)
    return undefined
  }, [tab, history, loadHistory])

  /**
   * Run one mutation with the busy flag, a classified error notice, and a refresh
   * afterwards. The refresh runs on failure too: a rejected merge still changed the
   * working tree.
   * @param action - the verb to run.
   * @param movedRefs - whether this verb can move branches or the upstream, and so
   *   needs the (three-spawn) remote probe as well as the file list.
   */
  /**
   * Run one mutation with the busy flag, a classified error notice, and a refresh
   * afterwards. The refresh runs on failure too: a rejected merge still changed the
   * working tree.
   * @param action - the verb to run.
   * @param options.movedRefs - whether this verb can move branches or the upstream,
   *   and so needs the (three-spawn) remote probe as well as the file list.
   * @param options.announce - whether a SUCCESS is worth a notice. Verbs whose
   *   effect the panel already shows (staging moves the row itself) pass false:
   *   a second copy of "staged 1 path(s)" on every drag is noise, and the summary
   *   is host-side developer text rather than user copy. Failures are always
   *   announced, whatever this says.
   */
  const runMutation = useCallback(async (
    action: () => Promise<{ ok: true; summary: string } | { ok: false; error: GitError }>,
    options: { movedRefs?: boolean; announce?: boolean } = {},
  ): Promise<boolean> => {
    const { movedRefs = false, announce = true } = options
    setBusy(true)
    setNotice(null)
    let ok = false
    try {
      const result = await action()
      if (result.ok) {
        ok = true
        setNotice(!announce || result.summary === '' ? null : { tone: 'info', text: result.summary })
      } else {
        setNotice({ tone: 'error', text: errorMessage(result.error, t) })
      }
    } catch {
      setNotice({ tone: 'error', text: errorMessage(INTERNAL_ERROR, t) })
    } finally {
      setBusy(false)
      // Any mutation can invalidate the history list.
      setHistory(null)
      // One refresh covers everything: the list's own response carries the branch,
      // its upstream, the ahead/behind counts and the remotes, so a verb that moved
      // refs needs no second probe. `movedRefs` is kept in the signature because the
      // call sites still say what they do.
      refreshFiles()
    }
    return ok
  }, [t, refreshFiles])

  /**
   * Apply one line selection from the preview.
   *
   * The fragment was rebuilt in the browser from the rows the user chose, so this is
   * one more verb over the same route family — and the host checks that the fragment
   * names nothing but the file it claims before git touches anything. The path is an
   * argument rather than the current selection: this callback is defined above the
   * view's early returns, where the selection is not in scope yet.
   */
  const applySelection = useCallback((file: string, direction: 'stage' | 'unstage' | 'discard', fragment: string, counts: LineStat): void => {
    // The list's own counts move with the diff, in the same frame as the click: the
    // row's +N −M and the region it belongs to are predicted from what the
    // selection carried, and git's answer replaces them a moment later.
    predict(current => predictLineSelection(current, file, counts, direction))
    // No notice: the preview and the rows themselves are the confirmation, and the
    // branch bar is the wrong place to announce a line edit. A FAILURE still reports
    // itself through the error notice, which is not optional.
    void runMutation(() => props.applySelection(sessionId, file, direction, fragment), { announce: false })
  }, [props.applySelection, runMutation, sessionId])

  const openMenu = useCallback((): void => {
    setMenuOpen(true)
    props.branches(sessionId)
      .then(view => { setBranches(view?.branches ?? []) })
      .catch(() => { setBranches([]) })
  }, [props.branches, sessionId])

  const onCommit = useCallback((message: string, amend: boolean): Promise<boolean> => {
    // The index is what the commit consumes, so its rows can go immediately.
    predict(predictCommitted)
    // The verdict goes back to the commit box, which is what decides whether the draft
    // has been used up or is still the reader's to fix and send again.
    return runMutation(async () => {
      const result = await props.commit(sessionId, message, amend)
      if (!result.ok) return result
      return { ok: true as const, summary: t('git.commit.done', { oid: result.oid }) }
    }).then((ok) => {
      if (ok) setSelection({ kind: 'none' })
      return ok
    })
  }, [predict, props.commit, runMutation, sessionId, t])

  const tiny = `${css.button ?? ''} ${css.buttonTiny ?? ''}`.trim()

  if (status === undefined) {
    return (
      <div className={css.view} data-dsh-plugin="git-panel" data-dsh-part="view">
        <div className={css.empty}>{t('git.loading')}</div>
      </div>
    )
  }

  if (status === null) {
    return (
      <div className={css.view} data-dsh-plugin="git-panel" data-dsh-part="view">
        <div className={css.empty}>{t('git.notRepo')}</div>
      </div>
    )
  }

  const fileSelection: FileSelection | null = selection.kind === 'file'
    ? { path: selection.path, staged: selection.staged }
    : null
  // The selected row's own line counts, straight out of the view the list draws
  // from: the preview header and the row that opened it therefore always agree,
  // and a path git reported no counts for simply shows none in both.
  const selectedRow = fileSelection === null
    ? undefined
    : status?.files.find(file => file.path === fileSelection.path)
  const selectedStat = selectedRow === undefined || fileSelection === null
    ? undefined
    : sideStatOf(selectedRow, fileSelection.staged)
  /**
   * The branch bar's sync state.
   *
   * It rides on the change list's own response now — branch, upstream, ahead/behind
   * and the remote list all arrive together — so opening the tab is ONE round trip.
   * A host too old to answer with `remotes` still gets the separate probe, which is
   * what `legacyRemote` triggers.
   */
  const sync = status === undefined || status === null
    ? null
    : status.remotes === undefined
      ? (remote === null ? null : { upstream: remote.upstream, ahead: remote.ahead, behind: remote.behind, remotes: remote.remotes })
      : { upstream: status.upstream, ahead: status.ahead, behind: status.behind, remotes: status.remotes }
  const hasRemote = sync !== null && sync.remotes.length > 0

  return (
    <div className={css.view} data-dsh-plugin="git-panel" data-dsh-part="view">
      <div className={css.header}>
        <div className={css.branchWrap}>
          <button
            type="button"
            className={css.branchButton}
            onClick={openMenu}
            aria-expanded={menuOpen}
            data-gitgraph-branch-button
          >
            <span className={css.branchLabel}>
              {status.branch === '' ? t('git.detached') : status.branch}
            </span>
            <span className={css.sync}>▾</span>
          </button>
          {menuOpen && (
            <BranchMenu
              current={status.branch}
              branches={branches}
              busy={busy}
              onSwitch={(branch) => {
                void runMutation(async () => {
                  const result = await props.switchBranch(sessionId, branch)
                  return result.ok
                    ? { ok: true as const, summary: t('toast.switchSuccess', { branchName: result.branch }) }
                    : result
                }, { movedRefs: true })
              }}
              onMerge={(branch) => { void runMutation(() => props.merge(sessionId, branch), { movedRefs: true }) }}
              onRebase={(branch) => { void runMutation(() => props.rebase(sessionId, branch), { movedRefs: true }) }}
              onClose={() => { setMenuOpen(false) }}
              t={t}
            />
          )}
        </div>
        {sync !== null && (
          <span className={css.sync}>
            <span>{sync.upstream === '' ? t('git.remote.noUpstream') : sync.upstream}</span>
            {sync.ahead > 0 && <span className={css.syncAhead}>↑{sync.ahead}</span>}
            {sync.behind > 0 && <span className={css.syncBehind}>↓{sync.behind}</span>}
          </span>
        )}
        <span className={css.spacer} />
        <span className={css.toolbar}>
          <button
            type="button"
            className={css.button}
            disabled={busy || !hasRemote}
            data-gitgraph-fetch
            onClick={() => { void runMutation(() => props.fetch(sessionId), { movedRefs: true }) }}
          >
            {busy ? t('git.busy') : t('git.remote.fetch')}
          </button>
          <button
            type="button"
            className={css.button}
            disabled={busy || !hasRemote}
            data-gitgraph-pull
            onClick={() => { void runMutation(() => props.pull(sessionId), { movedRefs: true }) }}
          >
            {t('git.remote.pull')}
          </button>
          <button
            type="button"
            className={css.button}
            disabled={busy || !hasRemote}
            data-gitgraph-push
            onClick={() => { void runMutation(() => props.push(sessionId), { movedRefs: true }) }}
          >
            {t('git.remote.push')}
          </button>
          <button
            type="button"
            className={css.button}
            disabled={busy}
            onClick={() => { refresh() }}
          >
            {t('git.refresh')}
          </button>
        </span>
      </div>

      {status.operationInProgress && (
        <div className={`${css.notice ?? ''} ${css.noticeWarn ?? ''}`.trim()} data-gitgraph-operation>
          <span className={css.noticeText}>{t('git.branch.operation', { operation: status.operation })}</span>
          <button
            type="button"
            className={tiny}
            disabled={busy}
            onClick={() => { void runMutation(() => props.abortOperation(sessionId), { movedRefs: true }) }}
          >
            {t('git.branch.abort')}
          </button>
        </div>
      )}

      {notice !== null && (
        <div
          className={`${css.notice ?? ''} ${notice.tone === 'error' ? css.noticeError ?? '' : css.noticeInfo ?? ''}`.trim()}
          data-gitgraph-notice={notice.tone}
        >
          <span className={css.noticeText}>{notice.text}</span>
          {/* This button hides the message; it does NOT undo the command, so it is
              not labelled "cancel". */}
          <button type="button" className={tiny} onClick={() => { setNotice(null) }}>
            {t('git.dismiss')}
          </button>
        </div>
      )}

      <div className={css.tabs}>
        <button
          type="button"
          className={`${css.tab ?? ''} ${tab === 'changes' ? css.tabActive ?? '' : ''}`.trim()}
          onClick={() => { setTab('changes') }}
          data-gitgraph-tab="changes"
        >
          {t('git.tab.changes')}
          <span className={css.tabCount}>{status.files.length}</span>
        </button>
        <button
          type="button"
          className={`${css.tab ?? ''} ${tab === 'history' ? css.tabActive ?? '' : ''}`.trim()}
          onClick={() => { setTab('history') }}
          data-gitgraph-tab="history"
        >
          {t('git.tab.history')}
        </button>
      </div>

      <div className={css.body} style={panes.style}>
        {tab === 'changes'
          ? (
              <ChangesPanel
                status={status}
                selected={fileSelection}
                busy={busy}
                onSelect={openFile}
                // The row under the pointer is the row about to be clicked,
                // so its diff is fetched then rather than after the click.
                onPeek={peek}
                // Each verb moves its rows on screen FIRST and asks git
                // afterwards: the host round trip is a git spawn plus a
                // status read, and making every drop wait for it is what
                // made dragging files back and forth feel slow.
                onStage={(paths) => {
                  predict(current => predictStaged(current, paths, true))
                  void runMutation(() => props.stage(sessionId, paths), { announce: false })
                }}
                onUnstage={(paths) => {
                  predict(current => predictStaged(current, paths, false))
                  void runMutation(() => props.unstage(sessionId, paths), { announce: false })
                }}
                onDiscard={(paths) => {
                  predict(current => predictDiscarded(current, paths))
                  void runMutation(() => props.discard(sessionId, paths), { announce: false })
                }}
                onCommit={onCommit}
                t={t}
              />
            )
          : (
              <HistoryPanel
                view={history}
                loading={historyLoading}
                selectedOid={selection.kind === 'commit' ? selection.oid : null}
                onSelect={(oid) => { setSelection({ kind: 'commit', oid }) }}
                onLoadMore={() => {
                  const loaded = history === null ? 0 : history.commits.length
                  loadHistory(loaded)
                }}
                t={t}
              />
            )}
        {/* The divider owns the boundary between the two columns; both are
            measured when it is grabbed, and double-clicking hands them back
            to the default ratio. */}
        <div
          className={`${css.paneDivider ?? ''} ${panes.dragging ? css.paneDividerActive ?? '' : ''}`.trim()}
          role="separator"
          aria-orientation="vertical"
          aria-label={t('git.paneDividerAria')}
          title={t('git.paneResizeHint')}
          data-gitgraph-pane-divider=""
          onPointerDown={panes.dividerProps.onPointerDown}
          onDoubleClick={panes.dividerProps.onDoubleClick}
        />
        {/* The Changes tab previews one selected file; the History tab
            opens the selected commit as a review of all of its files. The
            file preview is handed ONLY a file selection: `selection` also
            carries the commit the History tab highlighted, and a commit has
            no business appearing in the change list's preview. */}
        {tab === 'changes'
          ? (
              <DetailPane
                selection={fileSelection}
                diff={diff}
                // The delayed flag, not the raw one: a patch from the cache
                // or off a fast host must never flash the note.
                loading={slowDetailLoading}
                // The preview header shows the same counts as the selected
                // row, taken from the same view, so the two can never
                // disagree.
                stat={selectedStat}
                onApplySelection={(direction, fragment, counts) => {
                  if (fileSelection !== null) applySelection(fileSelection.path, direction, fragment, counts)
                }}
                t={t}
              />
            )
          : (
              <CommitReview
                detail={detail}
                // The raw flag here: this pane's other state is "pick a
                // commit", and saying that while one is loading would be
                // wrong rather than merely premature.
                loading={detailLoading}
                commitDiff={loadCommitDiff}
                root={status?.root ?? ''}
                t={t}
              />
            )}
      </div>
    </div>
  )
}
