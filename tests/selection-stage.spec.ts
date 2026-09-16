/**
 * Line-level staging, end to end over REAL git.
 *
 * The client rebuilds a patch for the chosen rows; these tests take a real worktree
 * diff, run it through `splitPatch` and `selectionPatch`, and let the real service
 * apply it — then read the index and the worktree back to see what moved. That is
 * the only honest way to test an algorithm whose whole job is to convince
 * `git apply`.
 */
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GitService, type GitRunResult, type GitRunner, type WorkspaceGate } from '../src/host/git-service.ts'
import { sectionOf, selectionPatch, splitPatch, type FileDiff } from '../src/client/git/diff-parse.ts'

const execFileAsync = promisify(execFile)

const runner: GitRunner = {
  async run(argv: readonly string[], cwd: string): Promise<GitRunResult> {
    try {
      const { stdout, stderr } = await execFileAsync('git', [...argv], { cwd, encoding: 'utf8', maxBuffer: 1 << 20 })
      return { exitCode: 0, stdout, stderr }
    } catch (error) {
      const failure = error as { code?: number; stdout?: string; stderr?: string }
      return { exitCode: failure.code ?? 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' }
    }
  },
}

function allowGate(...paths: string[]): WorkspaceGate {
  const allowed = new Set(paths)
  return async (path) => (allowed.has(path)
    ? { ok: true, canonical: path }
    : { ok: false, error: { code: 'workspace-unknown', message: 'not a workspace' } })
}

async function git(repo: string, ...args: string[]): Promise<GitRunResult> {
  return runner.run(['-c', 'user.email=t@dsh.local', '-c', 'user.name=Test', ...args], repo)
}

/** The file's content as the INDEX holds it. */
async function indexText(repo: string, file: string): Promise<string> {
  const shown = await git(repo, 'show', `:${file}`)
  return shown.stdout.replace(/\r\n/g, '\n')
}

const text = (path: string): Promise<string> => readFile(path, 'utf8').then(value => value.replace(/\r\n/g, '\n'))

describe('line-level staging', () => {
  let root: string
  let repo: string
  let service: GitService
  const file = 'a.txt'

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-git-selection-'))
    repo = join(root, 'repo')
    await mkdir(repo)
    await git(repo, 'init', '-b', 'main')
    await git(repo, 'config', 'user.email', 'test@dsh.local')
    await git(repo, 'config', 'user.name', 'Test')
    await writeFile(join(repo, file), 'one\ntwo\nthree\nfour\nfive\n')
    await git(repo, 'add', '.')
    await git(repo, 'commit', '-m', 'initial')
    service = new GitService(runner, allowGate(repo))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  /** The parsed diff of one side, as the panel's viewer builds it. */
  async function diffOf(staged: boolean): Promise<FileDiff> {
    const view = await service.diff(repo, file, staged)
    if (view === null) throw new Error('no diff')
    const section = sectionOf(view.patch, file, false)
    if (section === null) throw new Error('no section')
    const parsed = splitPatch(section)[0]
    if (parsed === undefined) throw new Error('no parsed file')
    return parsed
  }

  /** The row index of the first row whose text is exactly `text` and kind matches. */
  const rowIndex = (file0: FileDiff, kind: 'add' | 'del' | 'context', wanted: string): number => {
    const index = file0.rows.findIndex(row => row.kind === kind && row.text === wanted)
    if (index < 0) throw new Error(`row not found: ${kind} ${wanted}`)
    return index
  }

  it('stages a chosen modification, leaving the rest of the file pending', async () => {
    await writeFile(join(repo, file), 'one\nTWO\nthree\nfour\nFIVE\n')
    const parsed = await diffOf(false)
    // A modification is TWO rows: the removed line and the added one. Choosing both
    // is what replaces `five` with `FIVE` in the index; choosing only the added line
    // would INSERT it (see the next case).
    const patch = selectionPatch(parsed, new Set([
      rowIndex(parsed, 'del', 'five'),
      rowIndex(parsed, 'add', 'FIVE'),
    ]), 'stage')
    expect(patch).not.toBeNull()
    if (patch === null) return

    expect(await service.applySelection(repo, file, 'stage', patch)).toMatchObject({ ok: true })
    // The index took the chosen change...
    expect(await indexText(repo, file)).toBe('one\ntwo\nthree\nfour\nFIVE\n')
    // ...and the worktree still holds BOTH edits, so it differs from the index.
    expect(await text(join(repo, file))).toBe('one\nTWO\nthree\nfour\nFIVE\n')
    const status = await service.statusFiles(repo)
    expect(status?.files.find(entry => entry.path === file)).toMatchObject({ index: 'M', worktree: 'M' })
  })

  it('stages an insertion when only the added line is chosen', async () => {
    await writeFile(join(repo, file), 'one\nTWO\nthree\nfour\nfive\n')
    const parsed = await diffOf(false)
    const patch = selectionPatch(parsed, new Set([rowIndex(parsed, 'add', 'TWO')]), 'stage')
    if (patch === null) throw new Error('no patch')
    expect(await service.applySelection(repo, file, 'stage', patch)).toMatchObject({ ok: true })
    // The addition went in; the removal of `two` is still pending, so the index has
    // both lines — which is exactly what was selected.
    expect(await indexText(repo, file)).toBe('one\ntwo\nTWO\nthree\nfour\nfive\n')
  })

  it('takes a chosen modification back out of the index', async () => {
    await writeFile(join(repo, file), 'one\nTWO\nthree\nfour\nFIVE\n')
    await git(repo, 'add', '--', file)
    const parsed = await diffOf(true)
    const patch = selectionPatch(parsed, new Set([
      rowIndex(parsed, 'del', 'five'),
      rowIndex(parsed, 'add', 'FIVE'),
    ]), 'unstage')
    expect(patch).not.toBeNull()
    if (patch === null) return

    expect(await service.applySelection(repo, file, 'unstage', patch)).toMatchObject({ ok: true })
    // `five` is back in the index and FIVE is gone from it; TWO stays staged, and
    // the worktree is untouched either way.
    expect(await indexText(repo, file)).toBe('one\nTWO\nthree\nfour\nfive\n')
    expect(await text(join(repo, file))).toBe('one\nTWO\nthree\nfour\nFIVE\n')
  })

  it('discards a chosen modification from the worktree only', async () => {
    await writeFile(join(repo, file), 'one\nTWO\nthree\nfour\nFIVE\n')
    const parsed = await diffOf(false)
    const patch = selectionPatch(parsed, new Set([
      rowIndex(parsed, 'del', 'five'),
      rowIndex(parsed, 'add', 'FIVE'),
    ]), 'discard')
    expect(patch).not.toBeNull()
    if (patch === null) return

    expect(await service.applySelection(repo, file, 'discard', patch)).toMatchObject({ ok: true })
    // FIVE is back to `five`; the other edit (TWO) is the user's and stays.
    expect(await text(join(repo, file))).toBe('one\nTWO\nthree\nfour\nfive\n')
    // The index was never touched.
    expect(await indexText(repo, file)).toBe('one\ntwo\nthree\nfour\nfive\n')
  })

  it('handles two hunks in one file', async () => {
    const long = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`)
    await writeFile(join(repo, file), `${long.join('\n')}\n`)
    await git(repo, 'add', '--', file)
    await git(repo, 'commit', '-m', 'long')
    const edited = [...long]
    edited[1] = 'line 2 EDITED'
    edited[28] = 'line 29 EDITED'
    await writeFile(join(repo, file), `${edited.join('\n')}\n`)

    const parsed = await diffOf(false)
    // Two hunks (the edits are far apart): choose only the second one.
    const patch = selectionPatch(parsed, new Set([rowIndex(parsed, 'add', 'line 29 EDITED')]), 'stage')
    if (patch === null) throw new Error('no patch')
    expect(patch.split('\n').filter(line => line.startsWith('@@'))).toHaveLength(1)
    expect(await service.applySelection(repo, file, 'stage', patch)).toMatchObject({ ok: true })
    const staged = await indexText(repo, file)
    expect(staged).toContain('line 29 EDITED')
    expect(staged).toContain('line 2\n')
  })

  it('stages a chosen line of a brand-new file', async () => {
    await writeFile(join(repo, 'new.txt'), 'alpha\nbeta\ngamma\n')
    const view = await service.diff(repo, 'new.txt', false)
    if (view === null) throw new Error('no diff')
    const section = sectionOf(view.patch, 'new.txt', false)
    if (section === null) throw new Error('no section')
    const parsed = splitPatch(section)[0]
    if (parsed === undefined) throw new Error('no parse')
    // An untracked file's patch came from `--no-index`; the staged target needs the
    // creation header, which the builder writes from the file's status.
    const patch = selectionPatch({ ...parsed, status: 'added' }, new Set([rowIndex(parsed, 'add', 'beta')]), 'stage')
    if (patch === null) throw new Error('no patch')
    expect(patch).toContain('new file mode 100644')
    expect(await service.applySelection(repo, 'new.txt', 'stage', patch)).toMatchObject({ ok: true })
    expect(await indexText(repo, 'new.txt')).toBe('beta\n')
  })

  it('refuses a fragment that names another path', async () => {
    const patch = [
      'diff --git a/secret.txt b/secret.txt',
      '--- a/secret.txt',
      '+++ b/secret.txt',
      '@@ -1 +1 @@',
      '-a',
      '+b',
      '',
    ].join('\n')
    const result = await service.applySelection(repo, file, 'stage', patch)
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid-path' } })
  })

  it('refuses a fragment carrying a header a selection cannot produce', async () => {
    const patch = [
      `diff --git a/${file} b/${file}`,
      `--- a/${file}`,
      `+++ b/${file}`,
      '@@ -1 +1 @@',
      '-a',
      '+b',
      'new mode 100755',
      '',
    ].join('\n')
    expect(await service.applySelection(repo, file, 'stage', patch))
      .toMatchObject({ ok: false, error: { code: 'invalid-path' } })
  })

  it('reports git\'s own complaint when the WORKTREE moved under a discard', async () => {
    await writeFile(join(repo, file), 'one\nTWO\nthree\nfour\nfive\n')
    const parsed = await diffOf(false)
    const patch = selectionPatch(parsed, new Set([
      rowIndex(parsed, 'del', 'two'),
      rowIndex(parsed, 'add', 'TWO'),
    ]), 'discard')
    if (patch === null) throw new Error('no patch')
    // The worktree changes again before the patch lands, so the context no longer
    // matches. (A STAGE would still apply: its target is the index, which did not
    // move — which is why this test uses the worktree direction.)
    await writeFile(join(repo, file), 'ONE\nTWO\nTHREE\nfour\nfive\n')
    const result = await service.applySelection(repo, file, 'discard', patch)
    expect(result.ok).toBe(false)
    // ...and the file is left exactly as the user had it.
    expect(await text(join(repo, file))).toBe('ONE\nTWO\nTHREE\nfour\nfive\n')
  })
})
