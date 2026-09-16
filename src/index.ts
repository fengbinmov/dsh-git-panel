/**
 * dsh-git-panel — host half: the workspace-gated git service and its
 * /gitpanel/* HTTP routes (JSON operations + an SSE change stream) on the
 * shared webserver.
 *
 * The browser half (exports "./client") is served by client-modules from the
 * same package's dsh.client declaration, and registers one more Conversation
 * View beside Chat and Trajectory.
 *
 * Every operation here is UI-triggered and none of them writes to the
 * model-visible surface: the plugin registers no tool and no system-prompt
 * contribution, matching the rule the sibling git plugin states for its own
 * verbs.
 * @module dsh-git-panel
 */

import { realpath } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-workspace'
import { GitService, subprocessRunner, type WorkspaceGate } from './host/git-service.ts'
import { registerGitPanelRoutes } from './host/routes.ts'
import { mountOnce } from './mount-once.ts'

/** Required services: the route registry, the managed subprocess seam, and the workspace registry. */
export const inject = ['webServer', 'subprocess', 'workspaceRegistry']

/**
 * The workspace-membership gate: canonicalize the requested path and require it
 * to equal a registered workspace path. This is the security boundary of the
 * /gitpanel routes — the browser may only run git on workspace roots, never
 * arbitrary host directories.
 */
function createWorkspaceGate(ctx: Context): WorkspaceGate {
  return async (path) => {
    let canonical: string
    try {
      canonical = await realpath(path)
    } catch {
      return { ok: false, error: { code: 'workspace-unknown', message: 'path does not resolve on disk' } }
    }
    if (ctx.workspaceRegistry.list().some(workspace => workspace.path === canonical)) {
      return { ok: true, canonical }
    }
    return { ok: false, error: { code: 'workspace-unknown', message: 'path is not a registered workspace' } }
  }
}

/**
 * Mount the git service and its routes.
 * @param ctx - context carrying webServer, subprocess, and workspaceRegistry.
 */
export const apply = mountOnce('dsh-git-panel', applyImpl)

function applyImpl(ctx: Context): void {
  const service = new GitService(subprocessRunner(ctx), createWorkspaceGate(ctx))
  ctx.effect(() => {
    const disposeRoutes = registerGitPanelRoutes(ctx, service)
    return () => { disposeRoutes() }
  }, 'dsh-git-panel: /gitpanel routes')
}
