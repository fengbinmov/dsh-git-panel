/**
 * The error boundary around the Git view.
 *
 * A view that throws — while rendering, or from inside an effect — takes down
 * whatever the shell mounted it into: React unmounts the subtree and the tab goes
 * blank with nothing left to click. That is not hypothetical for this plugin: an
 * optional verb called from an effect, and a promise that rejected where nobody was
 * catching, each did exactly that, and each looked like "the whole panel vanished".
 *
 * A boundary turns any such failure into one line the reader can act on. Returning
 * to the tab remounts the view, which is a genuine retry rather than a repaint of
 * the broken tree.
 * @module dsh-git-panel/client/git/PanelBoundary
 */

import { Component, type ComponentType, type ReactNode } from 'react'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import type { GitPanelKey } from '../locales.ts'
import css from './git.module.css'

/** Props the boundary itself renders from. */
interface BoundaryProps {
  children: ReactNode
  /** The view's translator, so the failure is reported in the reader's language. */
  t?: Translate<GitPanelKey> | undefined
}

/**
 * What a guarded view has to offer: the translator.
 *
 * Deliberately narrower than {@link BoundaryProps} — the wrapper passes the view's
 * own props straight through, and a view has no `children` of its own, so requiring
 * them here would rule out every component this is meant to guard.
 */
interface Translatable {
  t?: Translate<GitPanelKey> | undefined
}

interface BoundaryState {
  failed: boolean
}

/**
 * Catches a failure in the Git view's tree and shows a note instead of nothing.
 *
 * A class, because React only routes errors to `getDerivedStateFromError` and
 * `componentDidCatch` on class components.
 */
export class PanelBoundary extends Component<BoundaryProps, BoundaryState> {
  override state: BoundaryState = { failed: false }

  /** Flip to the failure state; the fallback is rendered on the next pass. */
  static getDerivedStateFromError(): BoundaryState {
    return { failed: true }
  }

  /**
   * Report the failure where a developer will see it.
   *
   * The message is logged rather than swallowed: the boundary exists to keep the tab
   * usable, not to hide the bug.
   */
  override componentDidCatch(error: unknown): void {
    console.error('dsh-git-panel: the Git view threw', error)
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children
    return (
      <div className={css.panelError} data-gitgraph-part="crash">
        <div>{this.props.t?.('git.view.crashed') ?? 'The Git panel hit an error. Switch tabs to retry.'}</div>
      </div>
    )
  }
}

/**
 * Wrap a view in {@link PanelBoundary}, passing its translator through.
 * @param Inner - the view component to guard.
 * @returns the guarded component, with the same props.
 */
export function withPanelBoundary<P extends Translatable>(Inner: ComponentType<P>): (props: P) => ReactNode {
  function Guarded(props: P): ReactNode {
    return (
      <PanelBoundary t={props.t}>
        <Inner {...props} />
      </PanelBoundary>
    )
  }
  Guarded.displayName = `withPanelBoundary(${Inner.displayName ?? Inner.name})`
  return Guarded
}
