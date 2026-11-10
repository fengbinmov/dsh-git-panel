/**
 * Integration tests for the git service over the REAL git binary in temp
 * repositories: the file-level status view, the branch list and switch, index
 * and commit mutations, discard (including its untracked bucketing), diffs,
 * history and commit detail, the remote verbs against a local bare remote,
 * merge/rebase with their conflict paths, the stream probes, and the
 * path/workspace gates.
 */
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  COMMIT_DETAIL_MAX_CHANGED_LINES, COMMIT_DETAIL_MAX_FILES, GitService, gitSpawnArgv, shouldSkipCommitPatch,
  type GitRunner, type GitRunResult, type WorkspaceGate,
} from '../src/host/git-service.ts'
import type { CommitFileStat } from '../src/core/types.ts'

const execFileAsync = promisify(execFile)

/** Plain child_process runner standing in for the subprocess seam. */
const runner: GitRunner = {
  async run(argv: readonly string[], cwd: string): Promise<GitRunResult> {
    try {
      const { stdout, stderr } = await execFileAsync('git', [...argv], {
        cwd, encoding: 'utf8', maxBuffer: 1 << 20,
      })
      return { exitCode: 0, stdout, stderr }
    } catch (error) {
      const failure = error as { code?: number; stdout?: string; stderr?: string }
      return { exitCode: failure.code ?? 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' }
    }
  },
}

/** Gate that admits exactly the seeded roots (it stands in for the realpath gate). */
function allowGate(...paths: string[]): WorkspaceGate {
  const allowed = new Set(paths)
  return async (path) => {
    if (!allowed.has(path)) {
      return { ok: false, error: { code: 'workspace-unknown', message: 'not a workspace' } }
    }
    return { ok: true, canonical: path }
  }
}

/** Run one git command with an explicit identity (init/clone/add/commit helpers). */
async function git(repo: string, ...args: string[]): Promise<GitRunResult> {
  return runner.run(['-c', 'user.email=test@dsh.local', '-c', 'user.name=Test', ...args], repo)
}

/**
 * Read a worktree file with line endings normalized. Git for Windows checks out
 * CRLF under the common `core.autocrlf=true`, so asserting raw bytes would make
 * these tests depend on the host's git configuration.
 */
async function readText(path: string): Promise<string> {
  return (await readFile(path, 'utf8')).replace(/\r\n/g, '\n')
}

describe('gitSpawnArgv', () => {
  it('names git.exe on win32 so a .cmd shim can never be the resolution target', () => {
    expect(gitSpawnArgv('win32', ['status'])).toEqual(['git.exe', 'status'])
    expect(gitSpawnArgv('linux', ['status'])).toEqual(['git', 'status'])
  })
})

describe('GitService', () => {
  let root: string
  let repo: string
  let service: GitService

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-git-panel-'))
    repo = join(root, 'repo')
    await mkdir(repo)
    await git(repo, 'init', '-b', 'main')
    // The SERVICE's own commits carry no -c overrides, so the identity has to
    // live in the repository config.
    await git(repo, 'config', 'user.email', 'test@dsh.local')
    await git(repo, 'config', 'user.name', 'Test')
    // Same reason for the pull policy: modern git refuses a diverged pull
    // unless the repository (or the machine's global config) says how to
    // reconcile, so without this the remotes test passes only on machines
    // that happen to have pull.rebase set.
    await git(repo, 'config', 'pull.rebase', 'false')
    await writeFile(join(repo, 'a.txt'), 'one\n')
    await git(repo, 'add', '.')
    await git(repo, 'commit', '-m', 'initial')
    service = new GitService(runner, allowGate(repo))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  describe('statusFiles', () => {
    it('reports each side of the worktree state', async () => {
      await writeFile(join(repo, 'a.txt'), 'two\n')
      await writeFile(join(repo, 'new.txt'), 'n\n')
      await writeFile(join(repo, 'staged.txt'), 's\n')
      await git(repo, 'add', 'staged.txt')

      const view = await service.statusFiles(repo)
      expect(view).not.toBeNull()
      if (view === null) return
      const byPath = new Map(view.files.map(file => [file.path, file]))
      expect(byPath.get('a.txt')).toMatchObject({ worktree: 'M', staged: false, kind: 'modified' })
      expect(byPath.get('new.txt')).toMatchObject({ kind: 'untracked', untracked: true })
      expect(byPath.get('staged.txt')).toMatchObject({ kind: 'added', staged: true })
      expect(view.stagedCount).toBe(1)
      expect(view.unstagedCount).toBe(1)
      expect(view.untrackedCount).toBe(1)
      expect(view.conflictedCount).toBe(0)
      expect(view.branch).toBe('main')
      expect(view.upstream).toBe('')
      expect(view.ahead).toBe(0)
      expect(view.behind).toBe(0)
      expect(view.operationInProgress).toBe(false)
      expect(view.operation).toBe('')
    })

    it('returns null for a path outside the workspace registry', async () => {
      const outside = join(root, 'outside')
      await mkdir(outside)
      expect(await service.statusFiles(outside)).toBeNull()
    })

    it('counts every row against its own side of the index boundary', async () => {
      // a.txt: lines appended in the worktree only.
      // both.txt: three lines staged, then one more edited afterwards, so the two
      // rows of that one path stand for different changes.
      await writeFile(join(repo, 'a.txt'), 'one\ntwo changed\nthree\n')
      await writeFile(join(repo, 'both.txt'), 'x\ny\nz\n')
      await git(repo, 'add', 'both.txt')
      await writeFile(join(repo, 'both.txt'), 'x\ny\nz\nw\n')
      await writeFile(join(repo, 'untracked.txt'), 'u\n')

      const view = await service.statusFiles(repo)
      if (view === null) throw new Error('no view')
      // The expectation is git's own answer for the same two commands: this pins
      // the WIRING (each row against its own side) rather than a line count that
      // would move with the fixture.
      const countsFrom = async (staged: boolean): Promise<Map<string, { additions: number; deletions: number }>> => {
        const argv = ['diff', '--numstat', '--no-renames', ...(staged ? ['--cached'] : [])]
        const { stdout } = await git(repo, ...argv)
        return new Map(stdout.split('\n').filter(line => line !== '').map((line) => {
          const [adds, dels, ...rest] = line.split('\t')
          return [rest.join('\t').trim(), { additions: Number(adds), deletions: Number(dels) }]
        }))
      }
      const pending = await countsFrom(false)
      const index = await countsFrom(true)
      const byPath = new Map(view.files.map(file => [file.path, file]))

      const a = pending.get('a.txt')
      expect(a?.additions).toBeGreaterThan(0)
      expect(byPath.get('a.txt')?.worktreeStat).toMatchObject(a ?? {})
      // One path, both sides moved, and each side keeps its OWN pair.
      expect(byPath.get('both.txt')?.indexStat).toMatchObject(index.get('both.txt') ?? {})
      expect(byPath.get('both.txt')?.worktreeStat).toMatchObject(pending.get('both.txt') ?? {})
      expect(byPath.get('both.txt')?.worktreeStat).not.toEqual(byPath.get('both.txt')?.indexStat)
      // An untracked path is in no diff, so it carries no counts at all.
      const untrackedRow = byPath.get('untracked.txt')
      expect(untrackedRow?.worktreeStat).toBeUndefined()
      expect(untrackedRow?.indexStat).toBeUndefined()
    })
  })

  describe('branches and switch', () => {
    it('lists local branches, marks the current one, and switches for real', async () => {
      await git(repo, 'branch', 'feature/x')
      const before = await service.branches(repo)
      expect(before?.branch).toBe('main')
      expect(before?.branches).toEqual([
        { name: 'feature/x', current: false },
        { name: 'main', current: true },
      ])

      expect(await service.switchBranch(repo, 'feature/x')).toEqual({ ok: true, branch: 'feature/x' })
      expect((await service.branches(repo))?.branch).toBe('feature/x')
      // Switching to the branch already checked out is a no-op success.
      expect(await service.switchBranch(repo, 'feature/x')).toEqual({ ok: true, branch: 'feature/x' })
    })

    it('rejects a missing target and an invalid name', async () => {
      expect(await service.switchBranch(repo, 'nope')).toMatchObject({
        ok: false, error: { code: 'target-branch-not-found' },
      })
      expect(await service.switchBranch(repo, '-bad')).toMatchObject({
        ok: false, error: { code: 'invalid-branch-name' },
      })
    })

    it('refuses to switch while an operation is in progress', async () => {
      await git(repo, 'checkout', '-b', 'topic')
      await writeFile(join(repo, 'a.txt'), 'topic\n')
      await git(repo, 'add', '.')
      await git(repo, 'commit', '-m', 'topic change')
      await git(repo, 'checkout', 'main')
      await writeFile(join(repo, 'a.txt'), 'main\n')
      await git(repo, 'add', '.')
      await git(repo, 'commit', '-m', 'main change')
      await service.merge(repo, 'topic')

      expect(await service.switchBranch(repo, 'topic')).toMatchObject({
        ok: false, error: { code: 'operation-in-progress' },
      })
      await service.abortOperation(repo)
    })
  })

  describe('stage / unstage', () => {
    it('stages and unstages without touching the working tree', async () => {
      await writeFile(join(repo, 'a.txt'), 'two\n')
      expect((await service.stage(repo, ['a.txt'])).ok).toBe(true)

      const staged = await service.statusFiles(repo)
      expect(staged?.stagedCount).toBe(1)
      expect(staged?.unstagedCount).toBe(0)

      expect((await service.unstage(repo, ['a.txt'])).ok).toBe(true)
      const unstaged = await service.statusFiles(repo)
      expect(unstaged?.stagedCount).toBe(0)
      expect(unstaged?.unstagedCount).toBe(1)
      // Unstaging must never revert the edit itself.
      expect(await readFile(join(repo, 'a.txt'), 'utf8')).toBe('two\n')
    })

    it('drops index entries when the branch has no commits yet', async () => {
      const fresh = join(root, 'fresh')
      await mkdir(fresh)
      await git(fresh, 'init', '-b', 'main')
      const freshService = new GitService(runner, allowGate(fresh))
      await writeFile(join(fresh, 'n.txt'), 'n\n')

      expect((await freshService.stage(fresh, ['n.txt'])).ok).toBe(true)
      expect((await freshService.unstage(fresh, ['n.txt'])).ok).toBe(true)
      const view = await freshService.statusFiles(fresh)
      expect(view?.untrackedCount).toBe(1)
      expect(view?.stagedCount).toBe(0)
      // An unborn branch is NOT a detached one: v2 reports the branch git is already
      // holding (v1's `rev-parse --abbrev-ref HEAD` failed here, and the panel said
      // "detached"), and there is simply no tip yet.
      expect(view?.branch).toBe('main')
      expect(view?.head).toBe('')
    })

    it('rejects empty and traversal path lists before git sees them', async () => {
      expect(await service.stage(repo, [])).toMatchObject({ ok: false, error: { code: 'invalid-path' } })
      expect(await service.stage(repo, ['../escape.txt'])).toMatchObject({ ok: false, error: { code: 'invalid-path' } })
      expect(await service.discard(repo, ['a/../../b'])).toMatchObject({ ok: false, error: { code: 'invalid-path' } })
      expect(await service.unstage(repo, ['C:\\Windows\\system.ini'])).toMatchObject({ ok: false, error: { code: 'invalid-path' } })
    })

    it('gates mutations on workspace membership', async () => {
      const outside = join(root, 'outside')
      await mkdir(outside)
      expect(await service.stage(outside, ['a.txt'])).toMatchObject({ ok: false, error: { code: 'workspace-unknown' } })
      expect(await service.commit(outside, 'x')).toMatchObject({ ok: false, error: { code: 'workspace-unknown' } })
      expect(await service.fetch(outside)).toMatchObject({ ok: false, error: { code: 'workspace-unknown' } })
      expect(await service.merge(outside, 'main')).toMatchObject({ ok: false, error: { code: 'workspace-unknown' } })
    })

    it('reports not-a-repository for a gated path that is not a repo', async () => {
      const plain = join(root, 'plain')
      await mkdir(plain)
      const plainService = new GitService(runner, allowGate(plain))
      expect(await plainService.statusFiles(plain)).toBeNull()
      expect(await plainService.stage(plain, ['a.txt'])).toMatchObject({ ok: false, error: { code: 'not-a-repository' } })
    })
  })

  describe('commit', () => {
    it('rejects an empty message and an empty index, then commits for real', async () => {
      await writeFile(join(repo, 'a.txt'), 'two\n')
      expect(await service.commit(repo, '')).toMatchObject({ ok: false, error: { code: 'empty-commit-message' } })
      expect(await service.commit(repo, '   ')).toMatchObject({ ok: false, error: { code: 'empty-commit-message' } })
      expect(await service.commit(repo, 'nope')).toMatchObject({ ok: false, error: { code: 'nothing-to-commit' } })

      await service.stage(repo, ['a.txt'])
      const result = await service.commit(repo, 'update a')
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.subject).toBe('update a')
      expect(result.oid).toMatch(/^[0-9a-f]{7,}$/)

      const view = await service.statusFiles(repo)
      expect(view?.files).toHaveLength(0)
      expect(view?.head).toBe(result.oid)
    })

    it('amends the tip when asked', async () => {
      await writeFile(join(repo, 'a.txt'), 'two\n')
      await service.stage(repo, ['a.txt'])
      expect((await service.commit(repo, 'first attempt')).ok).toBe(true)

      const amended = await service.commit(repo, 'second attempt', true)
      expect(amended.ok).toBe(true)
      if (!amended.ok) return
      expect(amended.subject).toBe('second attempt')
      const history = await service.history(repo, 10, 0)
      expect(history?.commits.map(commit => commit.subject)).toEqual(['second attempt', 'initial'])
    })
  })

  describe('discard', () => {
    it('restores a tracked modification and deletes an untracked file', async () => {
      await writeFile(join(repo, 'a.txt'), 'two\n')
      await writeFile(join(repo, 'new.txt'), 'n\n')

      expect((await service.discard(repo, ['a.txt', 'new.txt'])).ok).toBe(true)
      expect(await readText(join(repo, 'a.txt'))).toBe('one\n')
      await expect(readFile(join(repo, 'new.txt'), 'utf8')).rejects.toThrow()
      expect((await service.statusFiles(repo))?.files).toHaveLength(0)
    })

    it('keeps a staged addition while discarding its further worktree edits', async () => {
      await writeFile(join(repo, 'new.txt'), 'staged\n')
      await service.stage(repo, ['new.txt'])
      // 'AM': the index holds the file, the worktree added a line on top of it.
      await writeFile(join(repo, 'new.txt'), 'staged\nunstaged\n')

      expect((await service.discard(repo, ['new.txt'])).ok).toBe(true)
      // Only the worktree side is taken back; the staged row has to survive.
      expect(await readText(join(repo, 'new.txt'))).toBe('staged\n')
      const view = await service.statusFiles(repo)
      expect(view?.files).toMatchObject([{ path: 'new.txt', index: 'A', worktree: ' ', staged: true }])
      expect(view?.stagedCount).toBe(1)
      expect(view?.unstagedCount).toBe(0)
    })

    it('reports nothing-to-discard for a staged path whose worktree never moved', async () => {
      await writeFile(join(repo, 'new.txt'), 'staged\n')
      await service.stage(repo, ['new.txt'])

      // There is no pending change to take back, and the staged half must not be
      // touched — the request is a no-op rather than a hidden unstage.
      expect(await service.discard(repo, ['new.txt'])).toMatchObject({
        ok: false, error: { code: 'nothing-to-discard' },
      })
      expect(await readText(join(repo, 'new.txt'))).toBe('staged\n')
      expect((await service.statusFiles(repo))?.files).toMatchObject([{ path: 'new.txt', staged: true }])
    })

    it('restores a deleted tracked file', async () => {
      await rm(join(repo, 'a.txt'))
      expect((await service.discard(repo, ['a.txt'])).ok).toBe(true)
      expect(await readText(join(repo, 'a.txt'))).toBe('one\n')
    })

    it('resolves a conflicted path back to HEAD', async () => {
      await git(repo, 'checkout', '-b', 'topic')
      await writeFile(join(repo, 'a.txt'), 'topic\n')
      await git(repo, 'add', '.')
      await git(repo, 'commit', '-m', 'topic change')
      await git(repo, 'checkout', 'main')
      await writeFile(join(repo, 'a.txt'), 'main\n')
      await git(repo, 'add', '.')
      await git(repo, 'commit', '-m', 'main change')
      await service.merge(repo, 'topic')
      expect((await service.statusFiles(repo))?.conflictedCount).toBe(1)

      expect((await service.discard(repo, ['a.txt'])).ok).toBe(true)
      expect(await readText(join(repo, 'a.txt'))).toBe('main\n')
      expect((await service.statusFiles(repo))?.conflictedCount).toBe(0)
      await service.abortOperation(repo)
    })

    it('reports nothing-to-discard once the paths are clean', async () => {
      expect(await service.discard(repo, ['a.txt'])).toMatchObject({ ok: false, error: { code: 'nothing-to-discard' } })
      expect(await service.discard(repo, ['never-existed.txt'])).toMatchObject({ ok: false, error: { code: 'nothing-to-discard' } })
    })
  })

  describe('diff', () => {
    it('renders the worktree, staged, and untracked sides', async () => {
      await writeFile(join(repo, 'a.txt'), 'two\n')
      const unstaged = await service.diff(repo, 'a.txt', false)
      expect(unstaged?.binary).toBe(false)
      expect(unstaged?.truncated).toBe(false)
      expect(unstaged?.patch).toContain('-one')
      expect(unstaged?.patch).toContain('+two')

      await service.stage(repo, ['a.txt'])
      expect((await service.diff(repo, 'a.txt', true))?.patch).toContain('+two')
      // Once staged, the worktree side has nothing left to show.
      expect((await service.diff(repo, 'a.txt', false))?.patch.trim()).toBe('')

      await writeFile(join(repo, 'new.txt'), 'fresh\n')
      const untracked = await service.diff(repo, 'new.txt', false)
      expect(untracked?.patch).toContain('new file')
      expect(untracked?.patch).toContain('+fresh')
    })

    it('refuses an unsafe path instead of diffing it', async () => {
      expect(await service.diff(repo, '../outside.txt', false)).toBeNull()
      expect(await service.diff(repo, 'a.txt', false, undefined)).not.toBeNull()
    })

    it('spends no spawn on the untracked probe when the diff already answered', async () => {
      // The probe costs a cold-ish git start (~56ms measured) and used to run for
      // EVERY path, including the tracked modification that is the common click.
      // An empty reading is what actually means "this may be untracked".
      await writeFile(join(repo, 'a.txt'), 'two\n')
      const argv: string[][] = []
      const counting = new GitService({
        async run(args, cwd) { argv.push([...args]); return runner.run(args, cwd) },
      }, allowGate(repo))

      const view = await counting.diff(repo, 'a.txt', false)
      expect(view?.patch).toContain('+two')
      expect(argv.some(args => args.includes('ls-files'))).toBe(false)

      // An untracked path still gets the null-device treatment.
      await writeFile(join(repo, 'new.txt'), 'fresh\n')
      const untracked = await counting.diff(repo, 'new.txt', false)
      expect(untracked?.patch).toContain('+fresh')
      expect(argv.some(args => args.includes('ls-files'))).toBe(true)
      expect(argv.some(args => args.includes('--no-index'))).toBe(true)
    })

    it('asks git for the repository root once, not once per call', async () => {
      // Every route resolves the root with its own spawn; the preview paid it on
      // every click. The root of a workspace does not move between calls.
      await writeFile(join(repo, 'a.txt'), 'two\n')
      const argv: string[][] = []
      const counting = new GitService({
        async run(args, cwd) { argv.push([...args]); return runner.run(args, cwd) },
      }, allowGate(repo))

      await counting.diff(repo, 'a.txt', false)
      await counting.diff(repo, 'a.txt', true)
      await counting.statusFiles(repo)
      expect(argv.filter(args => args.includes('--show-toplevel'))).toHaveLength(1)
    })

    it('carries the remotes, so the branch bar needs no second round trip', async () => {
      // Opening the tab used to be TWO route calls: the file list, and a remote
      // probe of its own. The remote list rides on the list now, and is remembered —
      // it only changes if the user edits their remotes, which this panel cannot do.
      await git(repo, 'remote', 'add', 'origin', 'https://example.com/repo.git')
      const argv: string[][] = []
      const counting = new GitService({
        async run(args, cwd) { argv.push([...args]); return runner.run(args, cwd) },
      }, allowGate(repo))

      const first = await counting.statusFiles(repo)
      expect(first?.remotes?.map(row => row.name)).toEqual(['origin'])
      expect(argv.filter(args => args.includes('remote'))).toHaveLength(1)
      // Remembered: a second call does not ask git again.
      await counting.statusFiles(repo)
      expect(argv.filter(args => args.includes('remote'))).toHaveLength(1)
    })
  })

  describe('history and commit detail', () => {
    const NUL = '\u0000'

    /**
     * Real git, plus the answers this suite cannot cheaply produce: a
     * pathological numstat/raw fixture, and a patch that only settles when it is
     * cancelled. Every argv is recorded, so a test can prove WHICH spawns ran
     * instead of inferring it from a duration.
     */
    function fastPathRunner(fixture: {
      numstat?: string
      raw?: string
      patch?: (signal: AbortSignal | undefined) => Promise<GitRunResult>
    }): { runner: GitRunner; spawns: string[][] } {
      const spawns: string[][] = []
      const wrapped: GitRunner = {
        async run(argv, cwd, signal) {
          spawns.push([...argv])
          if (fixture.numstat !== undefined && argv.includes('--numstat')) {
            return { exitCode: 0, stdout: fixture.numstat, stderr: '' }
          }
          if (fixture.raw !== undefined && argv.includes('--raw')) {
            return { exitCode: 0, stdout: fixture.raw, stderr: '' }
          }
          if (fixture.patch !== undefined && argv.includes('--patch')) return fixture.patch(signal)
          return runner.run(argv, cwd, signal)
        },
      }
      return { runner: wrapped, spawns }
    }

    it('pages history and renders one commit', async () => {
      await writeFile(join(repo, 'a.txt'), 'two\n')
      await service.stage(repo, ['a.txt'])
      expect((await service.commit(repo, 'second')).ok).toBe(true)

      const firstPage = await service.history(repo, 1, 0)
      expect(firstPage?.commits.map(commit => commit.subject)).toEqual(['second'])
      expect(firstPage?.hasMore).toBe(true)
      expect(firstPage?.branch).toBe('main')

      const secondPage = await service.history(repo, 1, 1)
      expect(secondPage?.commits.map(commit => commit.subject)).toEqual(['initial'])
      expect(secondPage?.hasMore).toBe(false)

      const oid = firstPage?.commits[0]?.oid ?? ''
      const detail = await service.commitDetail(repo, oid)
      expect(detail?.subject).toBe('second')
      expect(detail?.author).toBe('Test')
      expect(detail?.files.map(file => file.path)).toEqual(['a.txt'])
      expect(detail?.patch).toContain('+two')
      expect(detail?.truncated).toBe(false)
    })

    it('rejects a non-hex object id so it can never become a git option', async () => {
      expect(await service.commitDetail(repo, '--upload-pack=touch /tmp/x')).toBeNull()
      expect(await service.commitDetail(repo, 'zzzz')).toBeNull()
      expect(await service.commitDetail(repo, '')).toBeNull()
    })

    it('reads one commit file on its own, which is what the cap cannot cut', async () => {
      // The per-file route exists because the commit-wide patch is capped. Both
      // files of this commit are touched, and each reads whole on its own.
      await writeFile(join(repo, 'a.txt'), 'two three\n')
      await writeFile(join(repo, 'second.txt'), 's\n')
      await service.stage(repo, ['a.txt', 'second.txt'])
      expect((await service.commit(repo, 'both')).ok).toBe(true)
      const oid = (await service.history(repo, 1, 0))?.commits[0]?.oid ?? ''

      const first = await service.commitDiff(repo, oid, 'a.txt')
      expect(first?.path).toBe('a.txt')
      expect(first?.binary).toBe(false)
      expect(first?.truncated).toBe(false)
      expect(first?.patch).toContain('-one')
      expect(first?.patch).toContain('+two')
      // One path only: the other file's section is not in this answer.
      expect(first?.patch).not.toContain('second.txt')
      // The two sizes: the first parent's blob, and this commit's. 'one\n' is four
      // bytes and 'two three\n' is ten, which is what the pane reports when a file
      // turns out to have no text to diff.
      expect(first?.before).toBe(4)
      expect(first?.after).toBe(10)

      const second = await service.commitDiff(repo, oid, 'second.txt')
      expect(second?.patch).toContain('+s')
      expect(second?.patch).not.toContain('a.txt')

      // A binary file answers with its marker rather than hunks.
      await writeFile(join(repo, 'blob.bin'), Buffer.from([0, 1, 2, 0, 255]))
      await service.stage(repo, ['blob.bin'])
      expect((await service.commit(repo, 'binary')).ok).toBe(true)
      const binaryOid = (await service.history(repo, 1, 0))?.commits[0]?.oid ?? ''
      const binary = await service.commitDiff(repo, binaryOid, 'blob.bin')
      expect(binary?.binary).toBe(true)
      expect(binary?.patch).not.toContain('@@')
      // A binary file has no lines, so its sizes are the whole story: the five bytes
      // just written, and no previous version to compare them against.
      expect(binary?.before).toBeNull()
      expect(binary?.after).toBe(5)
    })

    it('answers per file for a commit whose whole patch was capped', async () => {
      // The reported case: a commit touching enough files that the commit-wide
      // patch hits the host's cap. Everything past the cut has no section, so the
      // review used to say "the diff was too large" for every one of those files.
      // The per-file route is outside that cap, which is the whole fix.
      // Zero-padded, so git's path sort agrees with the reading order and "the
      // last file" is the one the cap actually cuts.
      const names = Array.from({ length: 12 }, (_, index) => `bulk/f${String(index).padStart(2, '0')}.txt`)
      await mkdir(join(repo, 'bulk'), { recursive: true })
      const body = Array.from({ length: 900 }, (_, line) => `line ${line} ${'x'.repeat(40)}`).join('\n')
      for (const name of names) await writeFile(join(repo, name), `${body}\n`)
      await service.stage(repo, names)
      expect((await service.commit(repo, 'bulk')).ok).toBe(true)
      const oid = (await service.history(repo, 1, 0))?.commits[0]?.oid ?? ''

      const detail = await service.commitDetail(repo, oid)
      expect(detail?.truncated).toBe(true)
      // Every file is still LISTED — that is a separate numstat spawn — while the
      // patch stops short of them.
      expect(detail?.files).toHaveLength(names.length)
      const last = names[names.length - 1] as string
      expect(detail?.patch).not.toContain(`b/${last}`)

      // The file the cap left out reads whole on its own, including its last line.
      const single = await service.commitDiff(repo, oid, last)
      expect(single?.path).toBe(last)
      expect(single?.truncated).toBe(false)
      expect(single?.patch).toContain(`b/${last}`)
      expect(single?.patch).toContain('line 899')
      // And it is that file only.
      expect(single?.patch).not.toContain('bulk/f00.txt')
    })

    it('reads a MERGE commit against its first parent, so its files preview', async () => {
      // The reported case: the History tab listed a merge's changed files and not
      // one of them could be previewed. `git show` answers a merge with its combined
      // diff, which is the empty string for an ordinary "Merge branch 'x'" — so the
      // patch was 0 bytes while the numstat spawn (a different command) still
      // reported files. Diffing against the first parent is what the merge brought
      // into the branch, and is what GitHub shows.
      await git(repo, 'checkout', '-b', 'feature')
      await writeFile(join(repo, 'feature.txt'), 'from feature\n')
      await git(repo, 'add', '.')
      await git(repo, 'commit', '-m', 'feature work')
      await git(repo, 'checkout', 'main')
      await writeFile(join(repo, 'main.txt'), 'from main\n')
      await git(repo, 'add', '.')
      await git(repo, 'commit', '-m', 'main work')
      expect((await service.merge(repo, 'feature')).ok).toBe(true)

      const head = (await service.history(repo, 1, 0))?.commits[0]
      // The fixture has to BE a merge, or the test proves nothing.
      expect(head?.parents).toHaveLength(2)
      const oid = head?.oid ?? ''

      const detail = await service.commitDetail(repo, oid)
      expect(detail?.truncated).toBe(false)
      // The merge's own contribution: what the second parent added on top of the
      // first, and nothing that was already on the first parent's side.
      expect(detail?.files.map(file => file.path)).toEqual(['feature.txt'])
      expect(detail?.patch).toContain('b/feature.txt')
      expect(detail?.patch).toContain('+from feature')
      expect(detail?.patch).not.toContain('main.txt')

      // And every file the list shows can actually be opened.
      for (const file of detail?.files ?? []) {
        const one = await service.commitDiff(repo, oid, file.path)
        expect(one?.patch).toContain('+from feature')
        // The "before" side is the merge's FIRST parent — the same side the patch
        // diffs against — so a file the merge introduced has no size there.
        expect(one?.before).toBeNull()
        expect(one?.after).toBe('from feature\n'.length)
      }
    })

    it('takes the fast path on either threshold', () => {
      const rows = (count: number, additions: number): CommitFileStat[] =>
        Array.from({ length: count }, (_, index) => ({
          path: `f${index}.txt`, additions, deletions: 0, binary: false,
        }))
      expect(shouldSkipCommitPatch(rows(COMMIT_DETAIL_MAX_FILES, 0))).toBe(false)
      expect(shouldSkipCommitPatch(rows(COMMIT_DETAIL_MAX_FILES + 1, 0))).toBe(true)
      // The line limit is independent of the file limit: a couple of huge files
      // reach it while the file count stays tiny.
      const half = COMMIT_DETAIL_MAX_CHANGED_LINES / 2
      expect(shouldSkipCommitPatch(rows(2, half))).toBe(false)
      expect(shouldSkipCommitPatch(rows(2, half + 1))).toBe(true)
    })

    it('skips a huge commit patch and fills status from --raw', async () => {
      const oid = (await service.history(repo, 1, 0))?.commits[0]?.oid ?? ''
      // The pathological commit is FABRICATED: seeding 2001 real files would cost
      // the suite far more than the code under test. What is pinned is the wiring —
      // numstat decides, the patch is cancelled, and raw supplies the file kinds.
      const count = COMMIT_DETAIL_MAX_FILES + 1
      const paths = Array.from({ length: count }, (_, index) => `bulk/f${index}.txt`)
      const numstat = paths.map(path => `1\t0\t${path}`).join(NUL) + NUL
      // All three kinds, so the badge mapping is actually exercised.
      const kinds = ['A', 'D', 'M']
      const raw = paths.map((path, index) =>
        `:000000 100644 0000000 6868963 ${kinds[index] ?? 'M'}${NUL}${path}${NUL}`).join('')
      const patch = (signal: AbortSignal | undefined) => new Promise<GitRunResult>((_, reject) => {
        // Only an abort settles this, so a fast path that still waited for the
        // patch text would time this test out — which is exactly the regression.
        if (signal === undefined) return
        signal.addEventListener('abort', () => reject(new Error('patch cancelled')), { once: true })
      })
      const { runner: wrapped, spawns } = fastPathRunner({ numstat, raw, patch })
      const fastService = new GitService(wrapped, allowGate(repo))

      const detail = await fastService.commitDetail(repo, oid)
      if (detail === null) throw new Error('no detail')
      expect(detail.files).toHaveLength(count)
      expect(detail.files.slice(0, 3).map(file => file.status)).toEqual(['added', 'deleted', 'modified'])
      expect(detail.patch).toBe('')
      expect(detail.truncated).toBe(true)
      // The patch was STARTED (it overlaps the cheap reads) and then abandoned;
      // the raw read is what replaced it.
      expect(spawns.some(args => args.includes('--patch'))).toBe(true)
      expect(spawns.some(args => args.includes('--raw'))).toBe(true)
    })

    it('keeps the full patch for an ordinary commit', async () => {
      await writeFile(join(repo, 'a.txt'), 'two\n')
      await service.stage(repo, ['a.txt'])
      expect((await service.commit(repo, 'second')).ok).toBe(true)
      const oid = (await service.history(repo, 1, 0))?.commits[0]?.oid ?? ''
      const { runner: wrapped, spawns } = fastPathRunner({})
      const plainService = new GitService(wrapped, allowGate(repo))

      const detail = await plainService.commitDetail(repo, oid)
      expect(detail?.patch).toContain('+two')
      expect(detail?.truncated).toBe(false)
      // No --raw read: the full patch carries the kinds, and the guard never fired.
      expect(spawns.some(args => args.includes('--raw'))).toBe(false)
      expect(detail?.files[0]?.status).toBeUndefined()
    })

    it('answers a repeated read of one commit without spawning git again', async () => {
      const oid = (await service.history(repo, 1, 0))?.commits[0]?.oid ?? ''
      const { runner: wrapped, spawns } = fastPathRunner({})
      const cachedService = new GitService(wrapped, allowGate(repo))

      const first = await cachedService.commitDetail(repo, oid)
      if (first === null) throw new Error('no detail')
      const afterFirst = spawns.length
      expect(afterFirst).toBeGreaterThan(1)

      const second = await cachedService.commitDetail(repo, oid)
      expect(second).toEqual(first)
      // The SSE refresh and a re-opened History tab re-read the same immutable
      // commit: the second read must cost no spawn at all, not even the root probe.
      expect(spawns.length).toBe(afterFirst)

      // The cache never short-circuits validation: a non-hex id is rejected before
      // any lookup, and still costs nothing.
      expect(await cachedService.commitDetail(repo, 'not-an-oid')).toBeNull()
      expect(spawns.length).toBe(afterFirst)
    })

    it('validates both the object id and the path before either reaches argv', async () => {
      const oid = (await service.history(repo, 1, 0))?.commits[0]?.oid ?? ''
      // A path is gated exactly as it is on the change list's per-file route.
      expect(await service.commitDiff(repo, oid, '../outside.txt')).toBeNull()
      expect(await service.commitDiff(repo, oid, 'C:\\Windows\\system.ini')).toBeNull()
      expect(await service.commitDiff(repo, oid, '')).toBeNull()
      // So is the id, so a crafted one can never parse as a git option.
      expect(await service.commitDiff(repo, '--upload-pack=touch /tmp/x', 'a.txt')).toBeNull()
      expect(await service.commitDiff(repo, 'zzzz', 'a.txt')).toBeNull()
      // A path this commit never touched has nothing to answer with — an empty
      // patch, not a hole the review would have to guess at.
      expect((await service.commitDiff(repo, oid, 'never-existed.txt'))?.patch.trim()).toBe('')
    })
  })

  describe('remotes', () => {
    it('fetches, pulls, and pushes against a local bare remote', async () => {
      const bare = join(root, 'origin.git')
      expect((await git(root, 'init', '--bare', '-b', 'main', bare)).exitCode).toBe(0)
      expect((await git(repo, 'remote', 'add', 'origin', bare)).exitCode).toBe(0)

      // A branch with no upstream yet: push must set it.
      expect((await service.push(repo)).ok).toBe(true)
      const tracking = await service.remoteView(repo)
      expect(tracking?.remotes.map(remote => remote.name)).toEqual(['origin'])
      expect(tracking?.upstream).toBe('origin/main')
      expect(tracking?.ahead).toBe(0)
      expect(tracking?.behind).toBe(0)

      await writeFile(join(repo, 'a.txt'), 'three\n')
      await service.stage(repo, ['a.txt'])
      expect((await service.commit(repo, 'third')).ok).toBe(true)
      expect((await service.remoteView(repo))?.ahead).toBe(1)

      expect((await service.fetch(repo)).ok).toBe(true)
      expect((await service.pull(repo)).ok).toBe(true)

      // A second clone advances the remote, making this branch behind.
      const other = join(root, 'other')
      expect((await git(root, 'clone', bare, other)).exitCode).toBe(0)
      await git(other, 'config', 'user.email', 'test@dsh.local')
      await git(other, 'config', 'user.name', 'Test')
      await writeFile(join(other, 'b.txt'), 'b\n')
      await git(other, 'add', '.')
      expect((await git(other, 'commit', '-m', 'from other')).exitCode).toBe(0)
      expect((await git(other, 'push', 'origin', 'main')).exitCode).toBe(0)

      expect((await service.fetch(repo)).ok).toBe(true)
      expect((await service.remoteView(repo))?.behind).toBe(1)
      expect((await service.pull(repo)).ok).toBe(true)
      expect((await service.remoteView(repo))?.behind).toBe(0)
    })

    it('rejects a pull with no upstream and a push on a detached HEAD', async () => {
      expect(await service.pull(repo)).toMatchObject({ ok: false, error: { code: 'no-upstream' } })
      await git(repo, 'checkout', '--detach')
      expect(await service.push(repo)).toMatchObject({ ok: false, error: { code: 'detached-head' } })
    })

    it('reports a transport failure through the remote-failed code', async () => {
      await git(repo, 'remote', 'add', 'origin', join(root, 'does-not-exist.git'))
      const result = await service.fetch(repo)
      expect(result).toMatchObject({ ok: false, error: { code: 'remote-failed' } })
    })
  })

  describe('merge and rebase', () => {
    /** Seed a conflicting topic branch against main. */
    async function seedConflict(): Promise<void> {
      await git(repo, 'checkout', '-b', 'topic')
      await writeFile(join(repo, 'a.txt'), 'topic\n')
      await git(repo, 'add', '.')
      await git(repo, 'commit', '-m', 'topic change')
      await git(repo, 'checkout', 'main')
      await writeFile(join(repo, 'a.txt'), 'main\n')
      await git(repo, 'add', '.')
      await git(repo, 'commit', '-m', 'main change')
    }

    it('stops a conflicted merge on purpose and aborts on request', async () => {
      await seedConflict()
      expect(await service.merge(repo, 'topic')).toMatchObject({ ok: false, error: { code: 'conflicts-present' } })

      // The conflict is deliberately left in place: that is what the panel shows.
      const during = await service.statusFiles(repo)
      expect(during?.operationInProgress).toBe(true)
      expect(during?.operation).toBe('merge')
      expect(during?.conflictedCount).toBe(1)

      expect((await service.abortOperation(repo)).ok).toBe(true)
      const after = await service.statusFiles(repo)
      expect(after?.operationInProgress).toBe(false)
      expect(after?.conflictedCount).toBe(0)
    })

    it('merges cleanly when the branches do not collide', async () => {
      await git(repo, 'checkout', '-b', 'feature')
      await writeFile(join(repo, 'b.txt'), 'b\n')
      await git(repo, 'add', '.')
      await git(repo, 'commit', '-m', 'feature work')
      await git(repo, 'checkout', 'main')
      expect((await service.merge(repo, 'feature')).ok).toBe(true)
      expect(await readText(join(repo, 'b.txt'))).toBe('b\n')
    })

    it('rebases onto another branch and rejects an unknown target', async () => {
      expect(await service.rebase(repo, 'nope')).toMatchObject({ ok: false, error: { code: 'target-branch-not-found' } })
      expect(await service.merge(repo, 'bad name')).toMatchObject({ ok: false, error: { code: 'invalid-branch-name' } })

      await git(repo, 'checkout', '-b', 'topic2')
      await writeFile(join(repo, 'c.txt'), 'c\n')
      await git(repo, 'add', '.')
      await git(repo, 'commit', '-m', 'topic2 work')
      await git(repo, 'checkout', 'main')
      await writeFile(join(repo, 'd.txt'), 'd\n')
      await git(repo, 'add', '.')
      await git(repo, 'commit', '-m', 'main work')
      await git(repo, 'checkout', 'topic2')

      expect((await service.rebase(repo, 'main')).ok).toBe(true)
      const log = await git(repo, 'log', '--oneline')
      expect(log.stdout).toContain('topic2 work')
      expect(log.stdout).toContain('main work')
    })

    it('reports nothing to abort when no operation is in progress', async () => {
      expect(await service.abortOperation(repo)).toMatchObject({ ok: false, error: { code: 'operation-in-progress' } })
    })
  })

  describe('change-stream probes', () => {
    it('probes branch and head for the SSE key', async () => {
      const probe = await service.probe(repo)
      expect(probe?.branch).toBe('main')
      expect(probe?.head).toMatch(/^[0-9a-f]{7,}$/)
      expect(probe?.root).toBeTruthy()
      expect(await service.probe(join(root, 'nowhere'))).toBeNull()
    })

    it('digests the file-level state in one spawn', async () => {
      const before = await service.statusDigest(repo)
      await writeFile(join(repo, 'a.txt'), 'changed\n')
      const after = await service.statusDigest(repo)
      expect(after).not.toBe(before)
      // A digest, not the raw porcelain text: it stays small on a huge repo.
      expect(after?.length).toBeLessThan(64)
      expect(await service.statusDigest(join(root, 'nowhere'))).toBeNull()
    })
  })
})
