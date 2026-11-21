import { describe, expect, it, vi } from 'vitest'

const closed: string[] = []
vi.mock('../../../../src/plugins/browser-control/main/cdpRelay', () => ({
  relayTabClosed: (tabId: string) => void closed.push(tabId)
}))

describe('Browser control when a tab stops', () => {
  it('a tab whose process is being stopped loses its CDP endpoint', async () => {
    const { Moments, TAB_STOPPING } = await import('../../../../src/core/moment')
    const { PLUGINS } = await import('../../../../src/plugins/list')
    const { closeEachStoppingTabsEndpoint } =
      await import('../../../../src/plugins/browser-control/main/sessionHooks')
    const moments = new Moments(PLUGINS)
    closeEachStoppingTabsEndpoint(moments)
    await moments.announce(TAB_STOPPING, { tabId: 't1', restarting: true })
    expect(closed).toEqual(['t1'])
  })
})
