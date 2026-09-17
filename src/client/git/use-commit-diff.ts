/**
 * The per-file fetch behind the commit review: one small state machine, kept out of
 * the view that renders it.
 *
 * Three things move here and none of them are layout — what came back, what is in
 * flight, and what has already been asked for — and folding them into the component
 * put a dozen derived booleans next to the JSX that used them. The view's question is
 * narrow ("what can I show for the file on screen?"), so it is answered here and
 * returned as one value.
 *
 * The fetch is asked for ONLY when the commit's own patch has no lines for the file:
 * a fetched patch is the fallback, never the first answer. That is also what keeps
 * the sizes — which only matter when there is no text — off the files that have text.
 * @module dsh-git-panel/client/git/use-commit-diff
 */

import { useEffect, useRef, useState } from 'react'
import type { CommitDiff } from '../../core/types.ts'
import { splitPatch, type FileDiff } from './diff-parse.ts'

/** One file's fetched patch, as the review keeps it. */
interface FetchedFile {
  /** The section the patch parsed to, or null when it carried none. */
  diff: FileDiff | null
  before: number | null
  after: number | null
}

/** The file the review has picked, as much of it as the fetch needs. */
export interface ActiveCommitFile {
  path: string
  /** The section the commit's own patch carried for this file, if any. */
  diff: FileDiff | null
  /** Whether the commit's numstat called it binary. */
  binary: boolean
}

/** Everything the review can say about the file on screen. */
export interface CommitFileView {
  /** The section to render; null when there is nothing textual to show. */
  diff: FileDiff | null
  /** Whether the file is binary, from either the numstat row or the fetched patch. */
  binary: boolean
  /** Whether there are LINES to read — the one case that hides the sizes. */
  hasText: boolean
  /** Whether a fetch is on the wire, or is about to be. */
  busy: boolean
  /** Whether this file has been fetched and answered (however empty the answer). */
  settled: boolean
  /** Bytes at the first parent; null when the path did not exist there. */
  before: number | null
  /** Bytes in this commit; null when the commit removed the path. */
  after: number | null
}

/** What the hook needs from the view. */
export interface UseCommitFileDiffOptions {
  /** The commit under review; a new one discards every answer held here. */
  oid: string | null
  /** The file on show, or undefined when the commit lists none. */
  active: ActiveCommitFile | undefined
  /** The per-file verb, or undefined when this shell does not provide it. */
  fetchDiff: ((oid: string, file: string) => Promise<CommitDiff | null>) | undefined
}

/**
 * Resolve the file on screen, fetching it alone when the commit's patch could not.
 * @param options - see {@link UseCommitFileDiffOptions}.
 * @returns what the pane can show for that file.
 */
export function useCommitFileDiff({ oid, active, fetchDiff }: UseCommitFileDiffOptions): CommitFileView {
  /** Answers already in hand, keyed by path. */
  const [fetched, setFetched] = useState<ReadonlyMap<string, FetchedFile>>(new Map())
  /** Paths whose fetch is on the wire. */
  const [fetching, setFetching] = useState<ReadonlySet<string>>(() => new Set())
  /**
   * Paths a fetch has been STARTED for.
   *
   * A rejected or failed fetch stores no entry, so without this the effect would ask
   * again on the next render and never stop — an endless request loop against a host
   * that cannot answer this route.
   */
  const asked = useRef(new Set<string>())

  // A different commit is a different set of files: no answer here describes it.
  useEffect(() => {
    setFetched(new Map())
    setFetching(new Set())
    asked.current = new Set()
  }, [oid])

  const path = active?.path ?? null
  const entry = path === null ? undefined : fetched.get(path)
  const inline = active?.diff ?? null
  /** What the pane renders: the commit's own section first, the fetched one after. */
  const shown = inline ?? entry?.diff ?? null
  /** Lines to draw. A binary section and a mode flip both reach here with none. */
  const hasText = shown !== null && shown.status !== 'binary' && shown.rows.length > 0
  const binary = (active?.binary ?? false) || shown?.status === 'binary'
  const waiting = path !== null && fetching.has(path)
  /**
   * Whether a fetch is about to start — the first frame, before the effect has run and
   * the request can be tracked. Without it the pane would show its failure note for
   * one frame on every pick.
   */
  const willFetch = active !== undefined && path !== null && !hasText
    && typeof fetchDiff === 'function' && entry === undefined && !asked.current.has(path)

  useEffect(() => {
    if (oid === null || active === undefined || path === null) return undefined
    // The commit's own patch already has lines for this file: nothing to fetch.
    if (hasText) return undefined
    if (typeof fetchDiff !== 'function' || asked.current.has(path)) return undefined
    asked.current.add(path)
    let live = true
    setFetching(current => new Set(current).add(path))
    const settle = (): void => {
      if (!live) return
      setFetching((current) => {
        const next = new Set(current)
        next.delete(path)
        return next
      })
    }
    const apply = (next: CommitDiff | null): void => {
      if (!live) return
      setFetched((current) => {
        const map = new Map(current)
        // A binary patch is parsed rather than discarded: its section is what tells
        // the pane which of the two notes this file gets.
        const parsed = next === null ? [] : splitPatch(next.patch)
        map.set(path, {
          diff: parsed[0] ?? null,
          before: next?.before ?? null,
          after: next?.after ?? null,
        })
        return map
      })
    }
    // A failed fetch keeps the note the pane already had. A verb that throws
    // SYNCHRONOUSLY is caught for a blunter reason: an error raised inside an effect
    // makes React unmount the tree, and one file's diff is not worth the whole tab.
    try {
      void fetchDiff(oid, path).then(apply).catch(() => {}).finally(settle)
    } catch {
      settle()
    }
    return () => { live = false }
  }, [active, path, oid, fetchDiff, hasText])

  return {
    diff: shown,
    binary,
    hasText,
    busy: waiting || willFetch,
    settled: entry !== undefined,
    before: entry?.before ?? null,
    after: entry?.after ?? null,
  }
}
