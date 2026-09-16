// @vitest-environment jsdom
/**
 * The change list's preview must be the History tab's diff pane: the same header,
 * the same viewer, the same rows.
 *
 * It used to paint the raw patch text with a prefix-tint renderer of its own:
 * git's `diff --git` / `index` plumbing on screen, no line-number gutters, no
 * marker column, and a different type size for the same file. These tests pin the
 * parts that made the two tabs look like two different tools.
 */
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { DetailPane } from '../src/client/git/DetailPane.tsx'
import { DiffFileView } from '../src/client/git/DiffFileView.tsx'
import { splitPatch } from '../src/client/git/diff-parse.ts'
import type { DiffView } from '../src/core/types.ts'

const t = ((key: string) => key) as never

/** One file's patch, in git's own shape. */
const PATCH = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 1111111..2222222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,3 +1,4 @@',
  ' const first = 1',
  '-const second = 2',
  '+const second = 22',
  '+const inserted = 3',
  ' const third = 3',
].join('\n')

function diffOf(over: Partial<DiffView> = {}): DiffView {
  return { path: 'src/a.ts', staged: false, binary: false, truncated: false, patch: PATCH, ...over }
}

/** One rendered row's cells: old number, new number, marker, text. */
const anatomy = (row: Element): string[] => [...row.children].map(cell => cell.textContent ?? '')

/** The preview mounted on one change row. */
function preview(props: Partial<Parameters<typeof DetailPane>[0]> = {}) {
  return render(
    <DetailPane
      selection={{ path: 'src/a.ts', staged: false }}
      diff={diffOf()}
      loading={false}
      stat={{ additions: 2, deletions: 1 }}
      t={t}
      {...props}
    />,
  )
}

afterEach(cleanup)

describe('the change list preview', () => {
  it('renders the review viewer row for row, not the raw patch text', () => {
    const { container } = preview()
    const rows = [...container.querySelectorAll('[data-diff-kind]')]
    const section = splitPatch(PATCH)[0]
    if (section === undefined) throw new Error('the patch did not parse')
    const review = render(<DiffFileView file={section} t={t} />).container
    const expected = [...review.querySelectorAll('[data-diff-kind]')]

    expect(rows.length).toBe(expected.length)
    // Old number, new number, marker, text — the same cells in the same order.
    expect(rows.map(anatomy)).toEqual(expected.map(anatomy))
    expect(rows.length).toBeGreaterThan(3)
  })

  it('keeps git\'s plumbing off the screen', () => {
    // The header lines the old renderer printed are not rows at all: `diff --git`,
    // `index`, `---`/`+++` carry no line numbers and no reader needs them.
    const { container } = preview()
    expect(container.textContent).not.toContain('diff --git')
    expect(container.textContent).not.toContain('index 1111111')
    expect(container.textContent).not.toContain('+++ b/')
    // The hunk header stays, as the separator row it is.
    expect(container.textContent).toContain('@@ -1,3 +1,4 @@')
  })

  it('heads the preview with the same split path and counts the row shows', () => {
    const { container } = preview()
    const head = container.querySelector('[data-gitgraph-diff-head="changes"]')
    expect(head).not.toBeNull()
    expect(head?.querySelector('[data-gitgraph-file-name]')?.textContent).toBe('a.ts')
    expect(head?.querySelector('[data-gitgraph-file-stat]')?.textContent).toBe('+2−1')
    // The one thing this head adds: which side of the index is on show.
    expect(head?.textContent).toContain('git.diff.unstaged')
  })

  it('says so in the pane when there is no diff to view', () => {
    const binary = preview({ diff: diffOf({ binary: true, patch: '' }) })
    expect(binary.container.querySelector('[data-diff-kind]')).toBeNull()
    expect(binary.container.textContent).toContain('git.diff.binary')

    const missing = preview({ diff: null })
    expect(missing.container.querySelector('[data-diff-kind]')).toBeNull()
    expect(missing.container.textContent).toContain('git.diff.empty')

    const headersOnly = preview({ diff: diffOf({ patch: 'diff --git a/x b/x\nindex 1..2 100644' }) })
    expect(headersOnly.container.querySelector('[data-diff-kind]')).toBeNull()
    expect(headersOnly.container.textContent).toContain('git.diff.empty')
  })

  it('shows the pick prompt and no header at all with nothing selected', () => {
    const { container } = preview({ selection: null, diff: null, stat: undefined })
    expect(container.textContent).toContain('git.diff.select')
    expect(container.querySelector('[data-gitgraph-diff-head]')).toBeNull()
  })
})
