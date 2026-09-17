// @vitest-environment jsdom
/**
 * The Git view is mounted into the shell's own tree, and the shell keeps no error
 * boundary of its own around it. Anything that throws below therefore unmounted the
 * tab and left a blank column — which is how a missing optional verb, and a promise
 * nobody was catching, both presented themselves.
 *
 * These tests pin the boundary that stands in for it: a failure becomes a sentence,
 * and the rest of the tab stays where it was.
 */
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PanelBoundary, withPanelBoundary } from '../src/client/git/PanelBoundary.tsx'

const t = ((key: string) => key) as never

afterEach(cleanup)

describe('the Git view error boundary', () => {
  it('renders the note instead of letting the throw reach the shell', () => {
    // React logs a caught error itself; that noise is not the failing assertion.
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    const Boom = (): never => { throw new Error('boom') }
    const { container } = render(
      <PanelBoundary t={t}>
        <Boom />
      </PanelBoundary>,
    )
    expect(container.querySelector('[data-gitgraph-part="crash"]')).not.toBeNull()
    expect(container.textContent).toContain('git.view.crashed')
    quiet.mockRestore()
  })

  it('passes a healthy view through untouched, translator and all', () => {
    const Healthy = ({ t: translate }: { t?: (key: string) => string }) => (
      <div data-testid="fine">{translate?.('git.loading') ?? 'no translator'}</div>
    )
    const Guarded = withPanelBoundary(Healthy as never)
    const { container } = render(<Guarded t={t} />)
    expect(container.querySelector('[data-testid="fine"]')?.textContent).toBe('git.loading')
    expect(container.querySelector('[data-gitgraph-part="crash"]')).toBeNull()
  })

  it('reports the failure rather than swallowing it', () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    const Boom = (): never => { throw new Error('the real reason') }
    render(
      <PanelBoundary t={t}>
        <Boom />
      </PanelBoundary>,
    )
    // The boundary keeps the tab usable; it does not hide the bug from a developer.
    expect(quiet.mock.calls.some(call => String(call[0]).includes('the Git view threw'))).toBe(true)
    quiet.mockRestore()
  })
})
