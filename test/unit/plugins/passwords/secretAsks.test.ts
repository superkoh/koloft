import { describe, expect, it } from 'vitest'
import {
  SecretAsks,
  type HowItEnded,
  type SecretAsk
} from '../../../../src/plugins/passwords/main/secretAsks'
import type { SecretAskView } from '../../../../src/shared/types'

const LONG = 60_000

const ask: SecretAsk = {
  tabId: 'tab-1',
  from: 'tab-1',
  shape: { kind: 'sudo', command: 'sudo x', prompt: 'Password:' },
  header: (n: string) => `🔑 **${n}** asks`,
  body: 'Command: `sudo x`',
  label: 'Your sudo password'
}

function setup() {
  const shown: SecretAskView[][] = []
  const waits: string[] = []
  const answeredTabs: string[] = []
  const asks = new SecretAsks({
    show: (views) => void shown.push(views),
    owner: {
      waitsOnTheOwner: (tabId) => void waits.push(tabId),
      ownerAnswered: (tabId) => void answeredTabs.push(tabId)
    }
  })
  const lastShown = (): SecretAskView[] => shown.at(-1) ?? []
  return { asks, waits, answeredTabs, lastShown }
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('asking the owner for a secret in Koloft', () => {
  it('with nothing else listening, as when Discord was never set up, the ask shows in Koloft, marks the session as waiting on the owner, and what is typed there reaches the asker', async () => {
    const { asks, waits, answeredTabs, lastShown } = setup()
    const answer = asks.ask(ask, LONG)
    expect(lastShown()).toMatchObject([{ tabId: 'tab-1', kind: 'sudo', command: 'sudo x' }])
    expect(waits).toEqual(['tab-1'])
    asks.answer(lastShown()[0].id, '')
    asks.answer(lastShown()[0].id, 'pw')
    expect(await answer).toEqual({ typed: 'pw' })
    expect(answeredTabs).toEqual(['tab-1'])
    expect(lastShown()).toEqual([])
  })

  it('an ask a listener shows elsewhere does not mark the session, can be answered there, and the listener hears how each ask ended', async () => {
    const { asks, waits } = setup()
    const heard: [string, HowItEnded][] = []
    asks.listen({ asked: () => true, ended: (id, how) => void heard.push([id, how]) })
    const fromThere = asks.ask(ask, LONG)
    const id = asks.views()[0].id
    expect(asks.pendingAsk(id)).toBe(ask)
    asks.answerFromElsewhere(id, { typed: 'pw' })
    expect(await fromThere).toEqual({ typed: 'pw' })
    expect(asks.pendingAsk(id)).toBeUndefined()
    void asks.ask(ask, LONG)
    asks.decline(asks.views()[0].id)
    expect(await asks.ask(ask, 5)).toEqual({ ended: 'timeout' })
    void asks.ask(ask, LONG)
    asks.forget('tab-1')
    expect(waits).toEqual([])
    expect(heard.map(([, how]) => how)).toEqual([
      'answered-elsewhere',
      'declined-in-koloft',
      'timeout',
      'closed'
    ])
  })

  it('a sudo ask is never ended by a done, only by what is typed', async () => {
    const { asks, lastShown } = setup()
    let settled = false
    void asks.ask(ask, LONG).then(() => (settled = true))
    asks.done(lastShown()[0].id)
    await settle()
    expect(settled).toBe(false)
  })

  it('a page ask ends once its own page loads another address; a sign-in ask ends only once the page that opened the sign-in lands on an http loopback address', async () => {
    const { asks } = setup()
    const page = asks.ask(
      { ...ask, shape: { kind: 'page', guestId: 7, url: 'https://a.example/login', label: 'P' } },
      LONG
    )
    const signInUrl = 'https://auth.example/authorize?x=1'
    const signIn = asks.ask({ ...ask, shape: { kind: 'url', signIn: signInUrl } }, LONG)
    let signedIn = false
    void signIn.then(() => (signedIn = true))
    asks.navigated(8, 'https://a.example/home')
    asks.navigated(9, 'http://localhost:3000/')
    asks.navigationStarted(9, signInUrl)
    asks.navigated(9, 'https://auth.example/consent')
    asks.navigated(10, 'http://localhost:1455/auth/callback?code=c')
    await settle()
    expect(signedIn).toBe(false)
    asks.navigated(7, 'https://a.example/home')
    expect(await page).toEqual({ doneInKoloft: true })
    asks.navigated(9, 'http://127.0.0.1:1455/auth/callback?code=c')
    expect(await signIn).toEqual({ doneInKoloft: true })
  })

  it('an ask from a Workbench shell ends when that shell closes, and one whose tab moves follows it to the new tab', async () => {
    const { asks, lastShown } = setup()
    const fromShell = asks.ask({ ...ask, from: 'shell-1' }, LONG)
    asks.forget('shell-1')
    expect(await fromShell).toEqual({ ended: 'timeout' })
    void asks.ask(ask, LONG)
    asks.rehome('tab-1', 'tab-9')
    expect(lastShown()).toMatchObject([{ tabId: 'tab-9' }])
  })
})
