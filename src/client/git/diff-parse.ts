/**
 * Turning one commit's patch into a review view: per-file sections, and each
 * section into rows a viewer can render with line numbers.
 *
 * `git show --patch` writes one `diff --git a/… b/…` section per changed file,
 * so the split is a client-side job and the host keeps exposing one patch. The
 * section headers are also what tell the file's STATUS ("new file mode",
 * "deleted file mode", "rename from"), which `--numstat` does not carry.
 *
 * Pure string work — no git, no DOM — so the row numbering is unit-testable
 * without a browser, and a malformed patch degrades to fewer rows rather than
 * throwing.
 * @module dsh-git-panel/client/git/diff-parse
 */

/** How a file changed inside one commit. */
export type FileDiffStatus = 'added' | 'deleted' | 'renamed' | 'binary' | 'modified'

/** One rendered line of a file's diff. */
export interface DiffRow {
  kind: 'hunk' | 'context' | 'add' | 'del' | 'note'
  /** The line's number on the OLD side, or null for a line that side does not have. */
  oldLine: number | null
  /** The line's number on the NEW side, or null. */
  newLine: number | null
  /** The line's text, with git's leading marker removed. */
  text: string
}

/** One file's part of a commit. */
export interface FileDiff {
  path: string
  /** The pre-rename path, when the section renamed the file. */
  origPath?: string
  status: FileDiffStatus
  rows: DiffRow[]
  additions: number
  deletions: number
}

/** `@@ -oldStart,oldCount +newStart,newCount @@ context` — the counts are optional. */
const HUNK_HEADER = /^@@+ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

/** `diff --git a/<path> b/<path>`, only usable for plain (unquoted) paths. */
const DIFF_HEADER = /^diff --git a\/(.+) b\/(.+)$/

/**
 * The repo-relative path on one side of a `---`/`+++` line, or null for
 * `/dev/null` (which is what an added or deleted file shows on that side).
 */
function sidePath(line: string): string | null {
  // A timestamp may trail the path, separated by a tab.
  const value = line.split('\t')[0].trim()
  if (value === '/dev/null' || value === '') return null
  // Git quotes paths with special characters; the quotes are not part of it.
  const unquoted = value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value
  return unquoted.replace(/^[ab]\//, '')
}

/**
 * Split one commit's patch into per-file diffs, in the order git wrote them.
 * @param patch - the raw `git show --patch` text.
 * @returns one entry per `diff --git` section; a file whose section carries no
 *   `diff --git` header is dropped rather than guessed at.
 */
export function splitPatch(patch: string): FileDiff[] {
  const files: FileDiff[] = []
  let current: FileDiff | null = null
  let oldLine = 0
  let newLine = 0

  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const header = DIFF_HEADER.exec(line)
      current = {
        // The `+++`/`rename to` line refines this; the header is the fallback.
        path: header === null ? '' : header[2],
        status: 'modified',
        rows: [],
        additions: 0,
        deletions: 0,
      }
      files.push(current)
      oldLine = 0
      newLine = 0
      continue
    }
    if (current === null) continue

    // Section headers, which also carry the status.
    if (line.startsWith('new file mode')) { current.status = 'added'; continue }
    if (line.startsWith('deleted file mode')) { current.status = 'deleted'; continue }
    if (line.startsWith('rename from ')) {
      current.origPath = line.slice('rename from '.length)
      current.status = 'renamed'
      continue
    }
    if (line.startsWith('rename to ')) {
      current.path = line.slice('rename to '.length)
      current.status = 'renamed'
      continue
    }
    if (line.startsWith('--- ')) {
      const path = sidePath(line.slice(4))
      if (path !== null) current.origPath = path
      continue
    }
    if (line.startsWith('+++ ')) {
      const path = sidePath(line.slice(4))
      if (path !== null) current.path = path
      continue
    }
    if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
      current.status = 'binary'
      continue
    }
    // Purely mechanical headers a review does not show.
    if (line.startsWith('index ') || line.startsWith('old mode ') || line.startsWith('new mode ')
      || line.startsWith('similarity index ') || line.startsWith('dissimilarity index ')
      || line.startsWith('copy from ') || line.startsWith('copy to ')) continue

    const hunk = HUNK_HEADER.exec(line)
    if (hunk !== null) {
      oldLine = Number(hunk[1])
      newLine = Number(hunk[3])
      current.rows.push({ kind: 'hunk', oldLine: null, newLine: null, text: line })
      continue
    }
    if (line.startsWith('\\')) {
      // "\ No newline at end of file" belongs to the line above it.
      current.rows.push({ kind: 'note', oldLine: null, newLine: null, text: line })
      continue
    }
    if (line.startsWith('+')) {
      current.rows.push({ kind: 'add', oldLine: null, newLine, text: line.slice(1) })
      current.additions += 1
      newLine += 1
      continue
    }
    if (line.startsWith('-')) {
      current.rows.push({ kind: 'del', oldLine, newLine: null, text: line.slice(1) })
      current.deletions += 1
      oldLine += 1
      continue
    }
    if (line.startsWith(' ')) {
      current.rows.push({ kind: 'context', oldLine, newLine, text: line.slice(1) })
      oldLine += 1
      newLine += 1
    }
    // Anything else (an empty trailing line, a `@@` form we do not model) is not
    // a row: showing it would invent content.
  }

  return files.filter(file => file.path !== '')
}

/**
 * The raw text of ONE file's section inside a whole-side patch.
 *
 * The change list is handed both sides' patches whole (the same two git spawns
 * that produced the line counts), so opening a file only has to find its section
 * — no round trip, no parsing of the other files. Sections are located by the
 * `diff --git` header's trailing ` b/<path>`, which is exact rather than a prefix
 * match (`b/a.txt` never matches a section for `ba.txt`), and which holds because
 * the host asks git for unquoted paths (`core.quotePath=false`).
 *
 * A path containing a newline would write a header that runs over more than one
 * line; such a path simply is not found, and the caller fetches it the slow way.
 * @param patch - one side's whole patch (or a single file's patch).
 * @param path - the repo-relative path to cut out.
 * @param truncated - whether the patch was cut at the host's cap, in which case
 *   its LAST section may be missing its tail and is refused rather than shown
 *   incomplete.
 * @returns the section text, or null when it is absent or untrustworthy.
 */
export function sectionOf(patch: string, path: string, truncated: boolean): string | null {
  if (patch === '' || path === '') return null
  const needle = ` b/${path}`
  let at = patch.startsWith('diff --git ') ? 0 : patch.indexOf('\ndiff --git ')
  while (at >= 0) {
    const lineEnd = patch.indexOf('\n', at + 1)
    const header = lineEnd < 0 ? patch.slice(at) : patch.slice(at, lineEnd)
    const next = patch.indexOf('\ndiff --git ', lineEnd < 0 ? patch.length : lineEnd)
    if (header.endsWith(needle)) {
      if (next < 0) return truncated ? null : patch.slice(at)
      return patch.slice(at, next)
    }
    at = next
  }
  return null
}

/** What a line-selection action does with the chosen rows. */
export type SelectionDirection = 'stage' | 'unstage' | 'discard'

/**
 * Rebuild a patch for ONLY the chosen rows of one file's diff — what makes
 * line-level staging possible.
 *
 * The trick is what happens to the rows the user did NOT choose. Simply omitting
 * them would not apply, because the target's content has to match around every
 * hunk:
 *
 *   - `stage` targets the INDEX, whose content is the diff's OLD side. An unselected
 *     `+` line is not there and is not being added, so it is dropped; an unselected
 *     `-` line IS there and is staying, so it becomes CONTEXT.
 *   - `unstage` and `discard` target a file whose content is the diff's NEW side
 *     (the index for unstaging, the worktree for discarding), so they are the mirror
 *     image: an unselected `+` line is there and stays → context, an unselected `-`
 *     line is absent → dropped, and the chosen lines SWAP SIGN, because the patch
 *     takes the change back out instead of making it.
 *
 * Context rows always survive, so each hunk keeps the surroundings that make it
 * apply. `git apply --recount` re-derives the counts from the body; the starts are
 * kept as git reported them (the old side for `stage`, the new side otherwise) and
 * the counts are written correctly regardless.
 *
 * Renames are refused: a partial rename patch would have to carry the rename
 * headers, and applying one is a different operation from moving lines.
 * @param file - the parsed file, as `splitPatch` produced it.
 * @param selected - row indices (into `file.rows`) the user chose.
 * @param direction - which action the patch is for.
 * @returns the patch text, or null when nothing applicable was selected.
 */
export function selectionPatch(
  file: FileDiff,
  selected: ReadonlySet<number>,
  direction: SelectionDirection,
): string | null {
  if (file.status === 'renamed' || file.status === 'binary' || file.status === 'deleted' || selected.size === 0) return null
  const intoIndex = direction === 'stage'
  const hunks: string[] = []
  let current: string[] = []
  let header: string | null = null
  let oldStart = '0'
  let newStart = '0'
  let touched = false
  let emittedLast = false

  const flush = (): void => {
    if (header !== null && touched) {
      // Real counts, both sides, plus git's own trailing context: `--recount` would
      // forgive arithmetic, but a header has to be a header either way.
      const oldCount = current.filter(line => line.startsWith(' ') || line.startsWith('-')).length
      const newCount = current.filter(line => line.startsWith(' ') || line.startsWith('+')).length
      hunks.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@${header}`, ...current)
    }
    current = []
    header = null
    touched = false
    emittedLast = false
  }

  for (const [index, row] of file.rows.entries()) {
    if (row.kind === 'hunk') {
      flush()
      const parsed = HUNK_HEADER.exec(row.text)
      if (parsed === null) continue
      // The patch's OLD side is the target file's current content: the index for a
      // stage, and the diff's NEW side (also the index) for the two that take a
      // change back out. The other start is only a hint.
      oldStart = (intoIndex ? parsed[1] : parsed[3]) ?? '0'
      newStart = (intoIndex ? parsed[3] : parsed[1]) ?? '0'
      header = /^@@[^@]*@@(.*)$/.exec(row.text)?.[1] ?? ''
      continue
    }
    if (header === null) continue
    const chosen = selected.has(index)
    let line: string | null = null
    if (row.kind === 'context') {
      line = ` ${row.text}`
    } else if (row.kind === 'add') {
      if (chosen) {
        line = `${intoIndex ? '+' : '-'}${row.text}`
        touched = true
      } else if (!intoIndex) {
        // The target holds this line and it is staying.
        line = ` ${row.text}`
      }
    } else if (row.kind === 'del') {
      if (chosen) {
        line = `${intoIndex ? '-' : '+'}${row.text}`
        touched = true
      } else if (intoIndex) {
        // The index holds this line and it is staying.
        line = ` ${row.text}`
      }
    } else if (row.kind === 'note' && emittedLast) {
      // "\ No newline at end of file" only means something right after the line it
      // describes.
      line = row.text
    }
    if (line === null) continue
    current.push(line)
    emittedLast = true
  }
  flush()
  if (hunks.length === 0) return null

  const path = file.path
  const headers = [`diff --git a/${path} b/${path}`]
  // The creation form is only right when the INDEX is gaining a file it has never
  // seen. Discarding lines out of a worktree file git has not seen yet still edits a
  // file that is right there, so that takes the ordinary two-sided header.
  if (intoIndex && file.status === 'added') headers.push('new file mode 100644', '--- /dev/null', `+++ b/${path}`)
  else headers.push(`--- a/${path}`, `+++ b/${path}`)
  return `${[...headers, ...hunks].join('\n')}\n`
}

/** One row of the changed-file list: the host's statistics plus the parsed diff. */
export interface ReviewFile {
  path: string
  additions: number
  deletions: number
  binary: boolean
  status: FileDiffStatus
  /** The file's rows, or null when the patch carries no section for it (truncated). */
  diff: FileDiff | null
}

/**
 * Join the host's per-file statistics with the parsed sections, so the list shows
 * every changed file even when the patch was truncated, and a rename contributes
 * one row rather than the delete+add pair `--numstat --no-renames` reports.
 * @param files - the commit's file statistics (`git show --numstat`).
 * @param sections - the parsed patch sections.
 * @returns the files to list, in the patch's order, with stat-only files appended.
 */
export function reviewFiles(
  files: readonly { path: string; additions: number; deletions: number; binary: boolean }[],
  sections: readonly FileDiff[],
): ReviewFile[] {
  const byPath = new Map(files.map(file => [file.path, file]))
  const listed = new Set<string>()
  const rows: ReviewFile[] = []

  for (const section of sections) {
    const stat = byPath.get(section.path)
    listed.add(section.path)
    rows.push({
      path: section.path,
      // The section's own counts are what the viewer's rows add up to; git's
      // numstat is the fallback when a section was not counted.
      additions: stat === undefined ? section.additions : stat.additions,
      deletions: stat === undefined ? section.deletions : stat.deletions,
      binary: stat === undefined ? section.status === 'binary' : stat.binary,
      status: section.status,
      diff: section,
    })
  }

  const renamedFrom = new Set(sections.map(section => section.origPath).filter(path => path !== undefined))
  for (const file of files) {
    if (listed.has(file.path) || renamedFrom.has(file.path)) continue
    rows.push({ ...file, status: file.binary ? 'binary' : 'modified', diff: null })
  }
  return rows
}
