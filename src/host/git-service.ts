/**
 * Host git service: workspace-scoped git operations through a runner seam
 * (production: the subprocess service; tests: a plain child_process runner).
 *
 * Every public method first passes the workspace gate, then resolves the
 * repository root from the requested path. Reads return null for a
 * non-repository; mutations return a classified rejection. The destructive
 * verbs additionally validate every client-supplied path before it reaches
 * argv — see {@link validatePaths}.
 *
 * Nothing here writes to the model-visible surface: these are UI-triggered
 * operations, and the plugin registers no tool.
 * @module dsh-git-panel/host/git-service
 */

import { existsSync } from 'node:fs'
import { rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-subprocess'
import { subprocessRunner as sharedSubprocessRunner, type GitRunner } from './git-runner.ts'
import {
  absoluteGitDirArgv, addArgv, aheadBehindArgv, applyPatchArgv, checkRefFormatArgv, classifySwitchFailure,
  cleanArgv, commitArgv, diffPathArgv, diffQuietArgv, diffStatPatchArgv, discardRestoreArgv, fetchArgv,
  forEachRefArgv,
  headBranchArgv, headShortArgv, historyArgv, isSafeRepoPath, mergeAbortArgv,
  mergeArgv, OPERATION_MARKERS, pullArgv, pushArgv, rebaseAbortArgv,
  rebaseArgv, remoteListArgv, rmCachedArgv, showMetaArgv, showPatchArgv, showPathPatchArgv, showStatArgv,
  statusFilesArgv, statusV2Argv, switchArgv, topLevelArgv,
  unstageArgv, untrackedDiffArgv, untrackedProbeArgv, upstreamArgv, validateBranchName,
  verifyHeadArgv, verifyRefArgv,
} from '../core/git-command.ts'
import {
  isBinaryPatch, operationNameFromMarkers, parseAheadBehind, parseBranches, parseHistory,
  parseNumstat, parseRemotes, parseShowMeta, parseStatPatch, parseStatusV2, selectionFragmentError,
  withLineStats,
  type BranchesView, type CommitDetail, type CommitDiff, type CommitOutcome, type DiffView, type GitError,
  type HistoryView, type MutationResult, type RemoteRow, type RemoteView, type RepoProbe,
  type StatusFilesView, type SwitchResult,
} from '../core/types.ts'

/** One finished git invocation (shared runner plumbing). */
export type { GitRunResult, GitRunner } from './git-runner.ts'

/**
 * Build the argv for one git invocation, with the win32 binary variant.
 * Windows ships git as git.exe (git for Windows); a .cmd/.bat shim in PATH
 * would otherwise be the resolution target and Node's spawn cannot launch a
 * .cmd file directly (the dsh-subprocess seam applies no shell). Naming git.exe
 * bypasses any shim and always hits the native executable. cmd.exe routing is
 * deliberately NOT used: several git args carry %-format specs that cmd would
 * expand and corrupt.
 * @param platform - the process platform (process.platform in production; a test seam).
 * @param argv - the git subcommand args.
 * @returns the full spawn argv, starting with the platform git binary.
 */
export function gitSpawnArgv(platform: NodeJS.Platform, argv: readonly string[]): readonly string[] {
  return platform === 'win32' ? ['git.exe', ...argv] : ['git', ...argv]
}

/** The workspace-membership verdict type. */
export type WorkspaceVerdict = { ok: true; canonical: string } | { ok: false; error: GitError }

/**
 * Workspace-membership gate: canonicalize the requested path and require it to
 * equal a registered workspace path (the host's realpath canon). This is the
 * security boundary of the /gitpanel routes — the browser may only run git on
 * workspace roots, never arbitrary host directories.
 */
export type WorkspaceGate = (path: string) => Promise<WorkspaceVerdict>

/**
 * Production runner over `ctx.subprocess`: shared plumbing with the win32
 * git.exe argv variant.
 * @param ctx - context carrying the subprocess service.
 * @returns the runner.
 */
export function subprocessRunner(ctx: Context): GitRunner {
  return sharedSubprocessRunner(ctx, { spawnArgv: (argv) => gitSpawnArgv(process.platform, argv) })
}

/** HEAD is the symbolic value `git rev-parse --abbrev-ref HEAD` prints when detached. */
const DETACHED = 'HEAD'

/** Rejection for a path outside the workspace registry. */
const WORKSPACE_UNKNOWN: GitError = {
  code: 'workspace-unknown',
  message: 'path is not a registered workspace',
}

/** Rejection for a gated path that does not resolve into a git repository. */
const NOT_A_REPOSITORY: GitError = {
  code: 'not-a-repository',
  message: 'not a git repository',
}

/** Rejection for a discard request whose paths no longer carry any change. */
const NOTHING_TO_DISCARD: GitError = {
  code: 'nothing-to-discard',
  message: 'no changed paths to discard',
}

/**
 * Cap on one rendered patch. A single vendored file can yield a multi-megabyte
 * diff, which the browser would then hold in React state on every render. The
 * cap keeps the panel responsive; the cut is reported through `truncated`
 * rather than silently hidden.
 */
const PATCH_CAP_CHARS = 400_000

/**
 * How long a resolved repository root is trusted without asking git again.
 *
 * One `git rev-parse --show-toplevel` spawn is ~56ms on this machine (measured),
 * and the change list's preview used to pay it on every click; the panel's own
 * refreshes paid it too. A workspace's root does not move, so a minute is a
 * conservative bound on noticing a repository that appears or is deleted.
 */
const ROOT_TTL_MS = 60_000

/**
 * Deadline for one network verb (fetch/pull/push). The runner spawns git with
 * `stdin: 'ignore'`, so a credential prompt cannot be answered on the terminal
 * — but a credential HELPER may still open its own UI, and a stalled transport
 * can hang indefinitely. This bound turns either case into a reported failure
 * instead of a spinner that never resolves.
 */
const REMOTE_TIMEOUT_MS = 120_000

/**
 * Workspace-scoped git operations.
 */
export class GitService {
  /**
   * Repository-root lookups, keyed by canonical workspace path.
   *
   * Every route resolves the root with its own `git rev-parse --show-toplevel`
   * spawn — 56ms on this machine, measured — and the change list's preview paid it
   * on every single click. The root of a workspace is a property of the directory
   * rather than of the request, so it is remembered briefly: long enough to take
   * the spawn off a burst of clicks, short enough that a `.git` appearing or
   * disappearing is noticed within the minute.
   */
  private readonly roots = new Map<string, { at: number; root: string | null }>()

  /** Git-directory lookups, remembered on the same terms as {@link GitService.roots}. */
  private readonly dirs = new Map<string, { at: number; dir: string | null }>()

  /**
   * Configured remotes, remembered per repository on the same terms.
   *
   * `git remote -v` is one more spawn on a call that already runs three, and its
   * answer only changes when the user edits their remotes — which this panel cannot
   * even do. Remembering it is what lets the branch bar's buttons be filled in
   * without a second round trip when the tab is opened.
   */
  private readonly remotes = new Map<string, { at: number; rows: RemoteRow[] }>()

  /**
   * @param runner - the spawn seam.
   * @param gate - workspace-membership gate (host: canonical path ∈ registered workspace paths).
   */
  constructor(
    private readonly runner: GitRunner,
    private readonly gate: WorkspaceGate,
  ) {}

  /* ---------------------------------------------------------------- *
   * Shared plumbing
   * ---------------------------------------------------------------- */

  /** Repository root of a canonical path, or null when not inside a git repository. */
  private async repoRoot(path: string, signal?: AbortSignal): Promise<string | null> {
    const remembered = this.roots.get(path)
    if (remembered !== undefined && Date.now() - remembered.at < ROOT_TTL_MS) return remembered.root
    const result = await this.runner.run(topLevelArgv(), path, signal)
    const root = result.exitCode === 0 && result.stdout.trim() !== '' ? result.stdout.trim() : null
    // An aborted call says nothing about the path — the spawn was killed, not
    // answered — so it must never be remembered as "not a repository".
    if (signal?.aborted !== true) this.roots.set(path, { at: Date.now(), root })
    return root
  }

  /**
   * The repository's git directory, remembered exactly like {@link GitService.repoRoot}.
   * Resolved by `--absolute-git-dir`, so it is usable as a path prefix regardless of
   * the process's working directory or a linked worktree.
   */
  private async gitDir(root: string, signal?: AbortSignal): Promise<string | null> {
    const remembered = this.dirs.get(root)
    if (remembered !== undefined && Date.now() - remembered.at < ROOT_TTL_MS) return remembered.dir
    const result = await this.runner.run(absoluteGitDirArgv(), root, signal)
    const dir = result.exitCode === 0 && result.stdout.trim() !== '' ? result.stdout.trim() : null
    if (signal?.aborted !== true) this.dirs.set(root, { at: Date.now(), dir })
    return dir
  }

  /**
   * Gate a mutation request and resolve its repository root, so each method
   * derives the two shared rejections in one place instead of re-spelling them.
   */
  private async gatedRoot(path: string): Promise<{ ok: true; root: string } | { ok: false; error: GitError }> {
    const gated = await this.gate(path)
    if (!gated.ok) return { ok: false, error: WORKSPACE_UNKNOWN }
    const root = await this.repoRoot(gated.canonical)
    if (root === null) return { ok: false, error: NOT_A_REPOSITORY }
    return { ok: true, root }
  }

  /**
   * Validate a request's path list: non-empty, repo-relative, no traversal.
   * @returns the rejection, or null when every path is safe to hand to git.
   */
  private validatePaths(paths: readonly string[]): GitError | null {
    if (paths.length === 0) return { code: 'invalid-path', message: 'no paths given' }
    for (const candidate of paths) {
      if (!isSafeRepoPath(candidate)) {
        return { code: 'invalid-path', message: `unsafe repository path: ${candidate}` }
      }
    }
    return null
  }

  /** Whether HEAD resolves (false on a repository whose branch has no commits yet). */
  private async hasHead(root: string): Promise<boolean> {
    return (await this.runner.run(verifyHeadArgv(), root)).exitCode === 0
  }

  /**
   * The operation markers present on disk, in {@link OPERATION_MARKERS} order.
   *
   * The git directory is resolved ONCE (and remembered, like the repository root)
   * — `rev-parse --absolute-git-dir`, so no worktree or `GIT_DIR` subtlety can
   * point this at the wrong place — and then each marker is one `existsSync` under
   * it. That is the whole check: no spawn, because every marker lives directly in
   * the git directory.
   */
  private async presentMarkers(root: string, signal?: AbortSignal): Promise<string[]> {
    const dir = await this.gitDir(root, signal)
    if (dir === null) return []
    const present: string[] = []
    for (const marker of OPERATION_MARKERS) {
      if (existsSync(resolve(dir, marker))) present.push(marker)
    }
    return present
  }

  /** Whether any git operation marker is present in the repository. */
  private async operationInProgress(root: string, signal?: AbortSignal): Promise<boolean> {
    return (await this.presentMarkers(root, signal)).length > 0
  }

  /**
   * The configured remotes, from a memo that only a change of remotes can stale.
   * @param root - repository root.
   */
  private async remoteRows(root: string, signal?: AbortSignal): Promise<RemoteRow[]> {
    const remembered = this.remotes.get(root)
    if (remembered !== undefined && Date.now() - remembered.at < ROOT_TTL_MS) return remembered.rows
    const result = await this.runner.run(remoteListArgv(), root, signal)
    const rows = result.exitCode === 0 ? parseRemotes(result.stdout) : []
    if (signal?.aborted !== true) this.remotes.set(root, { at: Date.now(), rows })
    return rows
  }

  /** The branch's tracking ref, or '' when it has none (`rev-parse` exits non-zero). */
  private async currentUpstream(root: string): Promise<string> {
    const result = await this.runner.run(upstreamArgv(), root)
    return result.exitCode === 0 ? result.stdout.trim() : ''
  }

  /**
   * The pre-switch guards: unresolved conflicts, in-progress operations, and a
   * target already checked out in another worktree.
   * @param root - repository root.
   * @param target - target branch; undefined for operations that need no such check.
   * @returns the rejection, or null when the operation may proceed.
   */
  private async guardBlock(root: string, target: string | undefined): Promise<GitError | null> {
    const inProgress = await this.operationInProgress(root)
    if (inProgress) {
      return { code: 'operation-in-progress', message: 'a git operation is in progress' }
    }
    if (target === undefined) return null
    // A single-ref probe per worktree branch list is unnecessary here: the
    // switch verb itself reports "already used by worktree", which
    // classifySwitchFailure maps onto branch-in-other-worktree.
    return null
  }

  /**
   * Run one network verb under {@link REMOTE_TIMEOUT_MS}. The deadline is
   * mandatory rather than defensive: a stalled transport, or a credential
   * helper that opened its own window, is otherwise a spinner that never
   * settles.
   */
  private async runRemote(root: string, argv: readonly string[]): Promise<MutationResult> {
    const controller = new AbortController()
    const timer = setTimeout(() => {
      controller.abort(new Error('git remote operation timed out'))
    }, REMOTE_TIMEOUT_MS)
    try {
      const result = await this.runner.run(argv, root, controller.signal)
      if (result.exitCode !== 0) {
        const stderr = result.stderr.trim()
        return {
          ok: false,
          error: {
            code: 'remote-failed',
            message: stderr !== '' ? stderr : `git ${argv[0] ?? 'remote'} failed`,
          },
        }
      }
      // git writes progress to stderr and results to stdout; the panel shows
      // whichever carried text.
      const combined = `${result.stdout}\n${result.stderr}`.trim()
      return { ok: true, summary: combined.split('\n').slice(-3).join('\n') }
    } catch (error: unknown) {
      return { ok: false, error: { code: 'remote-failed', message: error instanceof Error ? error.message : String(error) } }
    } finally {
      clearTimeout(timer)
    }
  }

  /* ---------------------------------------------------------------- *
   * Reads
   * ---------------------------------------------------------------- */

  /**
   * The cheap branch/head probe the SSE change stream polls (two spawns).
   * Null when the path is not a usable repository.
   */
  async probe(path: string, signal?: AbortSignal): Promise<RepoProbe | null> {
    const gated = await this.gate(path)
    if (!gated.ok) return null
    const root = await this.repoRoot(gated.canonical, signal)
    if (root === null) return null
    const [branchResult, headResult] = await Promise.all([
      this.runner.run(headBranchArgv(), root, signal),
      this.runner.run(headShortArgv(), root, signal),
    ])
    const rawBranch = branchResult.stdout.trim()
    return {
      root,
      branch: rawBranch === DETACHED ? '' : rawBranch,
      head: headResult.stdout.trim(),
    }
  }

  /**
   * A single-spawn digest of the worktree's file-level state, for the SSE
   * change stream. The parsed {@link statusFiles} view costs several spawns (two
   * of them per-side `--numstat`) and on
   * Windows a cold git.exe is ~0.7s each, so the poll compares this digest
   * instead — still precise enough that staging, unstaging, or editing any file
   * changes it.
   * @returns the digest, or null when the path is not a gated repository.
   */
  async statusDigest(path: string, signal?: AbortSignal): Promise<string | null> {
    const gated = await this.gate(path)
    if (!gated.ok) return null
    const root = await this.repoRoot(gated.canonical, signal)
    if (root === null) return null
    const result = await this.runner.run(statusFilesArgv(), root, signal)
    if (result.exitCode !== 0) return ''
    // FNV-1a over the raw porcelain text: that text can run to hundreds of KB
    // in a large repository, and this value becomes part of a per-subscriber
    // change key held for the life of the SSE stream.
    let hash = 2166136261
    for (let index = 0; index < result.stdout.length; index += 1) {
      hash ^= result.stdout.charCodeAt(index)
      hash = Math.imul(hash, 16777619)
    }
    return `${result.stdout.length}:${(hash >>> 0).toString(16)}`
  }

  /**
   * The Changes panel's view, in ONE wave of three spawns.
   *
   * Everything the panel needs arrives together: the file list, each row's own
   * side's line counts, the branch and its sync state, the operation markers, and
   * BOTH SIDES' COMPLETE PATCHES. That is what makes opening a file free — the
   * text is already in the response — and it is why the commands are shaped the way
   * they are:
   *   - `status --porcelain=v2 --branch` answers the branch, its tip, its upstream
   *     and the ahead/behind counts in the same stream as the files, replacing four
   *     spawns and the second round trip the ahead/behind probe used to need;
   *   - `diff --numstat -p` answers the counts AND the patch from one walk of the
   *     trees, instead of two;
   *   - the operation markers are read off the disk under the resolved git
   *     directory, which costs nothing after the first call.
   */
  async statusFiles(path: string, signal?: AbortSignal): Promise<StatusFilesView | null> {
    const gated = await this.gate(path)
    if (!gated.ok) return null
    const root = await this.repoRoot(gated.canonical, signal)
    if (root === null) return null
    const [porcelain, worktree, staged, markers, remotes] = await Promise.all([
      this.runner.run(statusV2Argv(), root, signal),
      this.runner.run(diffStatPatchArgv(false), root, signal),
      this.runner.run(diffStatPatchArgv(true), root, signal),
      this.presentMarkers(root, signal),
      this.remoteRows(root, signal),
    ])
    const status = parseStatusV2(porcelain.stdout)
    const worktreeSide = parseStatPatch(worktree.stdout)
    const stagedSide = parseStatPatch(staged.stdout)
    // A patch cut at the cap is still worth sending: the client asks the per-file
    // route only for the file it cannot find or cannot trust.
    const truncated = worktreeSide.patch.length > PATCH_CAP_CHARS || stagedSide.patch.length > PATCH_CAP_CHARS
    const files = withLineStats(status.files, worktreeSide.stats, stagedSide.stats)
    return {
      root,
      branch: status.branch,
      // The view reports the short id it always has; the parser keeps the full one.
      head: status.head.slice(0, 7),
      files,
      stagedCount: files.filter(file => file.staged).length,
      // The worktree-side count includes files that are also staged (git's own
      // "not staged for commit" section does the same).
      unstagedCount: files.filter(file => !file.untracked && !file.conflicted && file.worktree !== ' ').length,
      untrackedCount: files.filter(file => file.untracked).length,
      conflictedCount: files.filter(file => file.conflicted).length,
      operationInProgress: markers.length > 0,
      operation: operationNameFromMarkers(markers),
      upstream: status.upstream,
      ahead: status.ahead,
      behind: status.behind,
      remotes,
      patches: {
        worktree: worktreeSide.patch.slice(0, PATCH_CAP_CHARS),
        staged: stagedSide.patch.slice(0, PATCH_CAP_CHARS),
        truncated,
      },
    }
  }

  /** The branch menu's view: every local branch with the current one marked. */
  async branches(path: string): Promise<BranchesView | null> {
    const gated = await this.gate(path)
    if (!gated.ok) return null
    const root = await this.repoRoot(gated.canonical)
    if (root === null) return null
    const [refs, branchResult] = await Promise.all([
      this.runner.run(forEachRefArgv(), root),
      this.runner.run(headBranchArgv(), root),
    ])
    const rawBranch = branchResult.stdout.trim()
    return {
      root,
      branch: rawBranch === DETACHED ? '' : rawBranch,
      branches: parseBranches(refs.stdout),
    }
  }

  /**
   * One path's unified diff.
   *
   * An untracked path has no index entry, so no ordinary diff range can
   * describe it; it is rendered with the git-native `--no-index /dev/null`
   * patch instead (see `untrackedDiffArgv`), which needs no index mutation and
   * no host-side file read.
   * @param path - workspace root.
   * @param file - repo-relative path.
   * @param staged - render the index-versus-HEAD side instead of worktree-versus-index.
   */
  async diff(path: string, file: string, staged: boolean, signal?: AbortSignal): Promise<DiffView | null> {
    if (!isSafeRepoPath(file)) return null
    const gated = await this.gate(path)
    if (!gated.ok) return null
    const root = await this.repoRoot(gated.canonical, signal)
    if (root === null) return null
    const result = await this.runner.run(diffPathArgv(file, staged), root, signal)
    if (result.exitCode !== 0) return null
    let patch = result.stdout
    // An untracked path has no index entry, so an ordinary diff range cannot
    // describe it and the answer comes back EMPTY — which is what sends us to the
    // null-device form. Testing for untracked FIRST (as this used to) cost every
    // tracked file an extra 56ms spawn on the click path; an empty reading is the
    // cheaper and equally certain signal, and untracked paths are the rarer case.
    if (patch === '' && !staged) {
      const probe = await this.runner.run(untrackedProbeArgv(file), root, signal)
      if (probe.stdout.trim() !== '') {
        const alternative = await this.runner.run(untrackedDiffArgv(file), root, signal)
        // `--no-index` reports "the inputs differ" as exit 1, which is the success
        // case here; anything else non-zero is a real failure.
        if (alternative.exitCode !== 0 && alternative.exitCode !== 1) return null
        patch = alternative.stdout
      }
    }
    const truncated = patch.length > PATCH_CAP_CHARS
    return {
      path: file,
      staged,
      binary: isBinaryPatch(patch),
      truncated,
      patch: truncated ? patch.slice(0, PATCH_CAP_CHARS) : patch,
    }
  }

  /**
   * Apply one line selection: stage, unstage or discard a fragment of a file's diff.
   *
   * The fragment comes from the browser because rebuilding it needs the parsed
   * rows, so {@link selectionFragmentError} is what stands between a client-supplied
   * patch and `git apply`. The patch is written to a temporary file because the
   * subprocess seam gives git no stdin, and the file is removed whatever git says.
   * @param path - workspace root.
   * @param file - repo-relative path the fragment applies to.
   * @param direction - stage, unstage or discard.
   * @param fragment - patch text built by the client's `selectionPatch`.
   */
  async applySelection(
    path: string,
    file: string,
    direction: 'stage' | 'unstage' | 'discard',
    fragment: string,
  ): Promise<MutationResult> {
    if (!isSafeRepoPath(file)) return { ok: false, error: { code: 'invalid-path', message: `unsafe repository path: ${file}` } }
    const rejected = selectionFragmentError(fragment, file)
    if (rejected !== null) return { ok: false, error: rejected }
    const gated = await this.gatedRoot(path)
    if (!gated.ok) return { ok: false, error: gated.error }
    const patchFile = join(tmpdir(), `dsh-git-panel-${randomUUID()}.patch`)
    try {
      await writeFile(patchFile, fragment, 'utf8')
      const result = await this.runner.run(applyPatchArgv(patchFile, direction !== 'discard'), gated.root)
      if (result.exitCode !== 0) {
        return { ok: false, error: { code: 'internal', message: result.stderr.trim() || 'git apply failed' } }
      }
      const lines = fragment.split('\n').filter(line => /^[+-][^+-]/.test(line) || line === '+' || line === '-').length
      return { ok: true, summary: `${direction} ${lines} line(s) in ${file}` }
    } catch (error) {
      return { ok: false, error: { code: 'internal', message: error instanceof Error ? error.message : 'patch write failed' } }
    } finally {
      await rm(patchFile, { force: true }).catch(() => {})
    }
  }

  /**
   * A page of the current branch's history, newest first. `hasMore` comes from
   * requesting one row past the page size.
   */
  async history(path: string, limit = 50, skip = 0): Promise<HistoryView | null> {
    const gated = await this.gate(path)
    if (!gated.ok) return null
    const root = await this.repoRoot(gated.canonical)
    if (root === null) return null
    const [logResult, branchResult] = await Promise.all([
      this.runner.run(historyArgv(limit + 1, skip), root),
      this.runner.run(headBranchArgv(), root),
    ])
    const commits = parseHistory(logResult.stdout)
    const hasMore = commits.length > limit
    const rawBranch = branchResult.stdout.trim()
    return {
      root,
      branch: rawBranch === DETACHED ? '' : rawBranch,
      commits: hasMore ? commits.slice(0, limit) : commits,
      hasMore,
    }
  }

  /**
   * One commit's metadata, changed-file statistics, and patch (`git show`).
   * The oid is validated as a hex object id before it reaches argv, so a
   * crafted value can never be parsed as a git option.
   */
  async commitDetail(path: string, oid: string, signal?: AbortSignal): Promise<CommitDetail | null> {
    if (!/^[0-9a-fA-F]{4,64}$/.test(oid)) return null
    const gated = await this.gate(path)
    if (!gated.ok) return null
    const root = await this.repoRoot(gated.canonical, signal)
    if (root === null) return null
    const [metaResult, statResult, patchResult] = await Promise.all([
      this.runner.run(showMetaArgv(oid), root, signal),
      this.runner.run(showStatArgv(oid), root, signal),
      this.runner.run(showPatchArgv(oid), root, signal),
    ])
    const meta = parseShowMeta(metaResult.stdout)
    if (meta === null) return null
    const patch = patchResult.stdout
    const truncated = patch.length > PATCH_CAP_CHARS
    return {
      ...meta,
      files: parseNumstat(statResult.stdout),
      patch: truncated ? patch.slice(0, PATCH_CAP_CHARS) : patch,
      truncated,
    }
  }

  /**
   * ONE file's patch out of a commit.
   *
   * The commit-wide patch is capped, so a commit touching many files hands the
   * browser a patch whose tail is missing: those files have no section, and the
   * review used to say "the diff was too large" for every one of them. Asking git
   * for this one path is outside that cap, so the file reads whole.
   *
   * The oid and the path are both validated before either reaches argv: the oid as
   * a hex object id (so it can never parse as an option) and the path as a
   * repo-relative one (see `isSafeRepoPath`). The path is additionally kept behind
   * `--` by the argv builder.
   */
  async commitDiff(path: string, oid: string, file: string, signal?: AbortSignal): Promise<CommitDiff | null> {
    if (!/^[0-9a-fA-F]{4,64}$/.test(oid) || !isSafeRepoPath(file)) return null
    const gated = await this.gate(path)
    if (!gated.ok) return null
    const root = await this.repoRoot(gated.canonical, signal)
    if (root === null) return null
    const result = await this.runner.run(showPathPatchArgv(oid, file), root, signal)
    if (result.exitCode !== 0) return null
    const patch = result.stdout
    const truncated = patch.length > PATCH_CAP_CHARS
    return {
      path: file,
      binary: isBinaryPatch(patch),
      truncated,
      patch: truncated ? patch.slice(0, PATCH_CAP_CHARS) : patch,
    }
  }

  /** The header's sync state: branch, upstream, ahead/behind, and configured remotes. */
  async remoteView(path: string): Promise<RemoteView | null> {
    const gated = await this.gate(path)
    if (!gated.ok) return null
    const root = await this.repoRoot(gated.canonical)
    if (root === null) return null
    const [branchResult, upstreamResult, remoteResult] = await Promise.all([
      this.runner.run(headBranchArgv(), root),
      this.runner.run(upstreamArgv(), root),
      this.runner.run(remoteListArgv(), root),
    ])
    const rawBranch = branchResult.stdout.trim()
    const upstream = upstreamResult.exitCode === 0 ? upstreamResult.stdout.trim() : ''
    let ahead = 0
    let behind = 0
    if (upstream !== '') {
      const counts = await this.runner.run(aheadBehindArgv(upstream), root)
      if (counts.exitCode === 0) ({ ahead, behind } = parseAheadBehind(counts.stdout))
    }
    return {
      root,
      branch: rawBranch === DETACHED ? '' : rawBranch,
      upstream,
      ahead,
      behind,
      remotes: parseRemotes(remoteResult.stdout),
    }
  }

  /* ---------------------------------------------------------------- *
   * Branch mutations
   * ---------------------------------------------------------------- */

  /**
   * Switch the workspace's checked-out branch: real `git switch --no-guess` on
   * disk, affecting every session in the workspace (never a per-session
   * override). Guards run before the mutation; switch failures classify onto
   * the stable error codes.
   * @param path - workspace root.
   * @param branch - existing local branch name.
   */
  async switchBranch(path: string, branch: string): Promise<SwitchResult> {
    const gated = await this.gate(path)
    if (!gated.ok) return { ok: false, error: WORKSPACE_UNKNOWN }
    const root = await this.repoRoot(gated.canonical)
    if (root === null) return { ok: false, error: NOT_A_REPOSITORY }
    const formatted = await this.runner.run(checkRefFormatArgv(branch), root)
    if (formatted.exitCode !== 0) {
      return { ok: false, error: { code: 'invalid-branch-name', message: formatted.stderr.trim() || 'invalid branch name' } }
    }
    const verified = await this.runner.run(verifyRefArgv(branch), root)
    if (verified.exitCode !== 0) {
      return { ok: false, error: { code: 'target-branch-not-found', message: `branch "${branch}" does not exist locally` } }
    }
    const currentResult = await this.runner.run(headBranchArgv(), root)
    if (currentResult.stdout.trim() === branch) return { ok: true, branch }
    const blocked = await this.guardBlock(root, branch)
    if (blocked !== null) return { ok: false, error: blocked }
    const switched = await this.runner.run(switchArgv(branch), root)
    if (switched.exitCode === 0) return { ok: true, branch }
    return { ok: false, error: classifySwitchFailure(switched.stderr) }
  }

  /**
   * Merge another branch into the current one (`git merge --no-edit`).
   *
   * A conflicted merge is deliberately NOT rolled back: leaving the conflict in
   * place is the point, since the panel then reports it and offers
   * {@link abortOperation}.
   */
  async merge(path: string, branch: string): Promise<MutationResult> {
    return this.branchVerb(path, branch, mergeArgv, 'merge')
  }

  /**
   * Replay the current branch onto another (`git rebase`). Conflicts likewise
   * stop mid-operation and are surfaced rather than auto-aborted.
   */
  async rebase(path: string, branch: string): Promise<MutationResult> {
    return this.branchVerb(path, branch, rebaseArgv, 'rebase')
  }

  /**
   * The shared body of merge and rebase: both name one existing local branch,
   * both are blocked by an operation already in progress, and both can stop
   * mid-way on a conflict.
   */
  private async branchVerb(
    path: string,
    branch: string,
    build: (branch: string) => string[],
    name: string,
  ): Promise<MutationResult> {
    if (validateBranchName(branch) !== null) {
      return { ok: false, error: { code: 'invalid-branch-name', message: `invalid branch name: ${branch}` } }
    }
    const gated = await this.gatedRoot(path)
    if (!gated.ok) return { ok: false, error: gated.error }
    const blocked = await this.guardBlock(gated.root, branch)
    if (blocked !== null) return { ok: false, error: blocked }
    const exists = await this.runner.run(verifyRefArgv(branch), gated.root)
    if (exists.exitCode !== 0) {
      return { ok: false, error: { code: 'target-branch-not-found', message: `branch "${branch}" does not exist locally` } }
    }
    const result = await this.runner.run(build(branch), gated.root)
    const output = `${result.stdout}\n${result.stderr}`.trim()
    const first = output.split('\n')[0] ?? ''
    if (result.exitCode !== 0) {
      // A conflicted merge/rebase leaves markers on disk on purpose; that
      // presence is what distinguishes "stopped with conflicts" from a plain
      // failure, so it is probed rather than inferred from stderr wording.
      if (await this.operationInProgress(gated.root)) {
        return { ok: false, error: { code: 'conflicts-present', message: first !== '' ? first : `${name} stopped with conflicts` } }
      }
      return { ok: false, error: { code: 'internal', message: first !== '' ? first : `git ${name} failed` } }
    }
    return { ok: true, summary: output.split('\n').slice(-3).join('\n') }
  }

  /**
   * Abort an in-progress merge or rebase. The verb is chosen from the markers
   * actually on disk, so a caller cannot ask for the wrong `--abort`.
   */
  async abortOperation(path: string): Promise<MutationResult> {
    const gated = await this.gatedRoot(path)
    if (!gated.ok) return { ok: false, error: gated.error }
    const operation = operationNameFromMarkers(await this.presentMarkers(gated.root))
    if (operation === '') {
      return { ok: false, error: { code: 'operation-in-progress', message: 'no git operation is in progress' } }
    }
    const result = await this.runner.run(operation === 'rebase' ? rebaseAbortArgv() : mergeAbortArgv(), gated.root)
    if (result.exitCode !== 0) {
      return { ok: false, error: { code: 'internal', message: result.stderr.trim() || `git ${operation} --abort failed` } }
    }
    return { ok: true, summary: `aborted ${operation}` }
  }

  /* ---------------------------------------------------------------- *
   * Index and commit mutations
   * ---------------------------------------------------------------- */

  /** Stage the given paths (`git add`). */
  async stage(path: string, paths: readonly string[]): Promise<MutationResult> {
    const unsafe = this.validatePaths(paths)
    if (unsafe !== null) return { ok: false, error: unsafe }
    const gated = await this.gatedRoot(path)
    if (!gated.ok) return { ok: false, error: gated.error }
    const result = await this.runner.run(addArgv(paths), gated.root)
    if (result.exitCode !== 0) {
      return { ok: false, error: { code: 'internal', message: result.stderr.trim() || 'git add failed' } }
    }
    return { ok: true, summary: `staged ${paths.length} path(s)` }
  }

  /**
   * Unstage the given paths without touching the working tree
   * (`git reset HEAD --`). On a branch with no commits there is no HEAD to
   * reset against, so the index entries are dropped directly instead.
   */
  async unstage(path: string, paths: readonly string[]): Promise<MutationResult> {
    const unsafe = this.validatePaths(paths)
    if (unsafe !== null) return { ok: false, error: unsafe }
    const gated = await this.gatedRoot(path)
    if (!gated.ok) return { ok: false, error: gated.error }
    const result = await this.runner.run(unstageArgv(paths), gated.root)
    if (result.exitCode !== 0) {
      if (await this.hasHead(gated.root)) {
        return { ok: false, error: { code: 'internal', message: result.stderr.trim() || 'git reset failed' } }
      }
      const dropped = await this.runner.run(rmCachedArgv(paths), gated.root)
      if (dropped.exitCode !== 0) {
        return { ok: false, error: { code: 'internal', message: dropped.stderr.trim() || 'git rm --cached failed' } }
      }
    }
    return { ok: true, summary: `unstaged ${paths.length} path(s)` }
  }

  /**
   * Discard everything the given paths carry, back to HEAD: unstage them and
   * restore tracked content, then delete the untracked ones.
   *
   * The two buckets cannot share one invocation. `git restore` rejects a
   * pathspec it does not know and does so ATOMICALLY — one untracked path
   * aborts the whole command and leaves every other path untouched — so
   * untracked paths are routed to `git clean` instead. On a conflicted path the
   * restore resolves the conflict to HEAD's version, which is the useful
   * reading of "discard" while a merge is stopped. Destructive and irreversible
   * for untracked files (`git clean` keeps no reflog), which is why the client
   * gates it behind its own confirmation.
   */
  async discard(path: string, paths: readonly string[]): Promise<MutationResult> {
    const unsafe = this.validatePaths(paths)
    if (unsafe !== null) return { ok: false, error: unsafe }
    const gated = await this.gatedRoot(path)
    if (!gated.ok) return { ok: false, error: gated.error }
    const root = gated.root
    // Classify against live status rather than trusting a client-side flag: a
    // path's bucket can change between the list render and the click.
    const status = await this.runner.run(statusV2Argv(), root)
    const byPath = new Map(parseStatusV2(status.stdout).files.map(file => [file.path, file]))
    const restore: string[] = []
    const clean: string[] = []
    for (const candidate of paths) {
      const change = byPath.get(candidate)
      // A path git no longer reports has nothing left to discard.
      if (change === undefined) continue
      if (change.untracked) clean.push(candidate)
      else restore.push(candidate)
    }
    if (restore.length === 0 && clean.length === 0) return { ok: false, error: NOTHING_TO_DISCARD }
    if (restore.length > 0) {
      if (await this.hasHead(root)) {
        const restored = await this.runner.run(discardRestoreArgv(restore), root)
        if (restored.exitCode !== 0) {
          return { ok: false, error: { code: 'internal', message: restored.stderr.trim() || 'git restore failed' } }
        }
      } else {
        // Unborn branch: nothing is committed to restore from, so discarding
        // means dropping the staged entries and then removing the files.
        const dropped = await this.runner.run(rmCachedArgv(restore), root)
        if (dropped.exitCode !== 0) {
          return { ok: false, error: { code: 'internal', message: dropped.stderr.trim() || 'git rm --cached failed' } }
        }
        clean.push(...restore)
      }
    }
    if (clean.length > 0) {
      const cleaned = await this.runner.run(cleanArgv(clean), root)
      if (cleaned.exitCode !== 0) {
        return { ok: false, error: { code: 'internal', message: cleaned.stderr.trim() || 'git clean failed' } }
      }
    }
    return { ok: true, summary: `discarded ${restore.length + clean.length} path(s)` }
  }

  /**
   * Commit the staged changes (`git commit -m`).
   *
   * An empty message and an empty index are rejected here rather than being
   * left to git, so the panel can show the specific copy key instead of
   * surfacing a localized exit-code message.
   * @param path - workspace root.
   * @param message - commit message (a leading dash is safe after `-m`).
   * @param amend - replace the tip commit instead of extending it.
   */
  async commit(path: string, message: string, amend = false): Promise<CommitOutcome> {
    if (message.trim() === '') {
      return { ok: false, error: { code: 'empty-commit-message', message: 'a commit message is required' } }
    }
    const gated = await this.gatedRoot(path)
    if (!gated.ok) return { ok: false, error: gated.error }
    const root = gated.root
    // `diff --cached --quiet` exits 1 when the index differs from HEAD, which is
    // exactly "there is something staged"; `--amend` is allowed to reuse the
    // current tip without new staged content.
    if (!amend && (await this.runner.run(diffQuietArgv(), root)).exitCode === 0) {
      return { ok: false, error: { code: 'nothing-to-commit', message: 'the index has no staged changes' } }
    }
    const result = await this.runner.run(commitArgv(message, amend), root)
    if (result.exitCode !== 0) {
      const stderr = result.stderr.trim()
      const first = stderr.split('\n')[0] ?? ''
      return {
        ok: false,
        error: {
          code: /nothing to commit|no changes added to commit/.test(stderr) ? 'nothing-to-commit' : 'internal',
          message: first !== '' ? first : 'git commit failed',
        },
      }
    }
    // Read the new tip from HEAD rather than scraping git's localized,
    // column-aligned "[branch abc1234] subject" summary line.
    const head = await this.runner.run(headShortArgv(), root)
    const oid = head.stdout.trim()
    const meta = await this.runner.run(showMetaArgv(oid), root)
    const parsed = parseShowMeta(meta.stdout)
    return {
      ok: true,
      oid,
      subject: parsed === null || parsed.subject === '' ? (message.split('\n')[0] ?? '') : parsed.subject,
    }
  }

  /* ---------------------------------------------------------------- *
   * Remote verbs
   * ---------------------------------------------------------------- */

  /** `git fetch --prune` — refresh remote-tracking refs without touching the worktree. */
  async fetch(path: string): Promise<MutationResult> {
    const gated = await this.gatedRoot(path)
    if (!gated.ok) return { ok: false, error: gated.error }
    return this.runRemote(gated.root, fetchArgv())
  }

  /**
   * `git pull --no-edit` — merge the upstream into the current branch. A branch
   * with no upstream is rejected up front so the panel can say so instead of
   * surfacing git's fatal message.
   */
  async pull(path: string): Promise<MutationResult> {
    const gated = await this.gatedRoot(path)
    if (!gated.ok) return { ok: false, error: gated.error }
    if (await this.currentUpstream(gated.root) === '') {
      return { ok: false, error: { code: 'no-upstream', message: 'the current branch has no upstream to pull from' } }
    }
    if (await this.operationInProgress(gated.root)) {
      return { ok: false, error: { code: 'operation-in-progress', message: 'a git operation is in progress' } }
    }
    return this.runRemote(gated.root, pullArgv())
  }

  /**
   * `git push`, adding `--set-upstream origin <branch>` when the current branch
   * has no upstream yet (the first-push case).
   */
  async push(path: string): Promise<MutationResult> {
    const gated = await this.gatedRoot(path)
    if (!gated.ok) return { ok: false, error: gated.error }
    const root = gated.root
    const branch = (await this.runner.run(headBranchArgv(), root)).stdout.trim()
    if (branch === '' || branch === DETACHED) {
      return { ok: false, error: { code: 'detached-head', message: 'HEAD is detached; check out a branch before pushing' } }
    }
    const upstream = await this.currentUpstream(root)
    return this.runRemote(root, pushArgv(upstream === '' ? undefined : upstream, branch))
  }
}
