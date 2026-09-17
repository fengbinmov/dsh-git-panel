/**
 * Wire vocabulary shared by the host git service and the browser client: the
 * request/response shapes of the /gitpanel/* routes, the pure parsers for git's
 * output, and the runtime narrowing the route boundary runs before sending a
 * view. Zod is deliberately not a dependency, so every guard is a hand-written
 * structural check over the same shape the service produces.
 * @module dsh-git-panel/core/types
 */

/** Stable rejection codes the client maps onto bilingual copy. */
export type GitErrorCode =
  | 'conflicts-present'
  | 'operation-in-progress'
  | 'branch-in-other-worktree'
  | 'tracked-changes-would-be-overwritten'
  | 'untracked-changes-would-be-overwritten'
  | 'target-branch-not-found'
  | 'invalid-branch-name'
  | 'workspace-unknown'
  // Index / commit controls.
  | 'nothing-to-commit'
  | 'empty-commit-message'
  | 'nothing-to-discard'
  | 'not-a-repository'
  | 'invalid-path'
  // Remote controls.
  | 'no-upstream'
  | 'remote-failed'
  | 'detached-head'
  | 'internal'

/** One rejection with the copy-key payload the client needs. */
export interface GitError {
  code: GitErrorCode
  /** Human-readable message (host-authored English; the client prefers its own copy by code). */
  message: string
  /** Files blocking the operation (the overwrite guards), first few only. */
  paths?: string[]
  /** Additional blocked-file count beyond `paths`. */
  moreFiles?: number
}

/** Coarse classification of one worktree change (the badge the UI groups by). */
export type FileChangeKind =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'typechange'
  | 'untracked'
  | 'conflicted'

/** One file-level change row, parsed from `git status --porcelain=v1 -z`. */
export interface FileChange {
  /** Repo-relative path, always '/' separated. */
  path: string
  /** Rename/copy origin path; absent for every other kind. */
  origPath?: string
  /** Index (staged) status character; ' ' when the index side is unchanged. */
  index: string
  /** Worktree (unstaged) status character; ' ' when the worktree side is unchanged. */
  worktree: string
  /** Coarse classification for grouping and badging. */
  kind: FileChangeKind
  /** Whether the entry carries staged content. */
  staged: boolean
  /** Whether the entry is an unresolved merge conflict. */
  conflicted: boolean
  /** Whether the entry is untracked. */
  untracked: boolean
  /**
   * Lines added/deleted on the WORKTREE side of this path — the worktree against
   * the index (`git diff --numstat`). Absent when git reports no counts for the
   * path at all: an untracked file is in no diff, and an unresolved conflict's
   * `--numstat` records are a combined diff rather than the change the row stands
   * for.
   */
  worktreeStat?: LineStat
  /**
   * Lines added/deleted on the INDEX side — the index against HEAD
   * (`git diff --cached --numstat`). Absent on the same terms as
   * {@link FileChange.worktreeStat}.
   *
   * Both sides can be present at once: a path staged and then edited again is one
   * record whose two rows (`staged` true and false) each carry their own side's
   * numbers.
   */
  indexStat?: LineStat
}

/** A pair of line counts for one side of the index boundary. */
export interface LineStat {
  additions: number
  deletions: number
}

/** The Changes panel's view: every worktree change plus the branch's sync state. */
export interface StatusFilesView {
  root: string
  /** Current branch; empty when HEAD is detached. */
  branch: string
  head: string
  files: FileChange[]
  stagedCount: number
  unstagedCount: number
  untrackedCount: number
  conflictedCount: number
  operationInProgress: boolean
  /** In-progress operation name ('merge' | 'rebase' | …); empty when none. */
  operation: string
  /** Tracking ref, e.g. 'origin/main'; empty when the branch has no upstream. */
  upstream: string
  /** Commits the upstream has that HEAD lacks. */
  behind: number
  /** Commits HEAD has that the upstream lacks. */
  ahead: number
  /**
   * The configured remotes, so the branch bar needs no second round trip.
   *
   * Optional on the wire: a host older than this field answers without it, and the
   * client then asks the `/gitpanel/remote` route the way it used to — which keeps
   * a refreshed page working against a host that has not been restarted.
   */
  remotes?: RemoteRow[]
  /**
   * Both sides' complete patches, from the SAME two spawns that produced the line
   * counts — so opening a tracked file costs no round trip at all: the panel
   * already holds the text and only has to find the file's section in it.
   *
   * `truncated` says a patch was cut at the host's cap. The LAST file of a cut
   * patch may be incomplete, and the client asks the per-file route for anything
   * it cannot find or cannot trust.
   */
  patches: { worktree: string; staged: string; truncated: boolean }
}

/**
 * Check a line-selection fragment before git is allowed to apply it.
 *
 * This is a security boundary, not a formality. The host cannot rebuild the
 * fragment itself — that needs the parsed rows, which live in the browser — so it
 * accepts patch TEXT from the client, and patch text is executable intent: `git
 * apply` can create, delete and rewrite files. The contract is therefore narrow and
 * enforced here:
 *
 *   - every `diff --git` section must name exactly the path the request asked for
 *     (or `/dev/null` on one side of an addition or deletion);
 *   - the headers that would make a patch do anything OTHER than move lines within
 *     that one file — renames, copies, mode changes, binary patches, `--no-index`'s
 *     null device on both sides — are refused outright;
 *   - the fragment has to carry at least one hunk, and stay under the cap.
 * @param fragment - patch text built by `selectionPatch` on the client.
 * @param file - the repo-relative path the request says it applies to.
 * @returns the rejection, or null when the fragment is acceptable.
 */
export function selectionFragmentError(fragment: string, file: string): GitError | null {
  const reject = (message: string): GitError => ({ code: 'invalid-path', message })
  if (fragment.length > 200_000) return reject('selection fragment too large')
  const lines = fragment.split('\n')
  let sections = 0
  let hunks = 0
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      sections += 1
      const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line)
      if (match === null) return reject('unreadable diff header')
      for (const side of [match[1], match[2]]) {
        if (side !== file) return reject(`fragment touches another path: ${side ?? ''}`)
      }
      continue
    }
    if (line.startsWith('@@')) { hunks += 1; continue }
    if (line.startsWith('rename from ') || line.startsWith('rename to ')
      || line.startsWith('copy from ') || line.startsWith('copy to ')
      || line.startsWith('old mode ') || line.startsWith('new mode ')
      || line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
      return reject('fragment carries a header a line selection cannot produce')
    }
  }
  if (sections !== 1) return reject('fragment must describe exactly one file')
  if (hunks === 0) return reject('fragment carries no hunk')
  return null
}

/** One path's unified diff. */
export interface DiffView {
  path: string
  /** Whether this is the staged (index versus HEAD) side. */
  staged: boolean
  /** Whether git reported the content as binary. */
  binary: boolean
  /** Whether the patch hit the host's byte cap and was cut short. */
  truncated: boolean
  /** Unified diff text; empty when binary or when nothing changed. */
  patch: string
}

/** One file's diff inside a commit, fetched on its own when the commit patch was capped. */
export interface CommitDiff {
  path: string
  /** Whether git reported the content as binary. */
  binary: boolean
  /** Whether the patch hit the host's byte cap and was cut short. */
  truncated: boolean
  /** Unified diff text; empty when binary or when the commit did not touch line content. */
  patch: string
}

/** One history row. */
export interface HistoryCommit {
  oid: string
  shortOid: string
  parents: string[]
  subject: string
  author: string
  authorEmail: string
  /** Unix epoch seconds. */
  authorTime: number
  /** Decoration ref names, prefix-stripped. */
  refs: string[]
}

/** The History panel's page of commits. */
export interface HistoryView {
  root: string
  /** Current branch; empty when detached. */
  branch: string
  commits: HistoryCommit[]
  hasMore: boolean
}

/** One changed file inside a commit (`git show --numstat`). */
export interface CommitFileStat {
  path: string
  additions: number
  deletions: number
  /** True for binary content (git prints '-' for both counts). */
  binary: boolean
}

/** One commit's full detail. */
export interface CommitDetail {
  oid: string
  shortOid: string
  parents: string[]
  subject: string
  /** Full commit message body (subject excluded), trimmed. */
  body: string
  author: string
  authorEmail: string
  authorTime: number
  committer: string
  committerTime: number
  files: CommitFileStat[]
  patch: string
  truncated: boolean
}

/** The metadata half of a {@link CommitDetail} (everything but files/patch). */
export type CommitMeta = Omit<CommitDetail, 'files' | 'patch' | 'truncated'>

/** One configured remote. */
export interface RemoteRow {
  name: string
  fetchUrl: string
  pushUrl: string
}

/** The remote/sync state rendered in the Git view header. */
export interface RemoteView {
  root: string
  branch: string
  /** Tracking ref; empty when the branch has no upstream. */
  upstream: string
  ahead: number
  behind: number
  remotes: RemoteRow[]
}

/** Outcome of a mutation that reports one line of human-readable summary. */
export type MutationResult =
  | { ok: true; summary: string }
  | { ok: false; error: GitError }

/** Outcome of a commit attempt. */
export type CommitOutcome =
  | { ok: true; oid: string; subject: string }
  | { ok: false; error: GitError }

/** Outcome of one branch switch. */
export type SwitchResult =
  | { ok: true; branch: string }
  | { ok: false; error: GitError }

/** One local branch row (`git for-each-ref refs/heads`). */
export interface BranchRow {
  name: string
  current: boolean
}

/** The branch menu's view. */
export interface BranchesView {
  root: string
  /** Current branch; empty when detached. */
  branch: string
  branches: BranchRow[]
}

/**
 * The cheap branch/head probe the SSE change stream polls. Deliberately not the
 * full {@link StatusFilesView}: the stream only needs a change signal, and the
 * browser refetches the real view when it fires.
 */
export interface RepoProbe {
  root: string
  branch: string
  head: string
}

/** The set of stable {@link GitErrorCode} members the client maps onto copy. */
const GIT_ERROR_CODES = new Set<GitErrorCode>([
  'conflicts-present',
  'operation-in-progress',
  'branch-in-other-worktree',
  'tracked-changes-would-be-overwritten',
  'untracked-changes-would-be-overwritten',
  'target-branch-not-found',
  'invalid-branch-name',
  'workspace-unknown',
  'nothing-to-commit',
  'empty-commit-message',
  'nothing-to-discard',
  'not-a-repository',
  'invalid-path',
  'no-upstream',
  'remote-failed',
  'detached-head',
  'internal',
])

/** git's porcelain-v1 unmerged codes: DD, AU, UD, UA, DU, AA, UU. */
const UNMERGED_STATUS = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'])

/** Decoration → ref names: split entries, drop the `HEAD -> ` handoff prefix, drop a bare detached-`HEAD` entry, drop `tag: `. */
export function parseDecoration(decoration: string): string[] {
  if (decoration === '') return []
  return decoration.split(', ').map(part => {
    if (part === 'HEAD') return ''
    return part.replace(/^HEAD -> /, '').replace(/^tag: /, '').trim()
  }).filter(name => name !== '')
}

/** Coarse kind for one porcelain XY pair; the staged side wins when both moved. */
function changeKind(xy: string, indexSide: string, worktreeSide: string): FileChangeKind {
  if (xy === '??') return 'untracked'
  if (UNMERGED_STATUS.has(xy)) return 'conflicted'
  if (indexSide === 'R' || worktreeSide === 'R') return 'renamed'
  if (indexSide === 'C' || worktreeSide === 'C') return 'copied'
  if (indexSide === 'A') return 'added'
  if (indexSide === 'D' || worktreeSide === 'D') return 'deleted'
  if (indexSide === 'T' || worktreeSide === 'T') return 'typechange'
  return 'modified'
}

/** Everything one `git status --porcelain=v2 -z --branch` call answers. */
export interface StatusV2 {
  files: FileChange[]
  /** The current branch; empty when HEAD is detached or unborn. */
  branch: string
  /** The tip's full object id; empty on an unborn branch. */
  head: string
  /** The tracking ref, e.g. 'origin/main'; empty when there is none. */
  upstream: string
  /** Commits the upstream has that HEAD lacks. */
  behind: number
  /** Commits HEAD has that the upstream lacks. */
  ahead: number
}

/** Build one row from the two status characters and the path they apply to. */
function row(xy: string, path: string, origPath?: string): FileChange {
  const indexSide = xy.slice(0, 1)
  const worktreeSide = xy.slice(1, 2)
  const conflicted = UNMERGED_STATUS.has(xy)
  const untracked = xy === '??'
  const change: FileChange = {
    path,
    index: indexSide,
    worktree: worktreeSide,
    kind: changeKind(xy, indexSide, worktreeSide),
    // '?' (untracked) and unmerged codes are not "staged content".
    staged: !untracked && !conflicted && indexSide !== ' ' && indexSide !== '?',
    conflicted,
    untracked,
  }
  if (origPath !== undefined) change.origPath = origPath
  return change
}

/**
 * Parse `git status --porcelain=v2 -z --branch`, the change list AND the branch
 * header in one stream.
 *
 * The stream is POSITIONAL, not line-based: records are NUL-terminated, and the
 * two multi-field record types carry the path at the END, so it is read by field
 * count, not by splitting the record on spaces:
 *
 *   `# branch.oid <sha|(initial)>` · `# branch.head <name|(detached)>` ·
 *   `# branch.upstream <ref>` · `# branch.ab +<ahead> -<behind>`
 *   `1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>`
 *   `2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>` + origin path field
 *   `u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>`
 *   `? <path>`
 *
 * With `-z` the path is verbatim (never quoted, space and newline included), so
 * everything after the fixed fields is the path and nothing needs unescaping.
 * @param stdout - raw stdout from `statusV2Argv()`.
 * @returns the file rows plus the branch facts the same call answered.
 */
export function parseStatusV2(stdout: string): StatusV2 {
  const files: FileChange[] = []
  const status: StatusV2 = { files, branch: '', head: '', upstream: '', ahead: 0, behind: 0 }
  const fields = stdout.split('\u0000')
  for (let index = 0; index < fields.length; index += 1) {
    const record = fields[index]
    if (record === undefined || record === '') continue
    const kind = record.charCodeAt(0)
    // '#': a header record; the key runs from after the '#' to the NEXT space.
    if (kind === 35) {
      const space = record.indexOf(' ', 2)
      const key = space < 0 ? record.slice(2) : record.slice(2, space)
      const value = space < 0 ? '' : record.slice(space + 1)
      if (key === 'branch.oid') status.head = value === '(initial)' ? '' : value
      else if (key === 'branch.head') status.branch = value === '(detached)' ? '' : value
      else if (key === 'branch.upstream') status.upstream = value
      else if (key === 'branch.ab') {
        // '+<ahead> -<behind>'
        const parts = value.split(' ')
        status.ahead = Number(parts[0]?.slice(1) ?? 0) || 0
        status.behind = Number(parts[1]?.slice(1) ?? 0) || 0
      }
      continue
    }
    // '?' (63): an untracked path, the whole tail of the record.
    if (kind === 63) {
      const path = record.slice(2)
      if (path !== '') files.push(row('??', path))
      continue
    }
    const parts = record.split(' ')
    const raw = parts[1]
    if (raw === undefined || raw.length < 2) continue
    // v2 writes '.' where v1 writes a space for "this side did not move", and the
    // panel's whole vocabulary (badges, grouping, predictions) speaks v1 — so it is
    // translated HERE, once, and every later reader sees the spaces it expects.
    const xy = raw.replace(/\./g, ' ')
    if (kind === 49) {
      // '1' (49): field 8 onwards is the path, spaces and all.
      const path = parts.slice(8).join(' ')
      if (path !== '') files.push(row(xy, path))
      continue
    }
    if (kind === 50) {
      // '2' (50): a rename/copy; the origin path is the NEXT NUL-separated field.
      const path = parts.slice(9).join(' ')
      if (path === '') continue
      index += 1
      const origin = fields[index]
      files.push(row(xy, path, origin === undefined || origin === '' ? undefined : origin))
      continue
    }
    if (kind === 117) {
      // 'u' (117): an unmerged path, ten fixed fields before it.
      const path = parts.slice(10).join(' ')
      if (path !== '') files.push(row(xy, path))
    }
  }
  return status
}

/**
 * Parse `git diff --numstat -z --no-renames -p` — the counts and the patch of one
 * side of the index boundary, from one stream.
 *
 * The numstat records come first, NUL-terminated; then one spare NUL; then the
 * patch as ordinary text. So the records are read off the FRONT while they still
 * look like records (`<add>\t<del>\t<path>`, add/del being a number or `-`), and
 * whatever follows the first field that does not is the patch — a scan that cannot
 * be fooled by a patch line, because a patch line is never the first thing in a
 * record.
 * @param stdout - raw stdout from `diffStatPatchArgv()`.
 * @returns the per-path counts and the patch text.
 */
export function parseStatPatch(stdout: string): { stats: CommitFileStat[]; patch: string } {
  const stats: CommitFileStat[] = []
  let at = 0
  while (at < stdout.length) {
    const end = stdout.indexOf('\u0000', at)
    if (end < 0) break
    const record = stdout.slice(at, end)
    if (!/^(?:\d+|-)\t(?:\d+|-)\t/.test(record)) break
    const first = record.indexOf('\t')
    const second = record.indexOf('\t', first + 1)
    const additionsRaw = record.slice(0, first)
    const deletionsRaw = record.slice(first + 1, second)
    const binary = additionsRaw === '-' || deletionsRaw === '-'
    stats.push({
      path: record.slice(second + 1),
      additions: binary ? 0 : Number(additionsRaw) || 0,
      deletions: binary ? 0 : Number(deletionsRaw) || 0,
      binary,
    })
    at = end + 1
  }
  // The spare NUL that separates the records from the patch.
  const patch = stdout.slice(stdout.charCodeAt(at) === 0 ? at + 1 : at)
  return { stats, patch }
}

/**
 * Rebuild one change row from a new pair of status characters, keeping every
 * derived field (kind, the two flags, the staged side) consistent with them.
 * @param change - the row being changed.
 * @param index - the new index-side character.
 * @param worktree - the new worktree-side character.
 * @returns a new row; the original is untouched.
 */
function withSides(change: FileChange, index: string, worktree: string): FileChange {
  const xy = index + worktree
  const conflicted = UNMERGED_STATUS.has(xy)
  const untracked = xy === '??'
  return {
    ...change,
    index,
    worktree,
    kind: changeKind(xy, index, worktree),
    // '?' (untracked) and unmerged codes are not "staged content".
    staged: !untracked && !conflicted && index !== ' ' && index !== '?',
    conflicted,
    untracked,
  }
}

/** Recount the status's per-side totals after its files were rewritten. */
function withCounts(status: StatusFilesView): StatusFilesView {
  return {
    ...status,
    stagedCount: status.files.filter(file => file.staged).length,
    unstagedCount: status.files.filter(file => !file.untracked && !file.conflicted && file.worktree !== ' ').length,
    untrackedCount: status.files.filter(file => file.untracked).length,
    conflictedCount: status.files.filter(file => file.conflicted).length,
  }
}

/**
 * Attach per-side line counts to the status records.
 *
 * One record describes one PATH, and the panel draws it once per side that moved,
 * so the counts are kept per side rather than flattened onto the record: a path
 * staged and then edited again shows the index's numbers on its staged row and
 * the worktree's on its pending row. That is why the two `--numstat` answers stay
 * separate maps.
 *
 * Two kinds of path keep NO numbers, and their rows then render none rather than
 * a misleading figure:
 *   - an untracked file is in no diff at all;
 *   - an unresolved conflict IS reported, but as a combined diff against both
 *     sides of the merge — git emits the path more than once (measured: `0 0 f`
 *     and `4 0 f` for one conflicted file), and neither record is the change the
 *     row stands for.
 * @param files - the parsed porcelain rows.
 * @param worktree - `git diff --numstat` (the worktree against the index).
 * @param staged - `git diff --cached --numstat` (the index against HEAD).
 * @returns new records; the input records are untouched.
 */
export function withLineStats(
  files: readonly FileChange[],
  worktree: readonly CommitFileStat[],
  staged: readonly CommitFileStat[],
): FileChange[] {
  const pending = new Map(worktree.map(stat => [stat.path, stat]))
  const index = new Map(staged.map(stat => [stat.path, stat]))
  const pair = (stat: CommitFileStat | undefined): LineStat | undefined =>
    stat === undefined ? undefined : { additions: stat.additions, deletions: stat.deletions }
  return files.map((file) => {
    if (file.conflicted) return file
    const worktreeStat = pair(pending.get(file.path))
    const indexStat = pair(index.get(file.path))
    if (worktreeStat === undefined && indexStat === undefined) return file
    return { ...file, worktreeStat, indexStat }
  })
}

/**
 * The status a repository is about to have once `paths` are staged or unstaged.
 *
 * This exists so the panel can move a row the instant the user drops it, instead
 * of after git has answered: the host round trip (a `git add`/`reset` spawn, then
 * a `git status` spawn) is 300ms and more, and every drop used to wait for it —
 * which made dragging files back and forth feel broken. The prediction is a
 * PREDICTION: the next refresh replaces it with git's own answer, so a miss
 * (an unusual status code, a conflict) corrects itself within one round trip
 * rather than sticking.
 *
 * The rules mirror what git does:
 *   - staging takes ALL of a path's changes into the index, so an untracked file
 *     becomes an addition and a tracked one keeps the character it had;
 *   - unstaging returns the index side to HEAD, so an addition becomes untracked
 *     again and anything else falls back to the worktree side.
 *
 * The row's line counts travel with it: staging a pending change puts exactly
 * those changes into the index, so the numbers stay right for a one-sided change
 * and the next refresh replaces them with git's own either way.
 * @param status - the current status view.
 * @param paths - the repo-relative paths the verb acts on.
 * @param staged - true to stage, false to unstage.
 * @returns the predicted view, with its totals recounted.
 */
export function predictStaged(
  status: StatusFilesView,
  paths: readonly string[],
  staged: boolean,
): StatusFilesView {
  if (paths.length === 0) return status
  const acted = new Set(paths)
  const files = status.files.map((file) => {
    if (!acted.has(file.path)) return file
    // A conflict has no staging verb, and its resolution is not a status change.
    if (file.conflicted) return file
    if (staged) {
      const index = file.untracked || file.index === 'A'
        ? 'A'
        : (file.worktree !== ' ' ? file.worktree : file.index)
      return withSides(file, index === ' ' || index === '?' ? 'M' : index, ' ')
    }
    // Unstaging: an addition has no HEAD entry to return to, so it is untracked.
    if (file.index === 'A') return withSides(file, '?', '?')
    const worktree = file.worktree !== ' ' ? file.worktree : (file.index === ' ' ? 'M' : file.index)
    return withSides(file, ' ', worktree)
  })
  return withCounts({ ...status, files })
}

/** One side's counts with `counts` taken out of them; absent when nothing is left. */
function withoutStat(stat: LineStat | undefined, counts: LineStat): LineStat | undefined {
  if (stat === undefined) return undefined
  const additions = Math.max(0, stat.additions - counts.additions)
  const deletions = Math.max(0, stat.deletions - counts.deletions)
  return additions === 0 && deletions === 0 ? undefined : { additions, deletions }
}

/** One side's counts with `counts` added to them. */
function withStat(stat: LineStat | undefined, counts: LineStat): LineStat {
  return {
    additions: (stat?.additions ?? 0) + counts.additions,
    deletions: (stat?.deletions ?? 0) + counts.deletions,
  }
}

/**
 * The status a repository is about to have once a LINE selection lands.
 *
 * A line selection is the partial version of the whole-file verbs, so this moves
 * counts instead of rows: the chosen additions and deletions leave one side of the
 * index boundary and join the other. Two things make it honest rather than a guess:
 *
 *   - the counts come from the same diff the row's own counts did, so subtracting
 *     them is real arithmetic (a line-for-line replacement keeps both totals right);
 *   - a side is CLEAN exactly when the chosen counts were all it had, which is what
 *     lets a row leave a region at once instead of after the next refresh.
 *
 * The next refresh replaces all of it with git's own answer, as with every other
 * prediction in this module.
 * @param status - the current status view.
 * @param path - the repo-relative path the selection applies to.
 * @param counts - the chosen rows' additions and deletions.
 * @param direction - stage, unstage or discard.
 * @returns the predicted view, with its totals recounted.
 */
export function predictLineSelection(
  status: StatusFilesView,
  path: string,
  counts: LineStat,
  direction: 'stage' | 'unstage' | 'discard',
): StatusFilesView {
  const target = status.files.find(file => file.path === path)
  if (target === undefined) return status
  const files = status.files.map((file) => {
    if (file !== target) return file
    if (direction === 'stage') {
      const worktreeStat = withoutStat(file.worktreeStat, counts)
      // Everything the worktree side held has just moved into the index.
      const cleared = file.worktreeStat !== undefined && worktreeStat === undefined
      const index = file.untracked || file.index === 'A' ? 'A' : 'M'
      const worktree = cleared ? ' ' : (file.worktree === ' ' || file.worktree === '?' ? 'M' : file.worktree)
      return withSides({ ...file, worktreeStat, indexStat: withStat(file.indexStat, counts) }, index, worktree)
    }
    if (direction === 'unstage') {
      const indexStat = withoutStat(file.indexStat, counts)
      const cleared = file.indexStat !== undefined && indexStat === undefined
      // An addition has no HEAD entry to return to: unstaging all of it leaves the
      // file untracked, which is the rule the whole-file verb already predicts.
      if (cleared && file.index === 'A') {
        return withSides({ ...file, worktreeStat: undefined, indexStat: undefined }, '?', '?')
      }
      const worktree = file.worktree === ' ' ? 'M' : file.worktree
      return withSides({ ...file, indexStat, worktreeStat: withStat(file.worktreeStat, counts) },
        cleared ? ' ' : file.index, worktree)
    }
    // Discard: the chosen worktree changes go back to the index.
    const worktreeStat = withoutStat(file.worktreeStat, counts)
    const cleared = file.worktreeStat !== undefined && worktreeStat === undefined
    return withSides({ ...file, worktreeStat }, file.index, cleared ? ' ' : file.worktree)
  })
  return withCounts({ ...status, files })
}

/**
 * The status a repository is about to have once `paths` are discarded: the
 * worktree side returns to the index, so an untracked file disappears and a
 * tracked one that had no index-side change disappears with it.
 * @param status - the current status view.
 * @param paths - the repo-relative paths to discard.
 * @returns the predicted view, with its totals recounted.
 */
export function predictDiscarded(status: StatusFilesView, paths: readonly string[]): StatusFilesView {
  if (paths.length === 0) return status
  const acted = new Set(paths)
  const files: FileChange[] = []
  for (const file of status.files) {
    if (!acted.has(file.path)) { files.push(file); continue }
    // A conflict is resolved by the host rather than reverted to the index.
    if (file.conflicted) { files.push(file); continue }
    if (file.untracked) continue
    if (file.index === ' ' || file.index === '?') continue
    files.push(withSides(file, file.index, ' '))
  }
  return withCounts({ ...status, files })
}

/**
 * The status a repository is about to have once its index is committed: the
 * staged side is gone, and a path whose worktree also moved stays pending.
 * @param status - the current status view.
 * @returns the predicted view, with its totals recounted.
 */
export function predictCommitted(status: StatusFilesView): StatusFilesView {
  const files: FileChange[] = []
  for (const file of status.files) {
    if (!file.staged) { files.push(file); continue }
    if (file.worktree === ' ' || file.worktree === '?') continue
    files.push(withSides(file, ' ', file.worktree))
  }
  return withCounts({ ...status, files })
}

/** Parse `git for-each-ref refs/heads --format=…`. */
export function parseBranches(stdout: string): BranchRow[] {
  const rows: BranchRow[] = []
  for (const line of stdout.split('\n')) {
    if (line === '') continue
    const [name, head] = line.split('\u0000')
    if (name === undefined || head === undefined) continue
    rows.push({ name, current: head === '*' })
  }
  rows.sort((left, right) => left.name.localeCompare(right.name))
  return rows
}

/**
 * Parse `git log --format=%H%x00%h%x00%P%x00%an%x00%ae%x00%at%x00%D%x00%s%x1e`.
 * `git log` (tformat) appends a newline after the record separator, so every
 * record except the first carries a leading '\n'.
 */
export function parseHistory(stdout: string): HistoryCommit[] {
  const commits: HistoryCommit[] = []
  for (const raw of stdout.split('\u001e')) {
    const entry = raw.replace(/^\n/, '')
    if (entry === '') continue
    const [oid, shortOid, parentsRaw, author, authorEmail, authorTimeRaw, decoration, subject] = entry.split('\u0000')
    if (oid === undefined || oid === '') continue
    commits.push({
      oid,
      shortOid: shortOid === undefined || shortOid === '' ? oid.slice(0, 7) : shortOid,
      parents: parentsRaw === undefined || parentsRaw === '' ? [] : parentsRaw.split(' '),
      subject: subject ?? '',
      author: author ?? '',
      authorEmail: authorEmail ?? '',
      authorTime: Number(authorTimeRaw ?? '0') || 0,
      refs: parseDecoration(decoration ?? ''),
    })
  }
  return commits
}

/** Parse `git show --no-patch --format=%H%x00%h%x00%P%x00%an%x00%ae%x00%at%x00%cn%x00%ct%x00%s%x00%b`. */
export function parseShowMeta(stdout: string): CommitMeta | null {
  const [oid, shortOid, parentsRaw, author, authorEmail, authorTimeRaw, committer, committerTimeRaw, subject, body] = stdout.split('\u0000')
  if (oid === undefined || oid === '') return null
  return {
    oid,
    shortOid: shortOid === undefined || shortOid === '' ? oid.slice(0, 7) : shortOid,
    parents: parentsRaw === undefined || parentsRaw === '' ? [] : parentsRaw.split(' '),
    subject: subject ?? '',
    body: (body ?? '').trim(),
    author: author ?? '',
    authorEmail: authorEmail ?? '',
    authorTime: Number(authorTimeRaw ?? '0') || 0,
    committer: committer ?? '',
    committerTime: Number(committerTimeRaw ?? '0') || 0,
  }
}

/**
 * Parse `git show --numstat -z --format=`: NUL-terminated
 * `<additions>\t<deletions>\t<path>` records. A rename record omits the path in
 * the first field and follows with two more NUL fields; the service pins
 * `--no-renames`, so the trailing-field branch is tolerance rather than the
 * expected shape.
 */
export function parseNumstat(stdout: string): CommitFileStat[] {
  const fields = stdout.split('\u0000')
  const files: CommitFileStat[] = []
  for (let index = 0; index < fields.length; index += 1) {
    const record = fields[index]
    if (record === undefined || record === '') continue
    const parts = record.split('\t')
    const additionsRaw = parts[0]
    const deletionsRaw = parts[1]
    let path = parts[2]
    if (path === undefined || path === '') {
      index += 1
      path = fields[index]
      if (fields[index + 1] !== undefined && fields[index + 1] !== '') index += 1
    }
    if (path === undefined || path === '') continue
    const binary = additionsRaw === '-' || deletionsRaw === '-'
    files.push({
      path,
      additions: binary ? 0 : Number(additionsRaw ?? '0') || 0,
      deletions: binary ? 0 : Number(deletionsRaw ?? '0') || 0,
      binary,
    })
  }
  return files
}

/** Parse `git remote -v` into deduplicated rows carrying both URLs. */
export function parseRemotes(stdout: string): RemoteRow[] {
  const byName = new Map<string, RemoteRow>()
  for (const line of stdout.split('\n')) {
    const match = /^(\S+)\t(.*?)\s+\((fetch|push)\)$/.exec(line.trim())
    if (match === null) continue
    const name = match[1]
    const url = match[2]
    const kind = match[3]
    if (name === undefined || url === undefined) continue
    const row = byName.get(name) ?? { name, fetchUrl: '', pushUrl: '' }
    if (kind === 'fetch') row.fetchUrl = url
    else row.pushUrl = url
    byName.set(name, row)
  }
  return [...byName.values()].sort((left, right) => left.name.localeCompare(right.name))
}

/**
 * Parse `git rev-list --left-right --count <upstream>...HEAD`, whose single
 * line is `<behind>\t<ahead>` (the left side is the upstream).
 */
export function parseAheadBehind(stdout: string): { ahead: number; behind: number } {
  const [behindRaw, aheadRaw] = stdout.trim().split(/\s+/)
  return { ahead: Number(aheadRaw ?? '0') || 0, behind: Number(behindRaw ?? '0') || 0 }
}

/**
 * Name the in-progress git operation from the operation markers present on
 * disk. A rebase writes either `rebase-merge` or `rebase-apply`, so both map to
 * 'rebase'; the rest are one-to-one.
 * @param present - marker names whose resolved path exists.
 * @returns the operation name, or '' when none is in progress.
 */
export function operationNameFromMarkers(present: readonly string[]): string {
  if (present.includes('rebase-merge') || present.includes('rebase-apply')) return 'rebase'
  if (present.includes('MERGE_HEAD')) return 'merge'
  if (present.includes('CHERRY_PICK_HEAD')) return 'cherry-pick'
  if (present.includes('REVERT_HEAD')) return 'revert'
  if (present.includes('BISECT_LOG')) return 'bisect'
  if (present.includes('sequencer')) return 'sequencer'
  return ''
}

/**
 * Whether a unified diff carries binary content rather than text hunks.
 *
 * Both markers are matched at the START OF A LINE, which is what makes this safe:
 * git writes them at column 0, while every line of a patch BODY carries a marker
 * (`+`, `-` or a space), so a text file that merely MENTIONS one of them is not
 * mistaken for a binary one. A bare `includes()` is not enough — measured: opening
 * `GitView.tsx` reported it as binary, because the diff being previewed added the
 * very line that spells the marker out.
 */
export function isBinaryPatch(patch: string): boolean {
  return /^Binary files .* differ/m.test(patch) || /^GIT binary patch/m.test(patch)
}

/** Narrow an unknown value onto {@link GitErrorCode}. */
export function isGitErrorCode(value: unknown): value is GitErrorCode {
  return typeof value === 'string' && GIT_ERROR_CODES.has(value as GitErrorCode)
}

/** Narrow an unknown value onto {@link GitError}. */
export function isGitError(value: unknown): value is GitError {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  if (!isGitErrorCode(record.code)) return false
  if (typeof record.message !== 'string') return false
  if (record.paths !== undefined
    && (!Array.isArray(record.paths) || !record.paths.every(path => typeof path === 'string'))) {
    return false
  }
  if (record.moreFiles !== undefined && typeof record.moreFiles !== 'number') return false
  return true
}

/** Narrow an unknown value onto {@link FileChange}. */
export function isFileChange(value: unknown): value is FileChange {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record.path === 'string'
    && typeof record.index === 'string'
    && typeof record.worktree === 'string'
    && typeof record.kind === 'string'
    && typeof record.staged === 'boolean'
    && typeof record.conflicted === 'boolean'
    && typeof record.untracked === 'boolean'
    && (record.origPath === undefined || typeof record.origPath === 'string')
}

/** Narrow an unknown value onto {@link StatusFilesView}. */
export function isStatusFilesView(value: unknown): value is StatusFilesView {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record.root === 'string'
    && typeof record.branch === 'string'
    && typeof record.head === 'string'
    && Array.isArray(record.files) && record.files.every(isFileChange)
    && typeof record.stagedCount === 'number'
    && typeof record.unstagedCount === 'number'
    && typeof record.untrackedCount === 'number'
    && typeof record.conflictedCount === 'number'
    && typeof record.operationInProgress === 'boolean'
    && typeof record.operation === 'string'
    && typeof record.upstream === 'string'
    && typeof record.ahead === 'number'
    && typeof record.behind === 'number'
}

/** Narrow an unknown value onto {@link DiffView}. */
export function isDiffView(value: unknown): value is DiffView {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record.path === 'string'
    && typeof record.staged === 'boolean'
    && typeof record.binary === 'boolean'
    && typeof record.truncated === 'boolean'
    && typeof record.patch === 'string'
}

/** Narrow an unknown value onto {@link CommitDiff}. */
export function isCommitDiff(value: unknown): value is CommitDiff {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record.path === 'string'
    && typeof record.binary === 'boolean'
    && typeof record.truncated === 'boolean'
    && typeof record.patch === 'string'
}

/** Narrow an unknown value onto {@link HistoryCommit}. */
export function isHistoryCommit(value: unknown): value is HistoryCommit {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record.oid === 'string'
    && typeof record.shortOid === 'string'
    && Array.isArray(record.parents) && record.parents.every(parent => typeof parent === 'string')
    && typeof record.subject === 'string'
    && typeof record.author === 'string'
    && typeof record.authorEmail === 'string'
    && typeof record.authorTime === 'number'
    && Array.isArray(record.refs) && record.refs.every(ref => typeof ref === 'string')
}

/** Narrow an unknown value onto {@link HistoryView}. */
export function isHistoryView(value: unknown): value is HistoryView {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record.root === 'string'
    && typeof record.branch === 'string'
    && Array.isArray(record.commits) && record.commits.every(isHistoryCommit)
    && typeof record.hasMore === 'boolean'
}

/** Narrow an unknown value onto {@link CommitFileStat}. */
export function isCommitFileStat(value: unknown): value is CommitFileStat {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record.path === 'string'
    && typeof record.additions === 'number'
    && typeof record.deletions === 'number'
    && typeof record.binary === 'boolean'
}

/** Narrow an unknown value onto {@link CommitDetail}. */
export function isCommitDetail(value: unknown): value is CommitDetail {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record.oid === 'string'
    && typeof record.shortOid === 'string'
    && Array.isArray(record.parents) && record.parents.every(parent => typeof parent === 'string')
    && typeof record.subject === 'string'
    && typeof record.body === 'string'
    && typeof record.author === 'string'
    && typeof record.authorEmail === 'string'
    && typeof record.authorTime === 'number'
    && typeof record.committer === 'string'
    && typeof record.committerTime === 'number'
    && Array.isArray(record.files) && record.files.every(isCommitFileStat)
    && typeof record.patch === 'string'
    && typeof record.truncated === 'boolean'
}

/** Narrow an unknown value onto {@link RemoteRow}. */
export function isRemoteRow(value: unknown): value is RemoteRow {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record.name === 'string'
    && typeof record.fetchUrl === 'string'
    && typeof record.pushUrl === 'string'
}

/** Narrow an unknown value onto {@link RemoteView}. */
export function isRemoteView(value: unknown): value is RemoteView {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record.root === 'string'
    && typeof record.branch === 'string'
    && typeof record.upstream === 'string'
    && typeof record.ahead === 'number'
    && typeof record.behind === 'number'
    && Array.isArray(record.remotes) && record.remotes.every(isRemoteRow)
}

/** Narrow an unknown value onto {@link BranchRow}. */
export function isBranchRow(value: unknown): value is BranchRow {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record.name === 'string' && typeof record.current === 'boolean'
}

/** Narrow an unknown value onto {@link BranchesView}. */
export function isBranchesView(value: unknown): value is BranchesView {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record.root === 'string'
    && typeof record.branch === 'string'
    && Array.isArray(record.branches) && record.branches.every(isBranchRow)
}

/** Narrow an unknown value onto {@link RepoProbe}. */
export function isRepoProbe(value: unknown): value is RepoProbe {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record.root === 'string'
    && typeof record.branch === 'string'
    && typeof record.head === 'string'
}
