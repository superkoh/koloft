import { describe, it, expect } from 'vitest'
import type { BackendAvailability, BackendId } from '../../src/shared/types'
import { butlerStart, cannotRunLine, whyButlerCannotRunOn } from '../../src/shared/butlerStart'
import { meta } from './helpers/accounts'

const ALL_ON = { claude: true, codex: true, muse: true, agy: true }

function installedOnly(...ids: BackendId[]): BackendAvailability[] {
  return (['claude', 'codex', 'muse', 'agy'] as const).map((id) => ({
    id,
    available: ids.includes(id)
  }))
}

describe('butlerStart (which agent the butler starts on, or the one sentence saying why it cannot)', () => {
  it('starts on the preferred agent when it has a usable account, and on the next that does, saying why, when it has none', () => {
    const inputs = {
      enabled: ALL_ON,
      installed: installedOnly('claude', 'codex'),
      accounts: [meta({ kind: 'codex-home' })]
    }
    expect(butlerStart('codex', inputs, 'Alfred')).toEqual({ backend: 'codex' })
    expect(butlerStart('claude', inputs, 'Alfred')).toEqual({
      backend: 'codex',
      because: 'Alfred runs on Codex this time: there is no usable Claude account.'
    })
  })

  it('when no agent can run, says the preferred agent’s line with its link pane in the toast, and every agent’s reason in full', () => {
    const start = butlerStart(
      'claude',
      {
        enabled: { ...ALL_ON, agy: false },
        installed: installedOnly('claude', 'muse'),
        accounts: [meta({ enabled: false })]
      },
      'Alfred'
    )
    expect(start).toEqual({
      error: 'Alfred cannot start: No Claude account can be used — check Settings ▸ Accounts.',
      inFull:
        'Alfred cannot start: there is no usable Claude account, and Codex is not installed, and there is no usable Muse account, and Antigravity is turned off in Settings ▸ Sessions.',
      preferred: {
        clause: 'there is no usable Claude account',
        lead: 'No Claude account can be used — check ',
        fixedIn: 'accounts'
      }
    })
  })

  it('never calls Claude not installed, checks the install before the account, and the turned-off switch before both', () => {
    const none = { enabled: ALL_ON, installed: installedOnly(), accounts: [] }
    expect(cannotRunLine(whyButlerCannotRunOn('claude', none)!)).toBe(
      'No Claude account yet — add one in Settings ▸ Accounts.'
    )
    expect(cannotRunLine(whyButlerCannotRunOn('codex', none)!)).toBe(
      'Codex is not installed — add it in Settings ▸ Accounts.'
    )
    expect(
      cannotRunLine(
        whyButlerCannotRunOn('codex', { ...none, enabled: { ...ALL_ON, codex: false } })!
      )
    ).toBe('Codex is turned off in Settings ▸ Sessions.')
  })
})
