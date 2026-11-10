// @vitest-environment jsdom
/**
 * A commit touching twelve thousand files has to open like any other.
 *
 * The review used to mount one row per changed file, so selecting a huge commit
 * built tens of thousands of DOM nodes before the pane appeared — and every SSE
 * refresh re-rendered them all. These tests pin the windowed list: the DOM holds
 * only the rows around the viewport, the header still reports the real count, the
 * list still scrolls, and picking a visible row still swaps the diff beside it.
 *
 * jsdom measures everything as zero, which is why the window has a fallback
 * viewport and why the scroll assertions fire a real `scroll` event instead of
 * relying on layout.
 *
 * The last case covers the other half of the fix: a commit detail fetched once is
 * reused for the same oid, so the SSE refresh that re-runs the fetch effect does
 * not re-fetch (and re-render) a commit that cannot have changed.
 */
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { CommitReview } from '../src/client/git/CommitReview.tsx'
import { GitView, type GitViewProps } from '../src/client/git/GitView.tsx'
import { FALLBACK_VIEWPORT, windowOf } from '../src/client/git/virtual-window.ts'
import type { GitPanelInjected } from '../src/client/index.ts'
import type { CommitDetail, StatusFilesView } from '../src/core/types.ts'

/**
 * The render key with its count parameter appended, so a test can read what the
 * header was handed: `git.review.count:12593`.
 */
const t = ((key: string, params?: Record<string, unknown>) => {
  const count = params?.count
  return typeof count === 'number' ? `${key}:${count}` : key
}) as never

const FILE_COUNT = 12_593
/** A file deep enough into the list that only a scrolled window can contain it. */
const DEEP_INDEX = 5_000
const DEEP_PATH = `dir/file-${String(DEEP_INDEX).padStart(5, '0')}.txt`
const FIRST_PATH = 'dir/file-00000.txt'
/** The row height the window math assumes; it is `.reviewFileRow`'s height too. */
const ROW_HEIGHT = 22

/** One huge commit: every file in it, and a patch the host capped away entirely. */
function bigDetail(): CommitDetail {
  return {
    oid: 'c'.repeat(40),
    shortOid: 'ccccccc',
    parents: [],
    subject: 'touch twelve thousand files',
    body: '',
    author: 'tester',
    authorEmail: 't@dsh.local',
    authorTime: 1_700_000_000,
    committer: 'tester',
    committerTime: 1_700_000_000,
    files: Array.from({ length: FILE_COUNT }, (_, index) => ({
      path: `dir/file-${String(index).padStart(5, '0')}.txt`,
      additions: 1,
      deletions: 0,
      binary: false,
    })),
    patch: '',
    truncated: false,
  }
}

/** Render the review on its own: it is a pure component over the detail. */
function renderReview(detail: CommitDetail): HTMLElement {
  const { container } = render(<CommitReview detail={detail} loading={false} root="/repo" t={t} />)
  return container
}

/** The element the file list scrolls in. */
function scrollerOf(container: HTMLElement): HTMLElement {
  const scroller = container.querySelector('[data-gitgraph-review-scroll]')
  if (!(scroller instanceof HTMLElement)) throw new Error('the review has no file-list scroller')
  return scroller
}

afterEach(cleanup)

describe('windowOf', () => {
  it('covers the viewport plus overscan and pads out to the full list height', () => {
    const win = windowOf(10_000, 20, 400, 2_000, 5)
    expect(win.start).toBe(95)
    expect(win.end).toBe(125)
    expect(win.paddingTop).toBe(95 * 20)
    expect(win.paddingBottom).toBe((10_000 - 125) * 20)
    // The mounted rows plus both spacers are exactly the full list's height, which
    // is what keeps the scrollbar proportional.
    expect(win.paddingTop + (win.end - win.start) * 20 + win.paddingBottom).toBe(10_000 * 20)
  })

  it('falls back to a usable viewport when the scroller cannot be measured', () => {
    // jsdom reports clientHeight 0 for everything; rendering nothing would leave
    // the list blank until some unrelated update re-measured it.
    const win = windowOf(1_000, ROW_HEIGHT, 0, 0)
    expect(win.paddingTop).toBe(0)
    expect(win.end).toBe(Math.ceil(FALLBACK_VIEWPORT / ROW_HEIGHT))
  })

  it('keeps the last row rendered when the offset is past the content', () => {
    const win = windowOf(10, ROW_HEIGHT, 0, 10_000)
    expect(win.start).toBe(9)
    expect(win.end).toBe(10)
    expect(win.paddingTop).toBe(9 * ROW_HEIGHT)
    expect(win.paddingBottom).toBe(0)
  })

  it('renders nothing for an empty list', () => {
    expect(windowOf(0, ROW_HEIGHT, 600, 0)).toEqual({ start: 0, end: 0, paddingTop: 0, paddingBottom: 0 })
  })
})

describe('the review file list of a huge commit', () => {
  it('mounts only the rows around the viewport but still reports the full count', async () => {
    const container = renderReview(bigDetail())
    await waitFor(() => { expect(container.querySelector('[data-gitgraph-review-file]')).not.toBeNull() })

    const rows = container.querySelectorAll('[data-gitgraph-review-file]')
    expect(rows.length).toBeLessThan(200)
    expect(rows.length).toBeGreaterThan(0)
    // The header reads the commit, not the window.
    expect(container.textContent).toContain(`git.review.count:${FILE_COUNT}`)
    // The first rows are the first files; a row five thousand deep is not mounted.
    expect(container.querySelector(`[data-gitgraph-review-file="${FIRST_PATH}"]`)).not.toBeNull()
    expect(container.querySelector(`[data-gitgraph-review-file="${DEEP_PATH}"]`)).toBeNull()
  })

  it('mounts the rows around a scrolled position instead', async () => {
    const container = renderReview(bigDetail())
    await waitFor(() => { expect(container.querySelector('[data-gitgraph-review-file]')).not.toBeNull() })
    const scroller = scrollerOf(container)

    await act(async () => {
      scroller.scrollTop = DEEP_INDEX * ROW_HEIGHT
      fireEvent.scroll(scroller)
      // The scroll handler reads the scroller on the next frame; jsdom has no
      // requestAnimationFrame, so the hook falls back to a short timer.
      await new Promise<void>((resolve) => { setTimeout(resolve, 40) })
    })

    await waitFor(() => {
      expect(container.querySelector(`[data-gitgraph-review-file="${DEEP_PATH}"]`)).not.toBeNull()
    })
    // The top of the list has left the window, as a windowed list must.
    expect(container.querySelector(`[data-gitgraph-review-file="${FIRST_PATH}"]`)).toBeNull()
    expect(container.querySelectorAll('[data-gitgraph-review-file]').length).toBeLessThan(200)
  })

  it('picks a visible row and swaps the diff header', async () => {
    const container = renderReview(bigDetail())
    await waitFor(() => { expect(container.querySelector('[data-gitgraph-review-file]')).not.toBeNull() })

    const target = container.querySelector('[data-gitgraph-review-file="dir/file-00003.txt"]')
    if (!(target instanceof HTMLElement)) throw new Error('the fourth file is not in the window')
    // The first file is picked for the reader until they pick another.
    const head = (): HTMLElement => {
      const found = container.querySelector('[data-gitgraph-part="review-diff"] [data-gitgraph-diff-head="review"]')
      if (!(found instanceof HTMLElement)) throw new Error('the review diff has no header')
      return found
    }
    expect(head().textContent).toContain(FIRST_PATH)

    fireEvent.click(target)

    await waitFor(() => { expect(target.getAttribute('aria-pressed')).toBe('true') })
    expect(head().textContent).toContain('dir/file-00003.txt')
  })

  it('fetches the first file when the fast path sent no patch at all', async () => {
    // The host's large-commit fast path answers with `patch: ''` and
    // `truncated: true`: the list is complete, but every file's text comes from the
    // per-file route. An empty patch there means "ask per file", never "no diff".
    const FILE_PATCH = [
      'diff --git a/dir/file-00000.txt b/dir/file-00000.txt',
      'index 1111111..2222222 100644',
      '--- a/dir/file-00000.txt',
      '+++ b/dir/file-00000.txt',
      '@@ -1 +1,2 @@',
      ' one',
      '+two',
      '',
    ].join('\n')
    const asked: string[] = []
    const { container } = render(
      <CommitReview
        detail={{ ...bigDetail(), truncated: true }}
        loading={false}
        root="/repo"
        t={t}
        commitDiff={async (_oid, file) => {
          asked.push(file)
          return { path: file, binary: false, truncated: false, patch: FILE_PATCH, before: 2, after: 3 }
        }}
      />,
    )

    // The first file is picked for the reader, so its patch is what is asked for.
    await waitFor(() => { expect(asked).toEqual([FIRST_PATH]) })
    await waitFor(() => {
      expect(container.querySelector('[data-gitgraph-part="review-diff"] [data-diff-kind]')).not.toBeNull()
    })
  })
})

/** Two history rows, so the cache can be seen serving a commit it has already read. */
const CACHED_A = {
  oid: 'a'.repeat(40),
  shortOid: 'aaaaaaa',
  parents: [],
  subject: 'commit a',
  author: 'tester',
  authorEmail: 't@dsh.local',
  authorTime: 1_700_000_000,
  refs: [],
}
const CACHED_B = {
  ...CACHED_A,
  oid: 'b'.repeat(40),
  shortOid: 'bbbbbbb',
  subject: 'commit b',
  authorTime: 1_700_000_100,
}

/** A commit detail carrying one empty-patch file: enough for the review to render. */
function cachedDetail(commit: typeof CACHED_A, path: string): CommitDetail {
  return {
    ...commit,
    body: '',
    committer: 'tester',
    committerTime: commit.authorTime,
    files: [{ path, additions: 1, deletions: 0, binary: false }],
    patch: '',
    truncated: false,
  }
}

/** A status view with no changed files: only the history side is under test here. */
function emptyStatus(): StatusFilesView {
  return {
    root: '/repo',
    branch: 'main',
    head: 'a'.repeat(40),
    files: [],
    stagedCount: 0,
    unstagedCount: 0,
    untrackedCount: 0,
    conflictedCount: 0,
    operationInProgress: false,
    operation: '',
    upstream: '',
    behind: 0,
    ahead: 0,
    remotes: [],
    patches: { worktree: '', staged: '', truncated: false },
  }
}

describe('the commit detail cache', () => {
  it('answers a refresh and a re-selection from memory instead of the host', async () => {
    const asked: string[] = []
    let fileCalls = 0
    let push: (() => void) | null = null
    const injected: GitPanelInjected = {
      files: async () => { fileCalls += 1; return emptyStatus() },
      branches: async () => null,
      switchBranch: async () => ({ ok: false, error: { code: 'internal', message: 'x' } }),
      diff: async () => null,
      stage: async () => ({ ok: true, summary: '' }),
      unstage: async () => ({ ok: true, summary: '' }),
      discard: async () => ({ ok: true, summary: '' }),
      applySelection: async () => ({ ok: true, summary: '' }),
      commit: async () => ({ ok: false, error: { code: 'internal', message: 'x' } }),
      history: async () => ({ root: '/repo', branch: 'main', commits: [CACHED_A, CACHED_B], hasMore: false }),
      commitDetail: async (_session, oid) => {
        asked.push(oid)
        // A fresh object every time, like the host answering a real fetch.
        return oid === CACHED_A.oid ? cachedDetail(CACHED_A, 'a.txt') : cachedDetail(CACHED_B, 'b.txt')
      },
      remote: async () => null,
      fetch: async () => ({ ok: true, summary: '' }),
      pull: async () => ({ ok: true, summary: '' }),
      push: async () => ({ ok: true, summary: '' }),
      merge: async () => ({ ok: true, summary: '' }),
      rebase: async () => ({ ok: true, summary: '' }),
      abortOperation: async () => ({ ok: true, summary: '' }),
      subscribeChanges: (_session, callback) => {
        push = callback
        return () => { push = null }
      },
    }
    const viewProps = { sessionId: 'session', t, ...injected }
    const { container } = render(<GitView {...(viewProps as unknown as GitViewProps)} />)
    const commitRow = (oid: string): Element | null =>
      container.querySelector(`[data-gitgraph-commit-oid="${oid}"]`)

    await waitFor(() => { expect(container.querySelector('[data-gitgraph-tab="history"]')).not.toBeNull() })
    fireEvent.click(container.querySelector('[data-gitgraph-tab="history"]') as HTMLElement)
    await waitFor(() => { expect(commitRow(CACHED_A.oid)).not.toBeNull() })

    fireEvent.click(commitRow(CACHED_A.oid) as HTMLElement)
    await waitFor(() => { expect(container.querySelector('[data-gitgraph-review-file="a.txt"]')).not.toBeNull() })
    expect(asked).toEqual([CACHED_A.oid])

    // An SSE change re-runs the fetch effect for the SAME commit. The cache answers
    // it: no second request, and the review never leaves the screen.
    await act(async () => {
      if (push === null) throw new Error('the view subscribed to no change stream')
      push()
      await new Promise<void>((resolve) => { setTimeout(resolve, 80) })
    })
    expect(fileCalls).toBeGreaterThanOrEqual(2)
    expect(asked).toEqual([CACHED_A.oid])
    expect(container.querySelector('[data-gitgraph-review-file="a.txt"]')).not.toBeNull()
    expect(container.textContent).not.toContain('git.history.select')

    // A different commit is a different id, so it is fetched — and coming back to
    // the first one is answered from memory again.
    fireEvent.click(commitRow(CACHED_B.oid) as HTMLElement)
    await waitFor(() => { expect(container.querySelector('[data-gitgraph-review-file="b.txt"]')).not.toBeNull() })
    expect(asked).toEqual([CACHED_A.oid, CACHED_B.oid])

    fireEvent.click(commitRow(CACHED_A.oid) as HTMLElement)
    await waitFor(() => { expect(container.querySelector('[data-gitgraph-review-file="a.txt"]')).not.toBeNull() })
    expect(asked).toEqual([CACHED_A.oid, CACHED_B.oid])
  })
})
