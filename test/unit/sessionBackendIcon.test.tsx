// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup, screen } from '@testing-library/react'
import { BACKEND_LABEL } from '../../src/shared/sessionBackend'
import { SessionBackendIcon } from '../../src/renderer/src/components/SessionBackendIcon'

afterEach(cleanup)

describe('SessionBackendIcon', () => {
  it('names its backend to a screen reader', () => {
    render(
      <>
        <SessionBackendIcon backend="claude" />
        <SessionBackendIcon backend="codex" />
        <SessionBackendIcon backend="muse" />
        <SessionBackendIcon backend="agy" />
      </>
    )
    expect(screen.getAllByRole('img').map((el) => el.getAttribute('aria-label'))).toEqual([
      BACKEND_LABEL.claude,
      BACKEND_LABEL.codex,
      BACKEND_LABEL.muse,
      BACKEND_LABEL.agy
    ])
  })

  it('is hidden from a screen reader when decorative, beside a label that already names it', () => {
    const { container } = render(<SessionBackendIcon backend="codex" decorative />)
    expect(screen.queryByRole('img')).toBeNull()
    expect(container.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true')
  })
})
