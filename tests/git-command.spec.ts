/**
 * Tests for the command vocabulary: the argv builders (every destructive verb
 * must carry its `--` separator), the path-safety gate that stands between an
 * HTTP body and `git restore`/`git clean`, the branch-name mirror, and the
 * switch-failure classifier with its blocked-file extraction.
 */
import { describe, expect, it } from 'vitest'
import {
  addArgv, classifySwitchFailure, cleanArgv, commitArgv, diffStatPatchArgv, discardRestoreArgv,
  extractBlockedPaths,
  isSafeRepoPath, rmCachedArgv, showPathPatchArgv, statusFilesArgv, statusV2Argv, switchArgv, unstageArgv,
  untrackedDiffArgv, validateBranchName,
} from '../src/core/git-command.ts'

describe('isSafeRepoPath', () => {
  it('accepts repo-relative paths, including awkward but legal names', () => {
    expect(isSafeRepoPath('a.txt')).toBe(true)
    expect(isSafeRepoPath('dir/sub/a.txt')).toBe(true)
    expect(isSafeRepoPath('dir\\sub\\a.txt')).toBe(true)
    expect(isSafeRepoPath(' leading.txt')).toBe(true)
    expect(isSafeRepoPath('we\nird.txt')).toBe(true)
  })

  it('rejects absolute, traversal, and control-character paths', () => {
    // These are the values that would otherwise reach `git restore`/`git clean`.
    expect(isSafeRepoPath('../escape.txt')).toBe(false)
    expect(isSafeRepoPath('a/../../b')).toBe(false)
    expect(isSafeRepoPath('..')).toBe(false)
    expect(isSafeRepoPath('/etc/passwd')).toBe(false)
    expect(isSafeRepoPath('\\server\\share')).toBe(false)
    expect(isSafeRepoPath('C:\\Windows\\system.ini')).toBe(false)
    expect(isSafeRepoPath('a\u0000b')).toBe(false)
    expect(isSafeRepoPath('')).toBe(false)
    expect(isSafeRepoPath('x'.repeat(4097))).toBe(false)
  })
})

describe('argv builders', () => {
  it('keeps a leading-dash path behind the `--` separator', () => {
    // Without `--` git would parse the path as an option.
    for (const argv of [
      addArgv(['-weird.txt']),
      unstageArgv(['-weird.txt']),
      rmCachedArgv(['-weird.txt']),
      cleanArgv(['-weird.txt']),
      discardRestoreArgv(['-weird.txt']),
    ]) {
      const separator = argv.indexOf('--')
      expect(separator).toBeGreaterThan(-1)
      expect(argv.indexOf('-weird.txt')).toBe(separator + 1)
    }
  })

  it('forces -z on the file-level status read', () => {
    // Without -z git C-quotes paths and newline-separates records, which the
    // positional parser cannot read.
    expect(statusFilesArgv()).toContain('-z')
  })

  it('asks for one commit file behind the path separator', () => {
    // The per-file route exists because the commit-wide patch is capped: this call
    // is not, so a file reads whole however big the commit around it is. The `--`
    // is what keeps a leading-dash path from being read as an option.
    expect(showPathPatchArgv('abc1234', 'src/a.ts')).toEqual([
      '-c', 'core.quotePath=false',
      'show', '--patch', '--no-color', '--no-ext-diff', '--format=', 'abc1234', '--', 'src/a.ts',
    ])
  })

  it('uses the null device form that needs no index mutation for an untracked diff', () => {
    // The `-c core.quotePath=false` prefix is what keeps a header's path the real
    // one when it holds a non-ASCII byte.
    expect(untrackedDiffArgv('new.txt')).toEqual([
      '-c', 'core.quotePath=false',
      'diff', '--no-index', '--no-color', '--no-ext-diff', '--', '/dev/null', 'new.txt',
    ])
  })

  it('carries the branch facts in the file-list call', () => {
    // --branch is what folds the branch, its tip, its upstream and the ahead/behind
    // counts into the same spawn as the files: four probes and a second round trip
    // become one call.
    expect(statusV2Argv()).toEqual(['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all'])
  })

  it('switches with --no-guess so a name never resolves to a remote branch', () => {
    expect(switchArgv('main')).toEqual(['switch', '--no-guess', '--', 'main'])
  })

  it('amends only when asked', () => {
    expect(commitArgv('msg', false)).toEqual(['commit', '-m', 'msg'])
    expect(commitArgv('msg', true)).toEqual(['commit', '--amend', '-m', 'msg'])
  })

  it('reads the counts and the patch of one side in a single call', () => {
    // One walk of the trees answers both halves: the records `parseStatPatch` reads
    // off the front, and the patch that follows them.
    expect(diffStatPatchArgv(false)).toEqual([
      '-c', 'core.quotePath=false', 'diff', '--numstat', '-z', '--no-renames', '-p',
    ])
    expect(diffStatPatchArgv(true)).toEqual([
      '-c', 'core.quotePath=false', 'diff', '--numstat', '-z', '--no-renames', '-p', '--cached',
    ])
  })
})

describe('validateBranchName', () => {
  it('accepts ordinary names and rejects the shapes git refuses', () => {
    expect(validateBranchName('feature/x-1.2')).toBeNull()
    expect(validateBranchName('')).toBe('empty')
    expect(validateBranchName('-dash')).toBe('leading-dash')
    expect(validateBranchName('bad name')).toBe('space')
    expect(validateBranchName('a..b')).toBe('double-dot')
    expect(validateBranchName('a@{b')).toBe('at-brace')
    expect(validateBranchName('a//b')).toBe('double-slash')
    expect(validateBranchName('.hidden')).toBe('dot-component')
    expect(validateBranchName('trailing.')).toBe('trailing-dot')
    expect(validateBranchName('x.lock')).toBe('lock-suffix')
    expect(validateBranchName('a^b')).toBe('forbidden-char')
  })
})

describe('classifySwitchFailure', () => {
  const overwriteStderr = [
    'error: Your local changes to the following files would be overwritten by checkout:',
    '\tfile one.txt',
    '\tfile two.txt',
    '\tfile three.txt',
    'Please commit your changes or stash them before you switch branches.',
  ].join('\n')

  it('extracts the blocked files and caps the list at two', () => {
    const { paths, moreFiles } = extractBlockedPaths(
      overwriteStderr,
      /Your local changes to the following files would be overwritten by checkout/,
    )
    expect(paths).toEqual(['file one.txt', 'file two.txt'])
    expect(moreFiles).toBe(1)
  })

  it('maps the overwrite header onto the stable code', () => {
    expect(classifySwitchFailure(overwriteStderr)).toMatchObject({
      code: 'tracked-changes-would-be-overwritten',
      paths: ['file one.txt', 'file two.txt'],
      moreFiles: 1,
    })
  })

  it('maps a missing branch, a worktree collision, and the unknown case', () => {
    expect(classifySwitchFailure('fatal: invalid reference: nope').code).toBe('target-branch-not-found')
    expect(classifySwitchFailure("fatal: 'x' is already checked out at '/tmp/x'").code).toBe('branch-in-other-worktree')
    expect(classifySwitchFailure('something else entirely')).toMatchObject({ code: 'internal' })
  })
})
