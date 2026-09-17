// @vitest-environment jsdom
/**
 * A background refresh must not disturb a preview the reader is working in.
 *
 * The host pushes workspace changes (SSE, the 30s poll, a window focus) and every
 * push re-resolves the open preview against fresh patches. That refresh used to
 * clear the whole viewer: the line selection went with it, and a path the batch
 * could not answer (an untracked file, or a section the cap cut short) blanked the
 * pane for a host round trip, which unmounted the rows and sent the scroll position
 * back to the top. These tests pin the opposite: a refresh that reports the SAME
 * rows leaves the selection and the mounted rows exactly where they were, and a
 * refresh that really changed the diff is still allowed to drop the selection.
 */
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { GitView } from '../src/client/git/GitView.tsx'
import type { GitPanelInjected } from '../src/client/index.ts'
import type { CommitDetail, DiffView, FileChange, StatusFilesView } from '../src/core/types.ts'

const t = ((key: string) => key) as never

/** One tracked file's worktree patch; rows 2 and 3 are the `-`/`+` pair. */
const TRACKED_PATCH = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 1111111..2222222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,3 +1,4 @@',
  ' keep one',
  '-old two',
  '+new two',
  ' keep three',
  '',
].join('\n')

/** The same file's patch after the marker text changed — a genuinely new diff. */
const TRACKED_PATCH_CHANGED = TRACKED_PATCH.replace('+new two', '+new two changed')

/** An untracked file's patch, which no batch of the status view can answer. */
const UNTRACKED_PATCH = [
  'diff --git a/new.txt b/new.txt',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/new.txt',
  '@@ -0,0 +1,2 @@',
  '+hello',
  '+world',
  '',
].join('\n')

function tracked(path: string): FileChange {
  return {
    path, index: ' ', worktree: 'M', kind: 'modified', staged: false, conflicted: false, untracked: false,
    worktreeStat: { additions: 1, deletions: 1 },
  }
}

function untracked(path: string): FileChange {
  return { path, index: '?', worktree: '?', kind: 'untracked', staged: false, conflicted: false, untracked: true }
}

function statusOf(files: FileChange[], patches: { worktree: string; staged: string }): StatusFilesView {
  return {
    root: '/repo',
    branch: 'main',
    head: 'a'.repeat(40),
    files,
    stagedCount: 0,
    unstagedCount: files.length,
    untrackedCount: files.filter(file => file.untracked).length,
    conflictedCount: 0,
    operationInProgress: false,
    operation: '',
    upstream: '',
    behind: 0,
    ahead: 0,
    remotes: [],
    patches: { ...patches, truncated: false },
  }
}

function diffOf(path: string, patch: string): DiffView {
  return { path, staged: false, binary: false, truncated: false, patch }
}

/** Mount GitView over recorded verbs, and hand back its change-push trigger. */
function mountView(
  currentStatus: () => StatusFilesView,
  perFile: (path: string) => DiffView | null,
  overrides: Partial<GitPanelInjected> = {},
): { container: HTMLElement; refresh: () => void } {
  let onChange: (() => void) | null = null
  const injected: GitPanelInjected = {
    files: async () => currentStatus(),
    branches: async () => null,
    switchBranch: async () => ({ ok: false, error: { code: 'internal', message: 'x' } }),
    diff: async (_session, path) => perFile(path),
    stage: async () => ({ ok: true, summary: '' }),
    unstage: async () => ({ ok: true, summary: '' }),
    discard: async () => ({ ok: true, summary: '' }),
    applySelection: async () => ({ ok: true, summary: '' }),
    commit: async () => ({ ok: false, error: { code: 'internal', message: 'x' } }),
    history: async () => null,
    commitDetail: async () => null,
    remote: async () => null,
    fetch: async () => ({ ok: true, summary: '' }),
    pull: async () => ({ ok: true, summary: '' }),
    push: async () => ({ ok: true, summary: '' }),
    merge: async () => ({ ok: true, summary: '' }),
    rebase: async () => ({ ok: true, summary: '' }),
    abortOperation: async () => ({ ok: true, summary: '' }),
    subscribeChanges: (_session, callback) => {
      onChange = callback
      return () => { onChange = null }
    },
    ...overrides,
  }
  const props = { sessionId: 'session', t, ...injected }
  const { container } = render(<GitView {...(props as never)} />)
  return {
    container,
    refresh: () => { onChange?.() },
  }
}

function rowNode(container: HTMLElement, index: number): Element | null {
  return container.querySelector(`[data-diff-index="${index}"]`)
}

/** Drag across a row range through the gutters, the pointer gesture the viewer answers to. */
function selectRows(container: HTMLElement, from: number, to: number): void {
  const gutter = (index: number): Element => {
    const cell = rowNode(container, index)?.querySelector('[data-diff-gutter]')
    if (cell === null || cell === undefined) throw new Error(`row ${index} has no gutter`)
    return cell
  }
  const at = (y: number): MouseEventInit => ({ bubbles: true, button: 0, clientX: 10, clientY: y })
  fireEvent(gutter(from), new MouseEvent('pointerdown', at(10)))
  fireEvent(gutter(to), new MouseEvent('pointermove', at(60)))
  fireEvent(gutter(to), new MouseEvent('pointerup', at(60)))
}

afterEach(cleanup)

describe('the preview under a background refresh', () => {
  it('keeps a line selection when the refresh reports the same rows', async () => {
    const patches = { worktree: TRACKED_PATCH, staged: '' }
    const { container, refresh } = mountView(
      () => statusOf([tracked('src/a.ts')], patches),
      path => diffOf(path, TRACKED_PATCH),
    )
    await waitFor(() => { expect(container.querySelector('[data-gitgraph-file="src/a.ts"]')).not.toBeNull() })
    fireEvent.click(container.querySelector('[data-gitgraph-file="src/a.ts"]') as HTMLElement)
    await waitFor(() => { expect(rowNode(container, 2)).not.toBeNull() })
    selectRows(container, 2, 3)
    expect(container.querySelector('[data-gitgraph-line-bar]')).not.toBeNull()
    const chosen = rowNode(container, 2)

    await act(async () => { refresh() })

    await waitFor(() => { expect(container.querySelector('[data-gitgraph-line-bar]')).not.toBeNull() })
    expect(container.querySelectorAll('[class*="_diffRowChosen"]')).toHaveLength(2)
    // The same DOM row, not a re-mounted copy: the scroll position rides on it.
    expect(rowNode(container, 2)).toBe(chosen)
  })

  it('does not tear the viewer down for a path the batch cannot answer', async () => {
    const patches = { worktree: '', staged: '' }
    const { container, refresh } = mountView(
      () => statusOf([untracked('new.txt')], patches),
      path => diffOf(path, UNTRACKED_PATCH),
    )
    await waitFor(() => { expect(container.querySelector('[data-gitgraph-file="new.txt"]')).not.toBeNull() })
    fireEvent.click(container.querySelector('[data-gitgraph-file="new.txt"]') as HTMLElement)
    await waitFor(() => { expect(rowNode(container, 1)).not.toBeNull() })
    selectRows(container, 1, 2)
    expect(container.querySelector('[data-gitgraph-line-bar]')).not.toBeNull()
    const chosen = rowNode(container, 1)

    await act(async () => { refresh() })

    await waitFor(() => { expect(rowNode(container, 1)).not.toBeNull() })
    // Same node means the pane was never unmounted, so its scroll position survived.
    expect(rowNode(container, 1)).toBe(chosen)
    expect(container.querySelector('[data-gitgraph-line-bar]')).not.toBeNull()
  })

  it('still drops the selection when the refresh reports a different diff', async () => {
    const patches = { worktree: TRACKED_PATCH, staged: '' }
    const { container, refresh } = mountView(
      () => statusOf([tracked('src/a.ts')], patches),
      path => diffOf(path, patches.worktree),
    )
    await waitFor(() => { expect(container.querySelector('[data-gitgraph-file="src/a.ts"]')).not.toBeNull() })
    fireEvent.click(container.querySelector('[data-gitgraph-file="src/a.ts"]') as HTMLElement)
    await waitFor(() => { expect(rowNode(container, 2)).not.toBeNull() })
    selectRows(container, 2, 3)
    expect(container.querySelector('[data-gitgraph-line-bar]')).not.toBeNull()

    patches.worktree = TRACKED_PATCH_CHANGED
    await act(async () => { refresh() })

    await waitFor(() => { expect(container.textContent).toContain('new two changed') })
    expect(container.querySelector('[data-gitgraph-line-bar]')).toBeNull()
    expect(container.querySelectorAll('[class*="_diffRowChosen"]')).toHaveLength(0)
  })
})


/** A two-file commit the History tab can review: one patch section per file. */
function twoFilePatch(): string {
  return [
    'diff --git a/a.txt b/a.txt',
    'index 1111111..2222222 100644',
    '--- a/a.txt',
    '+++ b/a.txt',
    '@@ -1,2 +1,3 @@',
    ' one',
    '+two',
    ' three',
    'diff --git a/b.txt b/b.txt',
    'index 3333333..4444444 100644',
    '--- a/b.txt',
    '+++ b/b.txt',
    '@@ -1,2 +1,3 @@',
    ' alpha',
    '+beta',
    ' gamma',
    '',
  ].join('\n')
}

const REVIEW_COMMIT = {
  oid: 'b'.repeat(40),
  shortOid: 'bbbbbbb',
  parents: [],
  subject: 'change two files',
  author: 'tester',
  authorEmail: 't@dsh.local',
  authorTime: 1_700_000_000,
  refs: [],
}

/** A fresh detail object per call, the way the host answers each fetch. */
function detailOf(): CommitDetail {
  return {
    ...REVIEW_COMMIT,
    body: '',
    committer: 'tester',
    committerTime: 1_700_000_000,
    files: [
      { path: 'a.txt', additions: 1, deletions: 0, binary: false },
      { path: 'b.txt', additions: 1, deletions: 0, binary: false },
    ],
    patch: twoFilePatch(),
    truncated: false,
  }
}

/**
 * A commit whose patch the host CAPPED: the shape a commit touching more files
 * than the cap allows comes back in. Every file still carries its numstat row —
 * that is a different spawn — while the patch stops inside the first file, so the
 * sections and the file list disagree, which is exactly the state that produced
 * "the diff was too large" for every file.
 */
function cappedDetail(): CommitDetail {
  const full = twoFilePatch()
  return { ...detailOf(), patch: full.slice(0, full.indexOf('diff --git a/b.txt')), truncated: true }
}

/** One file's section out of the two-file patch, the shape `git show <oid> -- <path>` answers in. */
function sectionFor(file: string): string {
  const full = twoFilePatch()
  const at = full.indexOf(`diff --git a/${file} `)
  if (at < 0) return ''
  const rest = full.slice(at)
  const nextAt = rest.indexOf('diff --git a/', 10)
  return nextAt < 0 ? rest : rest.slice(0, nextAt)
}

/** Open the History tab and pick the one commit it lists. */
async function openCommit(container: HTMLElement): Promise<void> {
  fireEvent.click(container.querySelector('[data-gitgraph-tab="history"]') as HTMLElement)
  const row = '[data-gitgraph-commit-oid="' + REVIEW_COMMIT.oid + '"]'
  await waitFor(() => { expect(container.querySelector(row)).not.toBeNull() })
  fireEvent.click(container.querySelector(row) as HTMLElement)
}

describe('the commit review under a background refresh', () => {
  it('keeps the picked file and the mounted diff while the same commit re-fetches', async () => {
    const { container, refresh } = mountView(
      () => statusOf([tracked('src/a.ts')], { worktree: TRACKED_PATCH, staged: '' }),
      path => diffOf(path, TRACKED_PATCH),
      {
        history: async () => ({ root: '/repo', branch: 'main', commits: [REVIEW_COMMIT], hasMore: false }),
        commitDetail: async () => detailOf(),
      },
    )
    fireEvent.click(container.querySelector('[data-gitgraph-tab="history"]') as HTMLElement)
    const commitRow = '[data-gitgraph-commit-oid="' + REVIEW_COMMIT.oid + '"]'
    await waitFor(() => { expect(container.querySelector(commitRow)).not.toBeNull() })
    fireEvent.click(container.querySelector(commitRow) as HTMLElement)
    await waitFor(() => { expect(container.querySelector('[data-gitgraph-review-file="b.txt"]')).not.toBeNull() })

    // Pick the SECOND file, so a reset of the review's own state is visible.
    fireEvent.click(container.querySelector('[data-gitgraph-review-file="b.txt"]') as HTMLElement)
    await waitFor(() => {
      expect(container.querySelector('[data-gitgraph-review-file="b.txt"]')?.getAttribute('aria-pressed')).toBe('true')
    })
    const diffRow = container.querySelector('[data-gitgraph-part="review-diff"] [data-diff-index="2"]')
    expect(diffRow).not.toBeNull()

    await act(async () => { refresh() })

    // The pane never emptied: no "pick a commit" note, the same picked file, the same node.
    expect(container.textContent).not.toContain('git.history.select')
    await waitFor(() => {
      expect(container.querySelector('[data-gitgraph-review-file="b.txt"]')?.getAttribute('aria-pressed')).toBe('true')
    })
    expect(container.querySelector('[data-gitgraph-part="review-diff"] [data-diff-index="2"]')).toBe(diffRow)
  })
})

/** The verbs that open one commit, with whatever the case under test adds. */
function reviewVerbs(detail: CommitDetail, extra: Partial<GitPanelInjected> = {}): Partial<GitPanelInjected> {
  return {
    history: async () => ({ root: '/repo', branch: 'main', commits: [REVIEW_COMMIT], hasMore: false }),
    commitDetail: async () => detail,
    ...extra,
  }
}

/**
 * A capped commit review has to survive a shell that cannot fetch single files.
 *
 * This is the regression that took the whole History tab down once: the per-file
 * verb was passed down as a wrapper that closed over a missing `props.commitDiff`,
 * so the review's guard saw a function, called it, and threw inside an effect —
 * which React answers by unmounting the tree. The verb is optional now, and the
 * guard sits on the verb itself; these tests pin both halves.
 */
describe('the commit review of a capped commit', () => {
  it('keeps the whole review standing when the shell cannot fetch a single file', async () => {
    const { container } = mountView(
      () => statusOf([tracked('src/a.ts')], { worktree: TRACKED_PATCH, staged: '' }),
      path => diffOf(path, TRACKED_PATCH),
      reviewVerbs(cappedDetail(), { commitDiff: undefined }),
    )
    await openCommit(container)

    // The bar, the file list and both rows are still there: an absent verb changes
    // what the diff pane says, never whether the review renders at all.
    await waitFor(() => { expect(container.querySelector('[data-gitgraph-review-oid]')).not.toBeNull() })
    expect(container.querySelector('[data-gitgraph-review-file="a.txt"]')).not.toBeNull()
    expect(container.querySelector('[data-gitgraph-review-file="b.txt"]')).not.toBeNull()
    expect(container.textContent).toContain('git.review.count')

    const pane = container.querySelector('[data-gitgraph-part="review-diff"]')
    expect(pane?.querySelector('[data-diff-kind]')).toBeNull()
    expect(pane?.textContent).toContain('git.review.truncated')
  })

  it('fetches the file the capped patch left out, one file at a time', async () => {
    const asked: string[] = []
    const { container } = mountView(
      () => statusOf([tracked('src/a.ts')], { worktree: TRACKED_PATCH, staged: '' }),
      path => diffOf(path, TRACKED_PATCH),
      reviewVerbs(cappedDetail(), {
        commitDiff: async (_session, oid, file) => {
          asked.push(`${oid}|${file}`)
          return { path: file, binary: false, truncated: false, patch: sectionFor(file), before: 8, after: 9 }
        },
      }),
    )
    await openCommit(container)

    // The first file is picked for the reader, so its patch is what gets asked for.
    await waitFor(() => { expect(asked).toContain(`${REVIEW_COMMIT.oid}|a.txt`) })
    await waitFor(() => {
      expect(container.querySelector('[data-gitgraph-part="review-diff"] [data-diff-kind]')).not.toBeNull()
    })

    // Picking the second file asks for THAT one — the point of the route.
    fireEvent.click(container.querySelector('[data-gitgraph-review-file="b.txt"]') as HTMLElement)
    await waitFor(() => { expect(asked).toContain(`${REVIEW_COMMIT.oid}|b.txt`) })
    await waitFor(() => {
      expect(container.querySelector('[data-gitgraph-part="review-diff"] [data-diff-kind]')).not.toBeNull()
    })
    // Two fetches and no more: a resolved file is not asked for again.
    expect(asked).toHaveLength(2)
  })

  it('falls back to the note, without throwing, when the fetch fails', async () => {
    const { container } = mountView(
      () => statusOf([tracked('src/a.ts')], { worktree: TRACKED_PATCH, staged: '' }),
      path => diffOf(path, TRACKED_PATCH),
      reviewVerbs(cappedDetail(), {
        commitDiff: async () => { throw new Error('route unavailable') },
      }),
    )
    await openCommit(container)

    await waitFor(() => {
      expect(container.querySelector('[data-gitgraph-part="review-diff"]')?.textContent).toContain('git.review.truncated')
    })
    // The review is intact around the pane, and the failure was not retried forever.
    expect(container.querySelector('[data-gitgraph-review-file="a.txt"]')).not.toBeNull()
    expect(container.querySelector('[data-gitgraph-review-file="b.txt"]')).not.toBeNull()
  })

  it('survives a verb that throws synchronously instead of rejecting', async () => {
    // Not a hypothetical shape: the promise chain alone does not cover it, and a
    // throw inside an effect is what unmounts the whole view.
    const { container } = mountView(
      () => statusOf([tracked('src/a.ts')], { worktree: TRACKED_PATCH, staged: '' }),
      path => diffOf(path, TRACKED_PATCH),
      reviewVerbs(cappedDetail(), {
        commitDiff: () => { throw new Error('thrown, not rejected') },
      }),
    )
    await openCommit(container)

    await waitFor(() => {
      expect(container.querySelector('[data-gitgraph-part="review-diff"]')?.textContent).toContain('git.review.truncated')
    })
    expect(container.querySelector('[data-gitgraph-review-oid]')).not.toBeNull()
    expect(container.querySelector('[data-gitgraph-review-file="b.txt"]')).not.toBeNull()
  })
})

/** One binary file's section: a status line, and no rows to draw from it. */
const BINARY_PATCH = [
  'diff --git a/logo.png b/logo.png',
  'index 1111111..2222222 100644',
  'Binary files a/logo.png and b/logo.png differ',
  '',
].join('\n')

/** A commit whose only changed file is binary: nothing to diff, and a size on each side. */
function binaryDetail(): CommitDetail {
  return {
    ...detailOf(),
    files: [{ path: 'logo.png', additions: 0, deletions: 0, binary: true }],
    patch: '',
    truncated: false,
  }
}

/**
 * A file with no lines to show still has to say something.
 *
 * "No textual diff" covers a 4 KB stub and a 400 MB asset alike, so the pane
 * reports what the file changed BETWEEN — the two blob sizes — which is the only
 * fact left once the text is gone.
 */
describe('the sizes of a file with no lines to show', () => {
  const sized = (before: number | null, after: number | null): Partial<GitPanelInjected> => ({
    commitDiff: async (_session, _oid, file) => ({
      path: file, binary: true, truncated: false, patch: BINARY_PATCH, before, after,
    }),
  })

  it('reports what a binary file changed between', async () => {
    const { container } = mountView(
      () => statusOf([tracked('src/a.ts')], { worktree: TRACKED_PATCH, staged: '' }),
      path => diffOf(path, TRACKED_PATCH),
      reviewVerbs(binaryDetail(), sized(1024, 4096)),
    )
    await openCommit(container)

    await waitFor(() => {
      expect(container.querySelector('[data-gitgraph-file-size="logo.png"]')).not.toBeNull()
    })
    const pane = container.querySelector('[data-gitgraph-part="review-diff"]')
    // Both notes: what kind of file it is, and how big it became.
    expect(pane?.textContent).toContain('git.review.binary')
    expect(pane?.textContent).toContain('git.review.size')
  })

  it('names an absent side rather than printing zero bytes', async () => {
    // A binary file the commit ADDED has no previous version. "0 B → 4 KB" would
    // describe a file that never existed.
    const { container } = mountView(
      () => statusOf([tracked('src/a.ts')], { worktree: TRACKED_PATCH, staged: '' }),
      path => diffOf(path, TRACKED_PATCH),
      reviewVerbs(binaryDetail(), sized(null, 4096)),
    )
    await openCommit(container)

    await waitFor(() => {
      expect(container.querySelector('[data-gitgraph-file-size="logo.png"]')).not.toBeNull()
    })
  })

  it('leaves the sizes off a file whose diff has lines to read', async () => {
    const { container } = mountView(
      () => statusOf([tracked('src/a.ts')], { worktree: TRACKED_PATCH, staged: '' }),
      path => diffOf(path, TRACKED_PATCH),
      reviewVerbs(detailOf(), sized(8, 9)),
    )
    await openCommit(container)

    await waitFor(() => { expect(container.querySelector('[data-gitgraph-review-file="a.txt"]')).not.toBeNull() })
    await waitFor(() => {
      expect(container.querySelector('[data-gitgraph-part="review-diff"] [data-diff-kind]')).not.toBeNull()
    })
    expect(container.querySelector('[data-gitgraph-file-size]')).toBeNull()
  })
})

/**
 * A newly picked file has to be read from its FIRST line: the scroll offset belongs to
 * the file the reader was looking at, not to the pane. A refresh of the same file is
 * the opposite case — the key is unchanged, the scroller is not rebuilt, and the
 * reader's place stands.
 */
describe('the preview scroll when switching files', () => {
  it('starts a newly picked change file at the top', async () => {
    const patchB = TRACKED_PATCH.replaceAll('src/a.ts', 'src/b.ts')
    const patches = { worktree: [TRACKED_PATCH, patchB].join('\n'), staged: '' }
    const { container } = mountView(
      () => statusOf([tracked('src/a.ts'), tracked('src/b.ts')], patches),
      path => diffOf(path, path === 'src/a.ts' ? TRACKED_PATCH : patchB),
    )
    const fileRow = (path: string): Element | null => container.querySelector('[data-gitgraph-file="' + path + '"]')
    const scrollerOf = (path: string): HTMLElement | null =>
      container.querySelector('[data-gitgraph-diff="' + path + '"]')?.parentElement ?? null

    await waitFor(() => { expect(fileRow('src/a.ts')).not.toBeNull() })
    fireEvent.click(fileRow('src/a.ts') as HTMLElement)
    await waitFor(() => { expect(scrollerOf('src/a.ts')).not.toBeNull() })
    const first = scrollerOf('src/a.ts') as HTMLElement
    first.scrollTop = 120
    first.scrollLeft = 40
    expect(first.scrollTop).toBe(120)

    fireEvent.click(fileRow('src/b.ts') as HTMLElement)
    await waitFor(() => { expect(scrollerOf('src/b.ts')).not.toBeNull() })
    const second = scrollerOf('src/b.ts') as HTMLElement
    // A different scroller element means the offset could not carry over.
    expect(second).not.toBe(first)
    expect(second.scrollTop).toBe(0)
    expect(second.scrollLeft).toBe(0)
  })

  it('starts a newly picked review file at the top', async () => {
    const { container } = mountView(
      () => statusOf([tracked('src/a.ts')], { worktree: TRACKED_PATCH, staged: '' }),
      path => diffOf(path, TRACKED_PATCH),
      {
        history: async () => ({ root: '/repo', branch: 'main', commits: [REVIEW_COMMIT], hasMore: false }),
        commitDetail: async () => detailOf(),
      },
    )
    fireEvent.click(container.querySelector('[data-gitgraph-tab="history"]') as HTMLElement)
    const commitRow = '[data-gitgraph-commit-oid="' + REVIEW_COMMIT.oid + '"]'
    await waitFor(() => { expect(container.querySelector(commitRow)).not.toBeNull() })
    fireEvent.click(container.querySelector(commitRow) as HTMLElement)
    const reviewFile = (path: string): Element | null =>
      container.querySelector('[data-gitgraph-review-file="' + path + '"]')
    const scrollerOf = (path: string): HTMLElement | null =>
      container.querySelector('[data-gitgraph-part="review-diff"] [data-gitgraph-diff="' + path + '"]')?.parentElement ?? null
    await waitFor(() => { expect(reviewFile('b.txt')).not.toBeNull() })

    // The first file is picked by default.
    await waitFor(() => { expect(scrollerOf('a.txt')).not.toBeNull() })
    const first = scrollerOf('a.txt') as HTMLElement
    first.scrollTop = 90
    expect(first.scrollTop).toBe(90)

    fireEvent.click(reviewFile('b.txt') as HTMLElement)
    await waitFor(() => { expect(scrollerOf('b.txt')).not.toBeNull() })
    expect(scrollerOf('b.txt')).not.toBe(first)
    expect((scrollerOf('b.txt') as HTMLElement).scrollTop).toBe(0)
  })
})
