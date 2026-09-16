/**
 * Tests for the commit-patch splitter and row numbering.
 *
 * The numbering is the part worth pinning: a viewer that shows the wrong old/new
 * line number for a row is worse than one that shows none, and a hunk header is
 * what resets both counters. The fixtures are real `git show --patch` output
 * shapes, including the add/delete/rename/binary section headers.
 */
import { describe, expect, it } from 'vitest'
import { reviewFiles, splitPatch } from '../src/client/git/diff-parse.ts'

const MODIFIED = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 1111111..2222222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,3 +1,4 @@',
  ' const one = 1',
  '-const two = 2',
  '+const two = 22',
  '+const three = 3',
  ' const four = 4',
  '@@ -10,2 +11,2 @@ export function thing() {',
  '-old',
  '+new',
].join('\n')

const ADDED = [
  'diff --git a/src/new.ts b/src/new.ts',
  'new file mode 100644',
  'index 0000000..3333333',
  '--- /dev/null',
  '+++ b/src/new.ts',
  '@@ -0,0 +1,2 @@',
  '+first',
  '+second',
].join('\n')

const DELETED = [
  'diff --git a/src/gone.ts b/src/gone.ts',
  'deleted file mode 100644',
  'index 4444444..0000000',
  '--- a/src/gone.ts',
  '+++ /dev/null',
  '@@ -1 +0,0 @@',
  '-bye',
].join('\n')

const RENAMED = [
  'diff --git a/src/old.ts b/src/moved.ts',
  'similarity index 92%',
  'rename from src/old.ts',
  'rename to src/moved.ts',
  'index 5555555..6666666 100644',
  '--- a/src/old.ts',
  '+++ b/src/moved.ts',
  '@@ -1,1 +1,1 @@',
  '-const a = 1',
  '+const a = 2',
].join('\n')

const BINARY = [
  'diff --git a/logo.png b/logo.png',
  'index 7777777..8888888 100644',
  'Binary files a/logo.png and b/logo.png differ',
].join('\n')

describe('splitPatch', () => {
  it('splits one commit into its files, in patch order', () => {
    const files = splitPatch([MODIFIED, ADDED, DELETED].join('\n'))
    expect(files.map(file => file.path)).toEqual(['src/a.ts', 'src/new.ts', 'src/gone.ts'])
  })

  it('numbers both sides of a hunk, and only the side a row belongs to', () => {
    const [file] = splitPatch(MODIFIED)
    expect(file.rows).toEqual([
      { kind: 'hunk', oldLine: null, newLine: null, text: '@@ -1,3 +1,4 @@' },
      { kind: 'context', oldLine: 1, newLine: 1, text: 'const one = 1' },
      { kind: 'del', oldLine: 2, newLine: null, text: 'const two = 2' },
      { kind: 'add', oldLine: null, newLine: 2, text: 'const two = 22' },
      { kind: 'add', oldLine: null, newLine: 3, text: 'const three = 3' },
      { kind: 'context', oldLine: 3, newLine: 4, text: 'const four = 4' },
      { kind: 'hunk', oldLine: null, newLine: null, text: '@@ -10,2 +11,2 @@ export function thing() {' },
      { kind: 'del', oldLine: 10, newLine: null, text: 'old' },
      { kind: 'add', oldLine: null, newLine: 11, text: 'new' },
    ])
    expect(file.additions).toBe(3)
    expect(file.deletions).toBe(2)
  })

  it('reads the status from the section headers git writes', () => {
    const files = splitPatch([ADDED, DELETED, RENAMED, BINARY].join('\n'))
    expect(files.map(file => file.status)).toEqual(['added', 'deleted', 'renamed', 'binary'])
    // A rename keeps both paths; the path shown is the new one.
    expect(files[2].path).toBe('src/moved.ts')
    expect(files[2].origPath).toBe('src/old.ts')
  })

  it('starts both counters at the hunk header, even for a single-line range', () => {
    const [file] = splitPatch(DELETED)
    const rows = file.rows.filter(row => row.kind !== 'hunk')
    expect(rows).toEqual([{ kind: 'del', oldLine: 1, newLine: null, text: 'bye' }])
  })

  it('drops the mechanical headers a review does not show', () => {
    const [file] = splitPatch(MODIFIED)
    const text = file.rows.map(row => row.text).join('\n')
    expect(text).not.toContain('index 1111111')
    expect(text).not.toContain('--- a/src/a.ts')
    expect(text).not.toContain('+++ b/src/a.ts')
  })

  it('keeps the no-newline note without numbering it', () => {
    const [file] = splitPatch(['diff --git a/x b/x', '@@ -1 +1 @@', '-a', '\\ No newline at end of file',
      '+b', '\\ No newline at end of file'].join('\n'))
    expect(file.rows.map(row => row.kind)).toEqual(['hunk', 'del', 'note', 'add', 'note'])
  })

  it('degrades quietly on a patch with no sections', () => {
    expect(splitPatch('')).toEqual([])
    expect(splitPatch('not a patch at all')).toEqual([])
  })
})

describe('reviewFiles', () => {
  const stat = (path: string, additions: number, deletions: number, binary = false) => (
    { path, additions, deletions, binary }
  )

  it('lists every changed file even when the patch was truncated', () => {
    const sections = splitPatch(MODIFIED)
    const rows = reviewFiles([stat('src/a.ts', 3, 2), stat('big.ts', 900, 800)], sections)
    expect(rows.map(row => row.path)).toEqual(['src/a.ts', 'big.ts'])
    expect(rows[1].diff).toBeNull()
    expect(rows[1].additions).toBe(900)
  })

  it('lists a rename once, not as the delete and add numstat reports', () => {
    const sections = splitPatch(RENAMED)
    const rows = reviewFiles([
      stat('src/old.ts', 0, 1),
      stat('src/moved.ts', 1, 0),
    ], sections)
    expect(rows.map(row => row.path)).toEqual(['src/moved.ts'])
    expect(rows[0].status).toBe('renamed')
  })

  it('carries git\'s own statistics when a section has them', () => {
    const rows = reviewFiles([stat('src/a.ts', 3, 2)], splitPatch(MODIFIED))
    expect(rows[0].additions).toBe(3)
    expect(rows[0].deletions).toBe(2)
  })
})
