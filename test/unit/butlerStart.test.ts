import { describe, it, expect } from 'vitest'
import type { BackendAvailability, BackendId } from '../../src/shared/types'
import { butlerStart } from '../../src/shared/butlerStart'
import { meta } from './helpers/accounts'

const ALL_ON = { claude: true, codex: true, muse: true, agy: true }

function installedOnly(...ids: BackendId[]): BackendAvailability[] {
  return (['claude', 'codex', 'muse', 'agy'] as const).map((id) => ({
    id,
    available: ids.includes(id)
  }))
}

describe('butlerStart (which agent the butler starts on, or why it cannot)', () => {
  it('starts on the preferred agent when it can run, and on the next that can, saying why, when it cannot', () => {
    const inputs = {
      enabled: ALL_ON,
      installed: installedOnly('claude', 'codex'),
      accounts: [meta({ kind: 'codex-home' })]
    }
    expect(butlerStart('codex', inputs, 'Alfred')).toEqual({ backend: 'codex' })
    expect(butlerStart('claude', inputs, 'Alfred')).toEqual({
      backend: 'codex',
      because:
        'Alfred runs on Codex this time. No Claude account yet — add one in Settings ▸ Accounts.'
    })
  })

  it('when no agent can run, the toast says the preferred agent’s line, the link opens the pane that fixes it, and the full reason gives every agent’s line, the preferred first', () => {
    const start = butlerStart(
      'muse',
      {
        enabled: { ...ALL_ON, agy: false },
        installed: installedOnly('claude', 'muse'),
        accounts: [meta({ enabled: false })]
      },
      'Alfred'
    )
    expect(start).toEqual({
      error: 'Alfred cannot start. No Muse account yet — add one in Settings ▸ Accounts.',
      inFull:
        'Alfred cannot start. No Muse account yet — add one in Settings ▸ Accounts. No Claude account can be used — check Settings ▸ Accounts. Codex is not installed — add it in Settings ▸ Accounts. Antigravity is turned off in Settings ▸ Sessions.',
      preferred: { lead: 'No Muse account yet — add one in ', fixedIn: 'accounts' }
    })
  })

  it('checks the switch in Settings ▸ Sessions before the install, the install before the account, and never calls Claude not installed', () => {
    const none = { enabled: { ...ALL_ON, codex: false }, installed: installedOnly(), accounts: [] }
    const start = butlerStart('codex', none, 'Alfred')
    expect('error' in start && start.preferred).toEqual({
      lead: 'Codex is turned off in ',
      fixedIn: 'sessions'
    })
    expect('error' in start && start.inFull).toContain(
      'No Claude account yet — add one in Settings ▸ Accounts. Muse is not installed'
    )
  })
})
