/**
 * dsh-git-panel, browser half: one more Conversation View registered into the
 * `conversation.view` slot, so the GUI's tab strip reads Chat / Trajectory /
 * Git. The shell builds that strip from this slot's entries and renders the
 * selected one, so registering is the whole integration — no official file is
 * patched and no other plugin is required.
 *
 * All git facts arrive through this package's host /gitpanel routes. The inject
 * face carries the business verbs and the components stay pure props.
 * @module dsh-git-panel/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: pulls the ctx.slots merge (the renderer owns the slot registry).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the ui-conversation SlotMap merge (which declares
// 'conversation.view') and its ConvViewOwnerProps.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the ui-session standard-props merge (sessionId on
// session-scoped slots and useSessions on the global ones).
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {
  BranchesView, CommitDetail, CommitDiff, CommitOutcome, DiffView, GitError, HistoryView, MutationResult,
  RemoteView, StatusFilesView, SwitchResult,
} from '../core/types.ts'
import { GitApi, subscribeChanges } from './api.ts'
import { GitView } from './git/GitView.tsx'
import { isPanelMounted, rememberStatus } from './git/panel-cache.ts'
import { en, zh, type GitPanelKey } from './locales.ts'

export type { GitPanelKey } from './locales.ts'
export { GitView } from './git/GitView.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The git-panel view copy. */
    'git-panel': GitPanelKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'git-panel'

/** Required services: slots for the view entry, sessions for the cwd lookup, locale for the copy. */
export const inject = ['slots', 'sessions', 'locale']

/** Injected business face of the Git view: every git verb, keyed by session id. */
export interface GitPanelInjected {
  /** The file-level change list plus the branch's sync state; null when not a repository. */
  files: (sessionId: SessionId | undefined) => Promise<StatusFilesView | null>
  /** Every local branch with the current one marked. */
  branches: (sessionId: SessionId | undefined) => Promise<BranchesView | null>
  /** Workspace-level `git switch --no-guess <branch>`. */
  switchBranch: (sessionId: SessionId | undefined, branch: string) => Promise<SwitchResult>
  /** One path's diff; `staged` selects the index-versus-HEAD side. */
  diff: (sessionId: SessionId | undefined, file: string, staged: boolean) => Promise<DiffView | null>
  /** Stage repo-relative paths. */
  stage: (sessionId: SessionId | undefined, paths: readonly string[]) => Promise<MutationResult>
  /** Unstage repo-relative paths (the working tree is untouched). */
  unstage: (sessionId: SessionId | undefined, paths: readonly string[]) => Promise<MutationResult>
  /** Discard paths back to HEAD (destructive). */
  discard: (sessionId: SessionId | undefined, paths: readonly string[]) => Promise<MutationResult>
  /**
   * Apply one line selection: a patch fragment covering only the chosen rows of one
   * file, staged, unstaged or discarded.
   */
  applySelection: (
    sessionId: SessionId | undefined,
    file: string,
    direction: 'stage' | 'unstage' | 'discard',
    fragment: string,
  ) => Promise<MutationResult>
  /** Commit the staged changes. */
  commit: (sessionId: SessionId | undefined, message: string, amend: boolean) => Promise<CommitOutcome>
  /** A page of the current branch's history. */
  history: (sessionId: SessionId | undefined, limit: number, skip: number) => Promise<HistoryView | null>
  /** One commit's metadata, changed-file statistics, and patch. */
  commitDetail: (sessionId: SessionId | undefined, oid: string) => Promise<CommitDetail | null>
  /**
   * One file's patch out of a commit, for the files a capped commit patch left out.
   *
   * OPTIONAL on purpose: a view must treat a missing callback as "this build cannot
   * fetch a single file" and keep rendering the commit it has, rather than assume
   * the verb is there. That keeps a half-updated host (or a shell whose slot inject
   * drops unknown keys) from turning an absent verb into a crash.
   */
  commitDiff?: ((sessionId: SessionId | undefined, oid: string, file: string) => Promise<CommitDiff | null>) | undefined
  /** Branch, upstream, ahead/behind, and configured remotes. */
  remote: (sessionId: SessionId | undefined) => Promise<RemoteView | null>
  /** `git fetch --prune`. */
  fetch: (sessionId: SessionId | undefined) => Promise<MutationResult>
  /** `git pull --no-edit`. */
  pull: (sessionId: SessionId | undefined) => Promise<MutationResult>
  /** `git push`, setting the upstream on a first push. */
  push: (sessionId: SessionId | undefined) => Promise<MutationResult>
  /** Merge a local branch into the current one. */
  merge: (sessionId: SessionId | undefined, branch: string) => Promise<MutationResult>
  /** Rebase the current branch onto a local branch. */
  rebase: (sessionId: SessionId | undefined, branch: string) => Promise<MutationResult>
  /** Abort the merge or rebase currently in progress. */
  abortOperation: (sessionId: SessionId | undefined) => Promise<MutationResult>
  /** Host-pushed workspace changes for the session's workspace. */
  subscribeChanges: (sessionId: SessionId | undefined, onChange: () => void) => () => void
}

/** The session-cwd lookup failure shared by the injected verbs. */
const NO_WORKSPACE: GitError = { code: 'workspace-unknown', message: 'session has no workspace' }

/**
 * Client plugin body: the Git view tab on the `conversation.view` slot.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => {
    try {
      return ctx.locale.register(NS, { zh, en })
    } catch {
      return () => {}
    }
  }, 'dsh-git-panel: dictionaries')

  // The tab label, resolved at render time so the shell picks up locale
  // changes. Wrapped like the dictionary registration above: a locale face
  // without bind() must not take the whole plugin down, and the literal
  // fallback matches both dictionaries' value for this key.
  const viewLabel = ((): (() => string) => {
    try {
      const translate = ctx.locale.bind(NS)
      return () => translate('view.git')
    } catch {
      return () => 'Git'
    }
  })()

  const git = new GitApi()

  // Conditional mount: the conversation service being up is the
  // registration-safe signal. The slot inject then waits for the shell to
  // declare 'conversation.view'.
  ctx.inject(['slots', 'sessions'], (scope: ClientContext) => {
    const sessions = scope.sessions

    /** The session's workspace root, resolved at call time from the sessions baseline. */
    const cwdOf = (sessionId: SessionId | undefined): string | undefined =>
      sessionId === undefined ? undefined : sessions.list.getSnapshot().byId[sessionId]?.cwd

    /** Resolve the workspace root for one git call. */
    const pathOf = (sessionId: SessionId | undefined): { ok: true; path: string } | { ok: false; error: GitError } => {
      const cwd = cwdOf(sessionId)
      if (cwd === undefined || cwd === '') return { ok: false, error: NO_WORKSPACE }
      return { ok: true, path: cwd }
    }

    /** The injected face the view receives. */
    const injected = (): GitPanelInjected => {
      /** Map a `{ summary }` envelope onto the injected MutationResult shape. */
      const mutation = (result: { ok: true; value: { summary: string } } | { ok: false; error: GitError }): MutationResult =>
        result.ok ? { ok: true, summary: result.value.summary } : result

      return {
        files: async (sessionId) => {
          const resolved = pathOf(sessionId)
          if (!resolved.ok) return null
          const result = await git.statusFiles(resolved.path)
          return result.ok ? result.value : null
        },
        branches: async (sessionId) => {
          const resolved = pathOf(sessionId)
          if (!resolved.ok) return null
          const result = await git.branches(resolved.path)
          return result.ok ? result.value : null
        },
        switchBranch: async (sessionId, branch) => {
          const resolved = pathOf(sessionId)
          if (!resolved.ok) return { ok: false, error: resolved.error }
          const result = await git.switchBranch(resolved.path, branch)
          return result.ok ? { ok: true, branch: result.value.branch } : result
        },
        diff: async (sessionId, file, staged) => {
          const resolved = pathOf(sessionId)
          if (!resolved.ok) return null
          const result = await git.diff(resolved.path, file, staged)
          return result.ok ? result.value : null
        },
        stage: async (sessionId, paths) => {
          const resolved = pathOf(sessionId)
          if (!resolved.ok) return { ok: false, error: resolved.error }
          return mutation(await git.stage(resolved.path, paths))
        },
        unstage: async (sessionId, paths) => {
          const resolved = pathOf(sessionId)
          if (!resolved.ok) return { ok: false, error: resolved.error }
          return mutation(await git.unstage(resolved.path, paths))
        },
        discard: async (sessionId, paths) => {
          const resolved = pathOf(sessionId)
          if (!resolved.ok) return { ok: false, error: resolved.error }
          return mutation(await git.discard(resolved.path, paths))
        },
        applySelection: async (sessionId, file, direction, fragment) => {
          const resolved = pathOf(sessionId)
          if (!resolved.ok) return { ok: false, error: resolved.error }
          return mutation(await git.applySelection(resolved.path, file, direction, fragment))
        },
        commit: async (sessionId, message, amend) => {
          const resolved = pathOf(sessionId)
          if (!resolved.ok) return { ok: false, error: resolved.error }
          const result = await git.commit(resolved.path, message, amend)
          return result.ok ? { ok: true, oid: result.value.oid, subject: result.value.subject } : result
        },
        history: async (sessionId, limit, skip) => {
          const resolved = pathOf(sessionId)
          if (!resolved.ok) return null
          const result = await git.history(resolved.path, limit, skip)
          return result.ok ? result.value : null
        },
        commitDetail: async (sessionId, oid) => {
          const resolved = pathOf(sessionId)
          if (!resolved.ok) return null
          const result = await git.commitDetail(resolved.path, oid)
          return result.ok ? result.value : null
        },
        commitDiff: async (sessionId, oid, file) => {
          const resolved = pathOf(sessionId)
          if (!resolved.ok) return null
          const result = await git.commitDiff(resolved.path, oid, file)
          return result.ok ? result.value : null
        },
        remote: async (sessionId) => {
          const resolved = pathOf(sessionId)
          if (!resolved.ok) return null
          const result = await git.remote(resolved.path)
          return result.ok ? result.value : null
        },
        fetch: async (sessionId) => {
          const resolved = pathOf(sessionId)
          if (!resolved.ok) return { ok: false, error: resolved.error }
          return mutation(await git.fetch(resolved.path))
        },
        pull: async (sessionId) => {
          const resolved = pathOf(sessionId)
          if (!resolved.ok) return { ok: false, error: resolved.error }
          return mutation(await git.pull(resolved.path))
        },
        push: async (sessionId) => {
          const resolved = pathOf(sessionId)
          if (!resolved.ok) return { ok: false, error: resolved.error }
          return mutation(await git.push(resolved.path))
        },
        merge: async (sessionId, branch) => {
          const resolved = pathOf(sessionId)
          if (!resolved.ok) return { ok: false, error: resolved.error }
          return mutation(await git.merge(resolved.path, branch))
        },
        rebase: async (sessionId, branch) => {
          const resolved = pathOf(sessionId)
          if (!resolved.ok) return { ok: false, error: resolved.error }
          return mutation(await git.rebase(resolved.path, branch))
        },
        abortOperation: async (sessionId) => {
          const resolved = pathOf(sessionId)
          if (!resolved.ok) return { ok: false, error: resolved.error }
          return mutation(await git.abortOperation(resolved.path))
        },
        subscribeChanges: (sessionId, onChange) => {
          const resolved = pathOf(sessionId)
          if (!resolved.ok) return () => {}
          return subscribeChanges(resolved.path, onChange)
        },
      }
    }

    // The Git view tab: one more entry of the always-declared
    // `conversation.view` slot, rendered by the shell's tab strip. Unlike a
    // feature chip there is no declaration-awareness dance — the shell builds
    // the strip from this slot's entries, so registering is enough. `order: 20`
    // places it after Chat (0) and Trajectory (10), and the distinct entry id
    // keeps it clear of any other plugin's view.
    scope.slots.inject('conversation.view', () => {
      try {
        return scope.slots.register(
          {
            name: 'conversation.view',
            id: 'git-panel',
            order: 20,
            locale: NS,
            label: () => viewLabel(),
            inject: injected,
          },
          GitView)
      } catch {
        return () => {}
      }
    })

    /**
     * Load the panel's data BEFORE the tab is opened.
     *
     * The shell mounts a view only when it becomes the active one, so the first
     * paint of the Git tab used to wait for a git round trip — a wait the chat and
     * trajectory tabs never have, because their data is already in the browser. The
     * pointer resting on the tab is the signal that the click is coming, and there
     * is usually a few hundred milliseconds of it, which is enough to have the list
     * waiting in `panel-cache` when the panel mounts.
     *
     * The tab buttons are matched by the SEMANTIC SUFFIX of their CSS-modules class
     * (`_tab` / `_tabActive`) rather than the hashed prefix, so a shell rebuild that
     * rehashes the module cannot silently stop this working — the same reasoning the
     * neighbouring remote-web-ui plugin uses for its injected stylesheet. The label
     * check keeps the warm-up off the other tabs.
     */
    const WARM_COOLDOWN_MS = 30_000
    const WARM_ON_LOAD_MS = 2_000
    let lastWarm = 0
    let warming = false
    const warm = (): void => {
      if (warming || isPanelMounted()) return
      const now = Date.now()
      if (now - lastWarm < WARM_COOLDOWN_MS) return
      const current = sessions.list.getSnapshot().current
      // No session (or no workspace) means no git to ask; the panel will do it.
      if (current === undefined || cwdOf(current) === undefined) return
      lastWarm = now
      warming = true
      injected().files(current)
        .then((view) => {
          // Only if the panel is STILL not on screen: a warm-up that lands after the
          // user opened the tab would otherwise overwrite the fresher list.
          if (view !== null && !isPanelMounted()) rememberStatus(view)
        })
        .catch(() => {})
        .finally(() => { warming = false })
    }
    const warmOnTab = (event: Event): void => {
      const target = event.target
      if (!(target instanceof Element)) return
      let node: Element | null = target
      for (let depth = 0; node !== null && depth < 3; depth += 1, node = node.parentElement) {
        const classes = typeof node.className === 'string' ? node.className : ''
        if (!/_tab(?:Active)?(?:\s|$)/.test(classes)) continue
        const text = (node.textContent ?? '').trim()
        if (text !== viewLabel()) continue
        warm()
        return
      }
    }
    scope.effect(() => {
      document.addEventListener('pointerover', warmOnTab, true)
      document.addEventListener('focusin', warmOnTab, true)
      // Once after load as well, so a switch that never hovers (a keyboard shortcut,
      // a restored tab) is instant too.
      const timer = window.setTimeout(warm, WARM_ON_LOAD_MS)
      return () => {
        document.removeEventListener('pointerover', warmOnTab, true)
        document.removeEventListener('focusin', warmOnTab, true)
        window.clearTimeout(timer)
      }
    }, 'dsh-git-panel: warm the tab before it is opened')
  })
}
