import { describe, it, expect } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/settingsOps'
import { butlerSetUp } from '../../../../src/plugins/butler/renderer/butlerTabs'

const CHANNEL = { guildId: '100', channelId: '200', name: 'global' }

describe('when the butler counts as set up', () => {
  it('a bound Discord channel is enough, with no account and the permission question unanswered; without one, it takes both', () => {
    const unanswered = { ...DEFAULT_SETTINGS, skipPermissions: true, skipPermissionsAgreed: false }
    expect(
      butlerSetUp({ accounts: [], settings: { ...unanswered, discord: { channel: CHANNEL } } })
    ).toBe(true)
    expect(butlerSetUp({ accounts: [], settings: unanswered })).toBe(false)
    const account = { name: 'a', kind: 'oauth', enabled: true } as never
    expect(butlerSetUp({ accounts: [account], settings: unanswered })).toBe(false)
    expect(
      butlerSetUp({ accounts: [account], settings: { ...unanswered, skipPermissionsAgreed: true } })
    ).toBe(true)
  })
})
