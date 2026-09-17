// @vitest-environment jsdom
/**
 * The commit box keeps what was typed into it.
 *
 * The shell renders only the active view, so looking at the conversation unmounted
 * the panel — and took a half-written commit message with it. The message is the one
 * thing on this panel the reader typed themselves, and glancing away for a moment is
 * not a reason to lose it.
 *
 * The two failures either side of that matter as much as the happy path: the box must
 * NOT forget a message git refused, and it must not carry one repository's draft into
 * another's commit box.
 */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { ChangesPanel } from '../src/client/git/ChangesPanel.tsx'
import { clearCommitDraft } from '../src/client/git/commit-draft.ts'
import type { FileChange, StatusFilesView } from '../src/core/types.ts'

const t = ((key: string) => key) as never

function modified(path: string): FileChange {
  return { path, index: ' ', worktree: 'M', kind: 'modified', staged: false, conflicted: false, untracked: false }
}

/** A view of one repository holding a single unstaged change. */
function statusOf(root: string): StatusFilesView {
  return {
    root,
    branch: 'main',
    head: 'a'.repeat(40),
    files: [modified('a.txt')],
    stagedCount: 0,
    unstagedCount: 1,
    untrackedCount: 0,
    conflictedCount: 0,
    operationInProgress: false,
    operation: '',
    upstream: '',
    behind: 0,
    ahead: 0,
  }
}

/** Mount the panel over one repository, with the commit verdict the case needs. */
function mount(root: string, commit: () => Promise<boolean> = async () => true): HTMLElement {
  const { container } = render(
    <ChangesPanel
      status={statusOf(root)}
      selected={null}
      busy={false}
      onSelect={() => {}}
      onStage={() => {}}
      onUnstage={() => {}}
      onDiscard={() => {}}
      onCommit={() => commit()}
      t={t}
    />,
  )
  return container
}

const box = (container: HTMLElement): HTMLTextAreaElement =>
  container.querySelector('[data-gitgraph-commit-message]') as HTMLTextAreaElement

const send = (container: HTMLElement): void => {
  fireEvent.click(container.querySelector('[data-gitgraph-commit]') as HTMLElement)
}

afterEach(cleanup)

describe('the commit message box', () => {
  it('keeps a half-written message when the panel is left and opened again', () => {
    clearCommitDraft('/repo')
    fireEvent.change(box(mount('/repo')), { target: { value: 'fix the thing' } })
    // Leaving the Git tab unmounts the panel; coming back has to find the sentence.
    cleanup()
    expect(box(mount('/repo')).value).toBe('fix the thing')
  })

  it('forgets the draft once git has taken it', async () => {
    clearCommitDraft('/repo')
    const container = mount('/repo')
    fireEvent.change(box(container), { target: { value: 'landed' } })
    send(container)
    await waitFor(() => { expect(box(container).value).toBe('') })
    cleanup()
    // And it stays forgotten: a sent message is not a draft.
    expect(box(mount('/repo')).value).toBe('')
  })

  it('keeps the message when the commit failed', async () => {
    // The box used to clear unconditionally, which discarded exactly the text the
    // reader would have to type a second time.
    clearCommitDraft('/repo')
    const container = mount('/repo', async () => false)
    fireEvent.change(box(container), { target: { value: 'nothing to commit' } })
    send(container)
    await waitFor(() => { expect(box(container).value).toBe('nothing to commit') })
  })

  it('does not carry one repository\'s draft into another', () => {
    clearCommitDraft('/one')
    clearCommitDraft('/two')
    fireEvent.change(box(mount('/one')), { target: { value: 'for the first project' } })
    cleanup()
    // A draft belongs to a repository: in another one it sits one Enter away from
    // being committed to the wrong tree.
    expect(box(mount('/two')).value).toBe('')
    expect(box(mount('/one')).value).toBe('for the first project')
  })
})
