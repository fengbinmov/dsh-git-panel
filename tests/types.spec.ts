/**
 * Tests for the wire vocabulary's pure parsers and guards. These run against
 * hand-written git output rather than a live repository, so they can pin the
 * exact awkward cases (NUL-separated rename records, paths with spaces and
 * newlines) that a real repository would rarely produce on demand.
 */
import { describe, expect, it } from 'vitest'
import {
  isBinaryPatch, isCommitDiff, isStatusFilesView, operationNameFromMarkers, parseAheadBehind, parseBranches,
  parseHistory, parseNumstat, parseRemotes, parseShowMeta, parseStatPatch, parseStatusV2,
  predictCommitted, predictDiscarded, predictLineSelection, predictStaged, withLineStats,
  type FileChange, type StatusFilesView,
} from '../src/core/types.ts'

const NUL = '\u0000'
const ZERO = '0'.repeat(40)

describe('isCommitDiff', () => {
  it('accepts one file\'s patch and rejects a half-built view', () => {
    // The route boundary runs this before the answer reaches the browser, so a
    // malformed one is refused rather than rendered as a file with no rows.
    expect(isCommitDiff({ path: 'a.txt', binary: false, truncated: false, patch: 'diff --git a/a.txt b/a.txt' })).toBe(true)
    // The per-file view carries no `staged` field: a commit file is not a side of
    // the index, and a payload claiming to be one side is not this shape.
    expect(isCommitDiff({ path: 'a.txt', staged: false, binary: false, truncated: false, patch: '' })).toBe(true)
    expect(isCommitDiff({ path: 'a.txt', binary: false, truncated: false })).toBe(false)
    expect(isCommitDiff({ path: 'a.txt', binary: false, truncated: 'no', patch: '' })).toBe(false)
    expect(isCommitDiff(null)).toBe(false)
    expect(isCommitDiff('a.txt')).toBe(false)
  })
})

/**
 * One porcelain v2 record for an ordinary (non-rename) path. The record shape is
 * `1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>`, so the path is the NINTH field —
 * which is the whole reason the parser counts fields instead of splitting on the
 * first space.
 */
const v2 = (xy: string, path: string): string => `1 ${xy} N... 100644 100644 100644 ${ZERO} ${ZERO} ${path}`

/**
 * Expand one compact `<XY> <path>` shorthand into a real porcelain v2 record, so
 * the call sites below stay readable while the PARSER stays the thing under test.
 */
function expand(record: string): string {
  // v2 spells "this side did not move" as '.', where the shorthand (and v1) use a
  // space — and a literal space inside the XY field would break the record's own
  // field splitting.
  const xy = record.slice(0, 2).replace(/ /g, '.')
  const path = record.slice(3)
  if (xy === '??') return `? ${path}`
  if (xy === 'UU') return `u UU N... 100644 100644 100644 100644 ${ZERO} ${ZERO} ${ZERO} ${path}`
  return v2(xy, path)
}

/** The parsed rows of a compact record list. */
function filesOf(...records: string[]): FileChange[] {
  return parseStatusV2(records.map(record => `${expand(record)}${NUL}`).join('')).files
}

/** A status view built from real porcelain records, through the real parser. */
function viewOf(...records: string[]): StatusFilesView {
  const parsed = parseStatusV2(records.map(record => `${expand(record)}${NUL}`).join(''))
  const files = parsed.files
  return {
    root: '/repo',
    branch: 'main',
    head: 'a'.repeat(40),
    files,
    stagedCount: files.filter(file => file.staged).length,
    unstagedCount: files.filter(file => !file.untracked && !file.conflicted && file.worktree !== ' ').length,
    untrackedCount: files.filter(file => file.untracked).length,
    conflictedCount: files.filter(file => file.conflicted).length,
    operationInProgress: false,
    operation: '',
    upstream: 'origin/main',
    behind: 0,
    ahead: 0,
    patches: { worktree: '', staged: '', truncated: false },
  }
}

/** One file's sides, as a compact string the assertions can read at a glance. */
function sidesOf(view: StatusFilesView, path: string): string {
  const file = view.files.find(entry => entry.path === path)
  return file === undefined ? 'absent' : `${file.index}${file.worktree}`
}

describe('predictStaged', () => {
  it('moves a worktree change into the index', () => {
    const view = viewOf(' M a.txt')
    const next = predictStaged(view, ['a.txt'], true)
    expect(sidesOf(next, 'a.txt')).toBe('M ')
    expect(next.stagedCount).toBe(1)
    expect(next.unstagedCount).toBe(0)
  })

  it('turns an untracked file into an addition', () => {
    const next = predictStaged(viewOf('?? n.txt'), ['n.txt'], true)
    expect(sidesOf(next, 'n.txt')).toBe('A ')
    expect(next.untrackedCount).toBe(0)
    expect(next.stagedCount).toBe(1)
  })

  it('takes the whole path, including a further edit on top of an addition', () => {
    // 'AM' is staged as an addition and edited again: staging finishes the job,
    // so the index keeps the A and the worktree side goes clean.
    expect(sidesOf(predictStaged(viewOf('AM a.txt'), ['a.txt'], true), 'a.txt')).toBe('A ')
    expect(sidesOf(predictStaged(viewOf('MM a.txt'), ['a.txt'], true), 'a.txt')).toBe('M ')
    expect(sidesOf(predictStaged(viewOf(' D a.txt'), ['a.txt'], true), 'a.txt')).toBe('D ')
  })

  it('returns the index side to the worktree when unstaging', () => {
    expect(sidesOf(predictStaged(viewOf('M  a.txt'), ['a.txt'], false), 'a.txt')).toBe(' M')
    expect(sidesOf(predictStaged(viewOf('D  a.txt'), ['a.txt'], false), 'a.txt')).toBe(' D')
    // Already staged and modified: unstaging leaves the worktree edit pending.
    expect(sidesOf(predictStaged(viewOf('MM a.txt'), ['a.txt'], false), 'a.txt')).toBe(' M')
  })

  it('sends an unstaged addition back to untracked', () => {
    // An addition has no HEAD entry to return to, which is exactly why the host
    // must not be asked to `git reset HEAD --` a path it cannot resolve.
    const next = predictStaged(viewOf('A  a.txt'), ['a.txt'], false)
    expect(sidesOf(next, 'a.txt')).toBe('??')
    expect(next.untrackedCount).toBe(1)
    expect(next.stagedCount).toBe(0)
  })

  it('leaves a conflict alone, whichever verb was asked for', () => {
    // A conflict has no staging verb; resolving it is not a status flip.
    expect(sidesOf(predictStaged(viewOf('UU c.txt'), ['c.txt'], true), 'c.txt')).toBe('UU')
    expect(sidesOf(predictStaged(viewOf('UU c.txt'), ['c.txt'], false), 'c.txt')).toBe('UU')
  })

  it('touches only the paths it was given, and nothing at all for none', () => {
    const view = viewOf(' M a.txt', ' M b.txt')
    expect(predictStaged(view, ['a.txt'], true).files.map(file => file.path)).toEqual(['a.txt', 'b.txt'])
    expect(sidesOf(predictStaged(view, ['a.txt'], true), 'b.txt')).toBe(' M')
    expect(predictStaged(view, [], true)).toBe(view)
  })
})

describe('predictDiscarded', () => {
  it('removes an untracked file and a worktree-only change', () => {
    expect(predictDiscarded(viewOf('?? n.txt', ' M a.txt'), ['n.txt', 'a.txt']).files).toEqual([])
  })

  it('keeps the index side when the worktree side is discarded', () => {
    expect(sidesOf(predictDiscarded(viewOf('AM a.txt'), ['a.txt']), 'a.txt')).toBe('A ')
    expect(sidesOf(predictDiscarded(viewOf('MM a.txt'), ['a.txt']), 'a.txt')).toBe('M ')
  })

  it('leaves a conflict to the host', () => {
    expect(sidesOf(predictDiscarded(viewOf('UU c.txt'), ['c.txt']), 'c.txt')).toBe('UU')
  })
})

describe('predictCommitted', () => {
  it('clears the index and keeps a path whose worktree also moved', () => {
    const next = predictCommitted(viewOf('M  a.txt', 'MM b.txt', '?? n.txt'))
    expect(next.files.map(file => `${file.path}:${file.index}${file.worktree}`)).toEqual(['b.txt: M', 'n.txt:??'])
    expect(next.stagedCount).toBe(0)
    expect(next.unstagedCount).toBe(1)
  })
})

describe('parseStatusV2', () => {
  it('reads the branch header and the file records out of one stream', () => {
    // The whole point of v2: branch, tip, upstream and ahead/behind travel WITH
    // the file list, so the panel needs one status spawn instead of five probes.
    const status = parseStatusV2([
      `# branch.oid ${ZERO}${NUL}`,
      `# branch.head main${NUL}`,
      `# branch.upstream origin/main${NUL}`,
      '# branch.ab +3 -2\u0000',
      `${v2('.M', 'a.txt')}${NUL}`,
      `${v2('A.', 'b.txt')}${NUL}`,
      `${v2('MM', 'c.txt')}${NUL}`,
      `${v2('.D', 'd.txt')}${NUL}`,
      `? e.txt${NUL}`,
      `u UU N... 100644 100644 100644 100644 ${ZERO} ${ZERO} ${ZERO} f.txt${NUL}`,
    ].join(''))
    expect(status).toMatchObject({ branch: 'main', head: ZERO, upstream: 'origin/main', ahead: 3, behind: 2 })
    const byPath = new Map(status.files.map(file => [file.path, file]))
    expect(byPath.get('a.txt')).toMatchObject({ index: ' ', worktree: 'M', staged: false, kind: 'modified' })
    expect(byPath.get('b.txt')).toMatchObject({ index: 'A', worktree: ' ', staged: true, kind: 'added' })
    // Staged AND further modified: one record carrying both sides.
    expect(byPath.get('c.txt')).toMatchObject({ index: 'M', worktree: 'M', staged: true, kind: 'modified' })
    expect(byPath.get('d.txt')).toMatchObject({ worktree: 'D', kind: 'deleted', staged: false })
    expect(byPath.get('e.txt')).toMatchObject({ kind: 'untracked', untracked: true, staged: false })
    expect(byPath.get('f.txt')).toMatchObject({ kind: 'conflicted', conflicted: true, staged: false })
  })

  it('reports an unborn branch and a detached head as no branch', () => {
    const unborn = parseStatusV2(`# branch.oid (initial)${NUL}# branch.head main${NUL}`)
    expect(unborn).toMatchObject({ head: '', branch: 'main' })
    const detached = parseStatusV2(`# branch.oid ${ZERO}${NUL}# branch.head (detached)${NUL}`)
    expect(detached.branch).toBe('')
  })

  it('consumes the extra origin field a rename record carries', () => {
    // A type-2 record ends at the path and the origin path is the NEXT field: a
    // read that ignored it would turn 'old.txt' into a bogus row.
    const status = parseStatusV2([
      `2 R. N... 100644 100644 100644 ${ZERO} ${ZERO} R100 new.txt${NUL}`,
      `old.txt${NUL}`,
      `${v2('.M', 'after.txt')}${NUL}`,
    ].join(''))
    expect(status.files).toHaveLength(2)
    expect(status.files[0]).toMatchObject({ path: 'new.txt', origPath: 'old.txt', kind: 'renamed', staged: true })
    expect(status.files[1]).toMatchObject({ path: 'after.txt', kind: 'modified' })
  })

  it('keeps paths that contain spaces and newlines verbatim', () => {
    const status = parseStatusV2([`${v2('.M', ' leading.txt')}${NUL}`, `? we${'\n'}ird.txt${NUL}`].join(''))
    expect(status.files.map(file => file.path)).toEqual([' leading.txt', 'we\nird.txt'])
  })

  it('ignores the trailing empty field', () => {
    expect(parseStatusV2(NUL).files).toEqual([])
    expect(parseStatusV2('').files).toEqual([])
  })
})

describe('parseStatPatch', () => {
  it('reads the counts off the front and treats the rest as the patch', () => {
    // `git diff --numstat -p` writes the records, one spare NUL, then the patch:
    // both halves of the answer from one walk of the trees.
    const stream = `2\t1\ta.txt${NUL}-\t-\timg.png${NUL}${NUL}diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n`
    const { stats, patch } = parseStatPatch(stream)
    expect(stats).toEqual([
      { path: 'a.txt', additions: 2, deletions: 1, binary: false },
      { path: 'img.png', additions: 0, deletions: 0, binary: true },
    ])
    expect(patch.startsWith('diff --git a/a.txt b/a.txt')).toBe(true)
  })

  it('treats a stream with no records as patch alone, and no patch as records alone', () => {
    expect(parseStatPatch('diff --git a/x b/x\n').patch).toBe('diff --git a/x b/x\n')
    expect(parseStatPatch(`1\t0\tx.txt${NUL}`).patch).toBe('')
    expect(parseStatPatch('')).toEqual({ stats: [], patch: '' })
  })

  it('keeps a path containing a tab or a newline intact', () => {
    // Only the first two tabs separate the fields; everything after is the path.
    const { stats } = parseStatPatch(`1\t2\ttab\there.txt${NUL}3\t4\tnew\nline.txt${NUL}`)
    expect(stats.map(stat => stat.path)).toEqual(['tab\there.txt', 'new\nline.txt'])
  })
})

describe('predictLineSelection', () => {
  /** A row carrying counts on the side it lists. */
  const counted = (record: string, additions: number, deletions: number): FileChange => {
    const file = filesOf(record)[0]
    if (file === undefined) throw new Error('no file')
    if (file.untracked) return file
    return file.staged
      ? { ...file, indexStat: { additions, deletions } }
      : { ...file, worktreeStat: { additions, deletions } }
  }
  const viewWith = (...files: FileChange[]): StatusFilesView => ({ ...viewOf(), files })

  it('moves the chosen counts from the worktree side to the index', () => {
    const next = predictLineSelection(
      viewWith(counted(' M a.txt', 4, 2)), 'a.txt', { additions: 1, deletions: 1 }, 'stage')
    const file = next.files[0]
    expect(file?.worktreeStat).toEqual({ additions: 3, deletions: 1 })
    expect(file?.indexStat).toEqual({ additions: 1, deletions: 1 })
    expect(file?.index).toBe('M')
    expect(file?.staged).toBe(true)
  })

  it('clears the side whose counts were all chosen', () => {
    const next = predictLineSelection(
      viewWith(counted(' M a.txt', 2, 0)), 'a.txt', { additions: 2, deletions: 0 }, 'stage')
    expect(next.files[0]?.worktree).toBe(' ')
    expect(next.files[0]?.worktreeStat).toBeUndefined()
    // Nothing is pending any more, so the pending region's own total drops with it.
    expect(next.unstagedCount).toBe(0)
  })

  it('takes a chosen line back out of the index', () => {
    const next = predictLineSelection(
      viewWith(counted('M  a.txt', 5, 3)), 'a.txt', { additions: 2, deletions: 1 }, 'unstage')
    expect(next.files[0]?.indexStat).toEqual({ additions: 3, deletions: 2 })
    expect(next.files[0]?.worktreeStat).toEqual({ additions: 2, deletions: 1 })
    expect(next.files[0]?.worktree).toBe('M')
  })

  it('leaves a staged addition untracked once all of it is unstaged', () => {
    const next = predictLineSelection(
      viewWith(counted('A  a.txt', 3, 0)), 'a.txt', { additions: 3, deletions: 0 }, 'unstage')
    expect(next.files[0]).toMatchObject({ index: '?', worktree: '?', untracked: true, staged: false })
  })

  it('returns the chosen worktree changes to the index on a discard', () => {
    const next = predictLineSelection(
      viewWith(counted(' M a.txt', 4, 3)), 'a.txt', { additions: 1, deletions: 2 }, 'discard')
    expect(next.files[0]?.worktreeStat).toEqual({ additions: 3, deletions: 1 })
    expect(next.files[0]?.indexStat).toBeUndefined()
    expect(next.files[0]?.index).toBe(' ')
  })

  it('touches only the path it was given', () => {
    const view = viewWith(counted(' M a.txt', 4, 2), counted(' M b.txt', 1, 1))
    const next = predictLineSelection(view, 'a.txt', { additions: 1, deletions: 1 }, 'stage')
    expect(next.files[1]?.worktreeStat).toEqual({ additions: 1, deletions: 1 })
    expect(predictLineSelection(view, 'missing.txt', { additions: 1, deletions: 0 }, 'stage')).toBe(view)
  })
})

describe('parseBranches', () => {
  it('marks the current branch and sorts by name', () => {
    const rows = parseBranches(`zeta${NUL} ${NUL}aaa${NUL}\nalpha${NUL}*${NUL}bbb${NUL}\n`)
    expect(rows).toEqual([
      { name: 'alpha', current: true },
      { name: 'zeta', current: false },
    ])
  })
})

describe('parseHistory', () => {
  it('strips the leading newline tformat leaves and decodes decorations', () => {
    const first = `o1${NUL}s1${NUL}p1 p2${NUL}Ann${NUL}a@x${NUL}1700000000${NUL}HEAD -> main, tag: v1${NUL}first subject`
    const second = `o2${NUL}s2${NUL}${NUL}Bob${NUL}b@x${NUL}1699999999${NUL}${NUL}second subject`
    const commits = parseHistory(`${first}\u001e\n${second}\u001e\n`)
    expect(commits).toHaveLength(2)
    expect(commits[0]).toMatchObject({
      oid: 'o1', shortOid: 's1', parents: ['p1', 'p2'], author: 'Ann', authorEmail: 'a@x',
      authorTime: 1700000000, refs: ['main', 'v1'], subject: 'first subject',
    })
    expect(commits[1]).toMatchObject({ parents: [], refs: [], subject: 'second subject' })
  })
})

describe('parseShowMeta', () => {
  it('splits metadata from the trimmed body', () => {
    const meta = parseShowMeta(`o1${NUL}s1${NUL}p1${NUL}Ann${NUL}a@x${NUL}1700000000${NUL}Com${NUL}1700000001${NUL}subject${NUL}line one\nline two\n`)
    expect(meta).toMatchObject({
      oid: 'o1', shortOid: 's1', parents: ['p1'], subject: 'subject', body: 'line one\nline two',
      author: 'Ann', committer: 'Com', committerTime: 1700000001,
    })
  })

  it('returns null for an empty reading', () => {
    expect(parseShowMeta('')).toBeNull()
  })
})

describe('parseNumstat', () => {
  it('reads text and binary records', () => {
    expect(parseNumstat(`1\t2\ta.txt${NUL}-\t-\timg.png${NUL}`)).toEqual([
      { path: 'a.txt', additions: 1, deletions: 2, binary: false },
      { path: 'img.png', additions: 0, deletions: 0, binary: true },
    ])
  })
})

describe('withLineStats', () => {
  const stat = (path: string, additions: number, deletions: number) =>
    ({ path, additions, deletions, binary: false })

  it('gives each side of one path its own counts', () => {
    // A path both staged and edited again is ONE record whose two rows stand for
    // two different changes, so the pairs are kept per side rather than flattened.
    const files = filesOf('MM a.txt', ' M b.txt')
    const [a, b] = withLineStats(files, [stat('a.txt', 2, 1), stat('b.txt', 5, 0)], [stat('a.txt', 9, 4)])
    expect(a).toMatchObject({ worktreeStat: { additions: 2, deletions: 1 }, indexStat: { additions: 9, deletions: 4 } })
    expect(b).toMatchObject({ worktreeStat: { additions: 5, deletions: 0 } })
    expect(b?.indexStat).toBeUndefined()
  })

  it('leaves a row with no record without counts', () => {
    const files = filesOf('?? new.txt', ' M gone.txt')
    const [untracked, missing] = withLineStats(files, [], [])
    expect(untracked.worktreeStat).toBeUndefined()
    expect(untracked.indexStat).toBeUndefined()
    expect(missing.worktreeStat).toBeUndefined()
  })

  it('leaves a conflict without counts even though git reports one', () => {
    // `git diff --numstat` answers an unmerged path with a COMBINED diff against
    // both sides of the merge, emitted as two records (measured: `0 0 f` and
    // `4 0 f` for one conflicted file). Neither is the change the row stands for.
    const files = filesOf('UU f.txt')
    const [conflict] = withLineStats(files, [stat('f.txt', 0, 0), stat('f.txt', 4, 0)], [stat('f.txt', 0, 0)])
    expect(conflict.worktreeStat).toBeUndefined()
    expect(conflict.indexStat).toBeUndefined()
  })

  it('carries the counts across a staging prediction', () => {
    // Staging a pending change puts exactly those changes into the index, so the
    // numbers the row showed stay right until the next refresh replaces them.
    const files = withLineStats(filesOf(' M a.txt'), [stat('a.txt', 3, 1)], [])
    const predicted = predictStaged({ ...viewOf(' M a.txt'), files }, ['a.txt'], true)
    expect(predicted.files[0]).toMatchObject({
      worktreeStat: { additions: 3, deletions: 1 },
      staged: true,
    })
  })
})

describe('parseRemotes', () => {
  it('pairs the fetch and push URLs of each remote', () => {
    const rows = parseRemotes([
      'origin\thttps://example.com/a.git (fetch)',
      'origin\thttps://example.com/a.git (push)',
      'upstream\tgit@example.com:b.git (fetch)',
      'upstream\tgit@example.com:b.git (push)',
      '',
    ].join('\n'))
    expect(rows).toEqual([
      { name: 'origin', fetchUrl: 'https://example.com/a.git', pushUrl: 'https://example.com/a.git' },
      { name: 'upstream', fetchUrl: 'git@example.com:b.git', pushUrl: 'git@example.com:b.git' },
    ])
  })

  it('degrades to an empty list on unrelated output', () => {
    expect(parseRemotes('')).toEqual([])
  })
})

describe('parseAheadBehind', () => {
  it('reads the behind/ahead pair in rev-list order', () => {
    expect(parseAheadBehind('2\t3\n')).toEqual({ ahead: 3, behind: 2 })
    expect(parseAheadBehind('')).toEqual({ ahead: 0, behind: 0 })
  })
})

describe('operationNameFromMarkers', () => {
  it('names the operation, mapping both rebase layouts onto one word', () => {
    expect(operationNameFromMarkers(['rebase-merge'])).toBe('rebase')
    expect(operationNameFromMarkers(['rebase-apply'])).toBe('rebase')
    expect(operationNameFromMarkers(['MERGE_HEAD'])).toBe('merge')
    expect(operationNameFromMarkers(['CHERRY_PICK_HEAD'])).toBe('cherry-pick')
    expect(operationNameFromMarkers([])).toBe('')
  })
})

describe('isBinaryPatch', () => {
  it('recognizes both binary diff shapes', () => {
    expect(isBinaryPatch('Binary files a/x.png and b/x.png differ')).toBe(true)
    expect(isBinaryPatch('GIT binary patch\nliteral 12')).toBe(true)
    expect(isBinaryPatch('@@ -1 +1 @@\n-a\n+b')).toBe(false)
  })

  it('does not call a patch binary for MENTIONING a marker', () => {
    // The regression this exists for: previewing GitView.tsx reported it as binary,
    // because the patch under review added the very line that spells the marker out.
    // Every patch body line carries a `+`, `-` or space marker, so the markers are
    // only markers at the start of a line.
    const quoting = [
      'diff --git a/GitView.tsx b/GitView.tsx',
      '--- a/GitView.tsx',
      '+++ b/GitView.tsx',
      '@@ -1,2 +1,3 @@',
      "+\t\tbinary: section.includes('Binary files ') || section.includes('GIT binary patch'),",
      "-\treturn /^Binary files .* differ$/m.test(patch) || patch.includes('GIT binary patch')",
      ' GIT binary patch',
    ].join('\n')
    expect(isBinaryPatch(quoting)).toBe(false)
    // ...while git's own marker line, at column 0, still counts.
    expect(isBinaryPatch(`${quoting}\nBinary files a/x.bin and b/x.bin differ`)).toBe(true)
  })
})

describe('isStatusFilesView', () => {
  it('accepts a well-formed view and rejects a partial one', () => {
    const view = {
      root: '/r', branch: 'main', head: 'abc', files: [], stagedCount: 0, unstagedCount: 0,
      untrackedCount: 0, conflictedCount: 0, operationInProgress: false, operation: '',
      upstream: '', ahead: 0, behind: 0,
    }
    expect(isStatusFilesView(view)).toBe(true)
    expect(isStatusFilesView({ ...view, files: [{ path: 1 }] })).toBe(false)
    expect(isStatusFilesView({ ...view, ahead: '1' })).toBe(false)
    expect(isStatusFilesView(null)).toBe(false)
  })
})
