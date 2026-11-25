// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup, act, fireEvent, screen } from '@testing-library/react'
import type { BackendId, UsageRead, UsageRow } from '../../src/shared/types'
import { localDayKey } from '../../src/shared/usageFormat'

afterEach(cleanup)

const today = localDayKey(Date.now())
const row = (backend: string, sessionId: string): UsageRow => ({
  backend: backend as BackendId,
  sessionId,
  workspace: '/work/app',
  day: today,
  model: 'some-model',
  surchargeUsd: 0,
  inTok: 1000,
  outTok: 1000,
  cacheWriteTok: 0,
  cacheWrite1hTok: 0,
  cacheReadTok: 0
})

const read: UsageRead = {
  rows: [row('codex', 'known'), row('an-agent-this-build-lacks', 'unknown')],
  titles: { known: 'known session', unknown: 'unknown session' },
  reading: false
}
;(window as unknown as { api: unknown }).api = {
  usage: { read: () => Promise.resolve(read), onChanged: () => () => {} }
}

const { UsagePane } = await import('../../src/renderer/src/components/settings/UsagePane')

describe('the badges on the usage page’s cost lines', () => {
  it('a line from an agent this build does not have, read back from the usage cache, gets no badge and does not stop the page from drawing', async () => {
    render(<UsagePane />)
    await act(async () => {})
    fireEvent.click(screen.getByRole('button', { name: 'Session' }))

    expect(screen.getByText('unknown session')).toBeTruthy()
    expect(screen.getByText('CODEX')).toBeTruthy()
    expect(document.querySelector('.acct-badge.an-agent-this-build-lacks')).toBeNull()
  })
})
