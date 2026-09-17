/**
 * Git command vocabulary: argv builders, stderr classification, and the pure
 * name/path validators the service gates on. The host service runs these
 * through the subprocess seam; tests exercise this layer with a plain runner.
 *
 * Every argv builder exists so no caller ever hand-assembles a git command
 * line: the destructive verbs in particular must not be assembled ad hoc.
 * @module dsh-git-panel/core/git-command
 */

import type { GitError, GitErrorCode } from './types.ts'

/** `git rev-parse --show-toplevel` — canonical repository root. */
export const topLevelArgv = (): string[] => ['rev-parse', '--show-toplevel']

/** `git rev-parse --abbrev-ref HEAD` — current branch ('HEAD' when detached). */
export const headBranchArgv = (): string[] => ['rev-parse', '--abbrev-ref', 'HEAD']

/** `git rev-parse --short HEAD` — short head id. */
export const headShortArgv = (): string[] => ['rev-parse', '--short', 'HEAD']

/** `git rev-parse --verify --quiet HEAD` — fails on an unborn branch (a repo with no commits yet). */
export const verifyHeadArgv = (): string[] => ['rev-parse', '--verify', '--quiet', 'HEAD']

/** `git rev-parse --verify --quiet refs/heads/<branch>` — local branch existence probe. */
export const verifyRefArgv = (branch: string): string[] => ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]

/** `git check-ref-format --branch <name>` — the authoritative branch-name gate. */
export const checkRefFormatArgv = (name: string): string[] => ['check-ref-format', '--branch', name]

/** `git for-each-ref refs/heads --format=…` — local branches with the current one marked. */
export const forEachRefArgv = (): string[] => [
  'for-each-ref', 'refs/heads',
  '--format=%(refname:short)%00%(HEAD)%00%(objectname)',
]

/** `git switch --no-guess -- <branch>` — workspace-level branch switch. */
export const switchArgv = (branch: string): string[] => ['switch', '--no-guess', '--', branch]

/**
 * `git status --porcelain=v2 -z --branch` — the whole change-list header in ONE
 * spawn.
 *
 * v2 is not a preference here, it is the point: the `# branch.oid` / `# branch.head`
 * / `# branch.upstream` / `# branch.ab` records carry the branch, its tip, its
 * tracking ref and the ahead/behind counts in the same stream as the file list.
 * That replaces four separate `rev-parse`/`rev-list` spawns AND the second round
 * trip the ahead/behind probe used to need (it cannot run until the upstream is
 * known). Records are NUL-separated with `-z`, exactly like v1, and paths are
 * never quoted, so nothing has to be unescaped.
 */
export const statusV2Argv = (): string[] => ['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all']

/**
 * `git status --porcelain=v1 -z --untracked-files=all` — the raw text the SSE
 * change stream hashes. It is never parsed, only compared, so v1 stays.
 */
export const statusFilesArgv = (): string[] => ['status', '--porcelain=v1', '-z', '--untracked-files=all']

/**
 * `git rev-parse --absolute-git-dir` — the repository's git directory, absolute.
 *
 * Every operation marker (MERGE_HEAD, rebase-merge, sequencer, …) lives directly
 * inside it, so with this resolved once the marker check is a handful of
 * `existsSync` calls instead of a spawn. It is absolute, so no worktree or
 * `GIT_DIR` subtlety can point the check at the wrong directory.
 */
export const absoluteGitDirArgv = (): string[] => ['rev-parse', '--absolute-git-dir']

/**
 * `-c core.quotePath=false`, in front of every command whose OUTPUT carries a
 * path.
 *
 * With the default setting git C-quotes any path holding a non-ASCII byte
 * (`"\303\244.txt"`), in `--numstat` records and in the `diff --git` / `+++` lines
 * alike. Callers match those paths against the ones `status -z` reports verbatim,
 * so a quoted path simply never matched: a file whose patch could not be found.
 * Turning the quoting off makes every path in the output the real one.
 */
const UNQUOTED: readonly string[] = ['-c', 'core.quotePath=false']

/**
 * `git apply --recount --whitespace=nowarn [--cached] -- <patchfile>` — apply a
 * whole patch, or the fragment of one that a line selection rebuilt.
 *
 * `--recount` is what makes a hand-rebuilt fragment usable: git re-derives the
 * counts from the body instead of trusting the header, so dropping some of a hunk's
 * lines does not require the arithmetic to be exactly right. `--whitespace=nowarn`
 * keeps a whitespace-only complaint from failing an operation the user asked for.
 *
 * `cached` picks the target: the index (staging, unstaging) or the worktree
 * (discarding). There is no `--reverse`: a fragment for an unstage or a discard is
 * already written as "take this change back out" (see `selectionPatch`).
 */
export const applyPatchArgv = (patchFile: string, cached: boolean): string[] => [
  'apply', '--recount', '--whitespace=nowarn', ...(cached ? ['--cached'] : []), '--', patchFile,
]

/** `git add -- <paths>` — stage the given worktree paths. */
export const addArgv = (paths: readonly string[]): string[] => ['add', '--', ...paths]

/**
 * `git reset -q HEAD -- <paths>` — unstage without touching the working tree.
 * Resetting to HEAD (rather than a bare `git reset --`) keeps the intent
 * explicit; an unborn branch has no HEAD and uses {@link rmCachedArgv}.
 */
export const unstageArgv = (paths: readonly string[]): string[] => ['reset', '-q', 'HEAD', '--', ...paths]

/**
 * `git rm -q -r -f --cached -- <paths>` — the unborn-branch fallback for
 * dropping index entries (-f because a staged addition differs from both the
 * worktree and the absent HEAD).
 */
export const rmCachedArgv = (paths: readonly string[]): string[] => ['rm', '-q', '-r', '-f', '--cached', '--', ...paths]

/** `git clean -q -f -d -- <paths>` — delete untracked paths (destructive). */
export const cleanArgv = (paths: readonly string[]): string[] => ['clean', '-q', '-f', '-d', '--', ...paths]

/**
 * `git restore --staged --worktree -- <paths>` — revert the given paths to
 * HEAD on BOTH sides (destructive).
 *
 * `--staged --worktree` together is the point, not redundancy: one call drops
 * a staged addition (removing the file from disk as well as the index),
 * reverts a staged modification, and restores a deleted file. `--worktree`
 * alone would leave everything staged. The command is rejected ATOMICALLY when
 * any pathspec is unknown — one untracked path aborts the whole thing and
 * leaves every other path untouched — so callers must route untracked paths to
 * {@link cleanArgv}. It also requires a resolvable HEAD; on an unborn branch it
 * fails with "could not resolve HEAD" and callers use {@link rmCachedArgv}.
 */
export const discardRestoreArgv = (paths: readonly string[]): string[] =>
  ['restore', '--staged', '--worktree', '--', ...paths]

/** One path's unified diff; `staged` selects the index-versus-HEAD side (a different flag, not a different range). */
export const diffPathArgv = (path: string, staged: boolean): string[] => [...UNQUOTED,
  'diff', '--no-color', '--no-ext-diff', ...(staged ? ['--cached'] : []), '--', path]

/**
 * `git diff --numstat -z --no-renames -p [--cached]` — every path's added/deleted
 * line counts AND every path's patch, from ONE spawn.
 *
 * The counts and the patch come out of the same walk of the same trees, so asking
 * for them separately pays for that walk twice. The stream is the numstat records
 * first (NUL-terminated, `<add>\t<del>\t<path>`), then a spare NUL, then the patch
 * text — which is why {@link parseStatPatch} reads the records off the front and
 * treats everything after them as the patch.
 *
 * `-z` keeps paths containing tabs or newlines readable and `--no-renames` keeps
 * one record per path instead of the delete+add pair; both are also what make the
 * record shape identical to a commit's `--numstat`. `git diff` exits 0 whether or
 * not anything differs (only `--exit-code`/`--quiet` change that), and on an
 * unborn branch `--cached` still reports the staged files, so neither call needs
 * an exit-code branch.
 */
export const diffStatPatchArgv = (staged: boolean): string[] => [...UNQUOTED,
  'diff', '--numstat', '-z', '--no-renames', '-p', ...(staged ? ['--cached'] : [])]

/**
 * `git diff --cached --quiet` — exit 0 when the index matches HEAD, 1 when the
 * index carries staged changes. The "is there anything to commit" probe, so the
 * answer never depends on parsing localized status text.
 */
export const diffQuietArgv = (): string[] => ['diff', '--cached', '--quiet']

/**
 * `git diff --no-index --no-color -- /dev/null <path>` — the synthesized "new
 * file" patch for an untracked path.
 *
 * An untracked file has no index entry, so no ordinary diff range can show it.
 * `--no-index` against the null device renders one the git-native way, without
 * mutating the index (`git add -N`) and without the host reading the file
 * itself (which would put arbitrary-content reads behind an HTTP route). Git
 * exits 1 when the two inputs differ — always the case here — so callers must
 * accept exit 1 as success.
 */
export const untrackedDiffArgv = (path: string): string[] => [...UNQUOTED,
  'diff', '--no-index', '--no-color', '--no-ext-diff', '--', '/dev/null', path,
]

/** `git ls-files --others --exclude-standard -- <path>` — non-empty when the path is untracked. */
export const untrackedProbeArgv = (path: string): string[] => [
  'ls-files', '--others', '--exclude-standard', '--', path,
]

/** `git commit -m <message>` (`--amend` replaces the tip instead of extending it). */
export const commitArgv = (message: string, amend: boolean): string[] =>
  amend ? ['commit', '--amend', '-m', message] : ['commit', '-m', message]

/** `git log <ref> --topo-order --format=… --max-count <n> --skip <n>` — history of one ref. */
export const historyArgv = (limit: number, skip: number, ref = 'HEAD'): string[] => [
  'log', ref, '--topo-order',
  '--format=%H%x00%h%x00%P%x00%an%x00%ae%x00%at%x00%D%x00%s%x1e',
  '--max-count', String(limit),
  '--skip', String(skip),
]

/** `git show --no-patch --format=…` — one commit's metadata without its patch. */
export const showMetaArgv = (oid: string): string[] => [
  'show', '--no-patch',
  '--format=%H%x00%h%x00%P%x00%an%x00%ae%x00%at%x00%cn%x00%ct%x00%s%x00%b',
  oid,
]

/** `git show --numstat -z --format=` — one commit's changed-file statistics (NUL-separated, so paths with tabs or newlines survive). */
export const showStatArgv = (oid: string): string[] => [...UNQUOTED,
  'show', '--numstat', '-z', '--format=', '--no-renames', '--first-parent', oid,
]

/**
 * `git show --patch --first-parent` — one commit's unified diff.
 *
 * `--first-parent` is what makes a MERGE commit readable at all. Without it git
 * answers a merge with its combined diff (`--cc`), which reports only the files
 * whose conflicts were resolved by hand — for an ordinary "Merge branch 'x'" that
 * is the EMPTY STRING. The panel then had a populated file list (the per-file
 * `--numstat` is not empty) and a zero-byte patch, so every file fell through to
 * "the diff was too large".
 *
 * With it, a merge is diffed against its FIRST parent, which is what the merge
 * brought into the branch — the same choice GitHub and GitLab make. A commit with
 * one parent is unaffected: the same argv without the flag produces byte-identical
 * output (measured), so one code path serves both.
 */
export const showPatchArgv = (oid: string): string[] => [...UNQUOTED,
  'show', '--patch', '--first-parent', '--no-color', '--no-ext-diff', '--format=', oid,
]

/**
 * `git show <oid> -- <path>` — ONE file's patch out of a commit.
 *
 * The commit-wide `show` is capped, so a commit touching many files arrives with
 * its tail cut off and those files have no section to render at all. A single
 * path is not subject to that cap, so a file reads whole however large the commit
 * around it is. The `--` separator keeps a path that begins with a dash from being
 * read as an option.
 *
 * `--first-parent` is here for the same reason as in {@link showPatchArgv}: without
 * it a MERGE answers this route with nothing at all (measured: 0 bytes against 751
 * with it), so the files the list showed stayed unpreviewable — the cap was never
 * the whole story.
 */
export const showPathPatchArgv = (oid: string, path: string): string[] => [...UNQUOTED,
  'show', '--patch', '--first-parent', '--no-color', '--no-ext-diff', '--format=', oid, '--', path,
]

/**
 * `git ls-tree -l -z <rev> -- <path>` — how many BYTES one path holds at one revision.
 *
 * This is what a file with no text to diff can still say about itself: a binary
 * change, a mode change, an empty rewrite. The size is git's own answer for the
 * blob the revision points at, so it needs no working-tree read and no index
 * mutation, and a path that does not exist at that revision simply answers with
 * nothing (exit 0, empty output) — which the caller reads as "absent on this side",
 * the new-file and deleted-file cases.
 *
 * `-l` is what adds the size column; `-z` keeps a path with a tab or newline
 * readable; `--` keeps a leading-dash path out of the option parser.
 */
export const lsTreeSizeArgv = (rev: string, path: string): string[] => [...UNQUOTED,
  'ls-tree', '-l', '-z', rev, '--', path,
]

/** `git remote -v` — configured remotes with their fetch/push URLs. */
export const remoteListArgv = (): string[] => ['remote', '-v']

/** `git rev-parse --abbrev-ref --symbolic-full-name @{upstream}` — the tracking ref; exits non-zero when there is none. */
export const upstreamArgv = (): string[] => ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']

/** `git rev-list --left-right --count <upstream>...HEAD` — behind/ahead counts. */
export const aheadBehindArgv = (upstream: string): string[] => ['rev-list', '--left-right', '--count', `${upstream}...HEAD`]

/**
 * Network verbs. The runner spawns git with `stdin: 'ignore'`, so git cannot
 * read a credential prompt from a terminal; the service additionally bounds
 * these calls with a deadline because a credential helper may still open its
 * own window. Credential helpers are deliberately NOT cleared (no
 * `-c credential.helper=`), so a machine with one configured keeps
 * authenticating normally.
 */
export const fetchArgv = (): string[] => ['fetch', '--prune', '--quiet']

/** `git pull --no-edit` — merge-style pull that never opens an editor. */
export const pullArgv = (): string[] => ['pull', '--no-edit']

/** `git push` (`--set-upstream origin <branch>` when the branch has no upstream yet). */
export const pushArgv = (upstream: string | undefined, branch: string): string[] =>
  upstream === undefined ? ['push', '--set-upstream', 'origin', branch] : ['push']

/** `git merge --no-edit <branch>` — merge without an editor for the merge message. */
export const mergeArgv = (branch: string): string[] => ['merge', '--no-edit', branch]

/** `git rebase <branch>` — replay the current branch onto another. */
export const rebaseArgv = (branch: string): string[] => ['rebase', branch]

/** `git merge --abort` — leave a conflicted merge. */
export const mergeAbortArgv = (): string[] => ['merge', '--abort']

/** `git rebase --abort` — leave a conflicted rebase. */
export const rebaseAbortArgv = (): string[] => ['rebase', '--abort']

/** Git markers whose presence means an operation is in progress. */
export const OPERATION_MARKERS = [
  'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG',
  'rebase-merge', 'rebase-apply', 'sequencer',
] as const

/**
 * `git rev-parse --git-path <marker>` — resolve ONE operation marker to its
 * on-disk path. The per-marker probe for the service's fallback when the
 * combined spawn fails.
 */
export const gitPathArgv = (marker: string): string[] => ['rev-parse', '--git-path', marker]

/**
 * `git rev-parse --git-path <marker>...` — resolve every operation-marker path
 * in ONE spawn (one `--git-path` option per marker; the option form is
 * repeatable, unlike positional paths). On Windows, where each git.exe cold
 * start costs about 0.7s, this replaces seven sequential probes with one
 * process.
 */
export const operationMarkersArgv = (): string[] => [
  'rev-parse',
  ...OPERATION_MARKERS.flatMap((marker) => ['--git-path', marker]),
]

/** stderr pattern → overwrite guard code, with the blocked-file extraction. */
interface OverwritePattern {
  code: Extract<GitErrorCode, 'tracked-changes-would-be-overwritten' | 'untracked-changes-would-be-overwritten'>
  header: RegExp
}

const OVERWRITE_PATTERNS: OverwritePattern[] = [
  {
    code: 'tracked-changes-would-be-overwritten',
    header: /Your local changes to the following files would be overwritten by checkout/,
  },
  {
    code: 'untracked-changes-would-be-overwritten',
    header: /The following untracked working tree files would be overwritten by checkout/,
  },
  {
    code: 'tracked-changes-would-be-overwritten',
    header: /Your local changes to the following files would be overwritten by merge/,
  },
]

const gitPathEncoder = new TextEncoder()
const gitPathDecoder = new TextDecoder()

/** The C-style escapes git uses besides the octal byte runs. */
const GIT_SIMPLE_ESCAPES: Record<string, number> = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11 }

/**
 * Decode one git-quoted path. Under the default `core.quotePath`, git escapes
 * every non-ASCII byte as octal — 'ä' arrives as \303\244 — so octal runs are
 * collected as bytes and decoded together as UTF-8. Decoding escape by escape
 * would pair the digits into mojibake instead of the original character.
 * @param input - a path with or without the surrounding quotes.
 * @returns the decoded path.
 */
function decodeGitQuoted(input: string): string {
  if (!input.includes('\\')) return input
  const bytes: number[] = []
  const pattern = /\\(?:([0-7]{3})|([\s\S]))/g
  let index = 0
  let match: RegExpExecArray | null
  while ((match = pattern.exec(input)) !== null) {
    bytes.push(...gitPathEncoder.encode(input.slice(index, match.index)))
    const octal = match[1]
    if (octal !== undefined) {
      bytes.push(Number.parseInt(octal, 8) & 0xff)
    } else {
      const escaped = match[2]!
      const control = GIT_SIMPLE_ESCAPES[escaped]
      if (control === undefined) bytes.push(...gitPathEncoder.encode(escaped))
      else bytes.push(control)
    }
    index = match.index + match[0].length
  }
  bytes.push(...gitPathEncoder.encode(input.slice(index)))
  return gitPathDecoder.decode(new Uint8Array(bytes))
}

/**
 * Extract the blocked-file list following an overwrite header: git indents
 * paths with a tab (quoted when they contain spaces); the trailing hint lines
 * ("Please commit your changes…") end the list.
 * @param stderr - the full git stderr.
 * @param header - the matched header regex.
 * @returns up to two file paths plus the count of remaining files.
 */
export function extractBlockedPaths(
  stderr: string,
  header: RegExp,
): { paths: string[]; moreFiles: number } {
  const start = stderr.indexOf('\n', stderr.search(header))
  if (start === -1) return { paths: [], moreFiles: 0 }
  const paths: string[] = []
  for (const line of stderr.slice(start + 1).split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '' || !line.startsWith('\t')) break
    const quoted = /^"(.+)"$/.exec(trimmed)
    const path = quoted === null ? decodeGitQuoted(trimmed) : decodeGitQuoted(quoted[1] ?? '')
    paths.push(path)
  }
  return { paths: paths.slice(0, 2), moreFiles: Math.max(0, paths.length - 2) }
}

/**
 * Classify a failed switch's stderr onto the stable error vocabulary.
 * @param stderr - git stderr from the failed switch.
 * @returns the classified error; `internal` when nothing matches.
 */
export function classifySwitchFailure(stderr: string): GitError {
  const head = stderr.trim().split('\n')[0] ?? stderr
  for (const pattern of OVERWRITE_PATTERNS) {
    if (pattern.header.test(stderr)) {
      const { paths, moreFiles } = extractBlockedPaths(stderr, pattern.header)
      return { code: pattern.code, message: head, paths, moreFiles }
    }
  }
  if (/did not match any file\(s\) known to git|invalid reference|not a valid branch/.test(stderr)) {
    return { code: 'target-branch-not-found', message: head }
  }
  if (/already used by worktree|is already checked out at/.test(stderr)) {
    return { code: 'branch-in-other-worktree', message: head }
  }
  return { code: 'internal', message: head || 'git switch failed' }
}

/**
 * Whether a client-supplied path may be handed to a git path mutation.
 *
 * This is a security boundary, not decoration: `git restore` and `git clean`
 * DELETE working-tree content, so a traversal or absolute path must be rejected
 * before it reaches argv. Only repo-relative, forward- or backslash-separated
 * paths without a `..` component are accepted.
 * @param path - the candidate path from the request body.
 */
export function isSafeRepoPath(path: string): boolean {
  if (path === '' || path.length > 4096) return false
  if (path.startsWith('/') || path.startsWith('\\')) return false
  // A Windows drive-absolute path (C:\…) or a UNC path (\\server\share).
  if (/^[a-zA-Z]:/.test(path)) return false
  if (path.includes('\u0000')) return false
  const components = path.split(/[\\/]/)
  return !components.includes('..')
}

/**
 * Pure mirror of `git check-ref-format --branch` short-name rules, for instant
 * feedback before a spawn; the host's check-ref-format call stays the
 * authoritative gate. Returns the reason when the name is invalid.
 * @param name - proposed branch name (short form, no refs/ prefix).
 * @returns null when valid, else a short reason.
 */
export function validateBranchName(name: string): string | null {
  if (name === '') return 'empty'
  if (name === '@') return 'at-sign'
  if (name.startsWith('-')) return 'leading-dash'
  if (name.endsWith('.')) return 'trailing-dot'
  if (name.endsWith('.lock')) return 'lock-suffix'
  if (name.includes('..')) return 'double-dot'
  if (name.includes('@{')) return 'at-brace'
  if (name.includes('//')) return 'double-slash'
  if (name.includes(' ')) return 'space'
  if (name.includes('~') || name.includes('^') || name.includes(':')) return 'forbidden-char'
  if (name.includes('?') || name.includes('*') || name.includes('[') || name.includes('\\')) return 'forbidden-char'
  for (const ch of name) {
    const code = ch.codePointAt(0)
    if (code !== undefined && (code < 0x20 || code === 0x7f)) return 'control-char'
  }
  for (const component of name.split('/')) {
    if (component === '') return 'empty-component'
    if (component.startsWith('.')) return 'dot-component'
    if (component.endsWith('.lock')) return 'lock-suffix'
  }
  if (name.length > 1000) return 'too-long'
  return null
}
