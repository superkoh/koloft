import { describe, expect, it } from 'vitest'
import {
  ASKER_GONE,
  FILLED,
  FILLED_AND_EMPTIED,
  NO_DISCORD,
  NO_SUCH_FIELD,
  NOT_IN_TIME,
  NOT_LOOPBACK,
  PAGE_CHANGED,
  secretVerb,
  type FieldPage,
  type SecretVerbDeps
} from '../../src/main/agentSecret'
import type { SecretAsk } from '../../src/main/discord/secretAsks'
import type { AgentCaller } from '../../src/main/agentRequests'
import type { SessionInfo } from '../../src/shared/types'

const session = { tabId: 'tab-1', title: 'Fix login' } as SessionInfo

function caller(pid?: number): AgentCaller {
  return { tabId: 'tab-1', cwd: '/w', session, pid }
}

interface FakeField {
  count: number
  label?: string
  keptAfterSubmit?: boolean
}

function page(url: string, field: FakeField, run: string[] = []): FieldPage & { url_: string } {
  const p = {
    url_: url,
    url: () => p.url_,
    run: async (script: string) => {
      run.push(script)
      if (script.includes('requestSubmit')) return field.count === 1
      if (script.includes("set(els[0], '')")) return !!field.keptAfterSubmit
      return { count: field.count, label: field.label }
    }
  }
  return p
}

function setup(over: Partial<SecretVerbDeps> = {}, answer: string | undefined | null = 'pw') {
  const asked: SecretAsk[] = []
  const opened: string[] = []
  const verb = secretVerb({
    ask: async (a) => {
      asked.push(a)
      return answer
    },
    alive: () => true,
    machine: () => undefined,
    pages: () => [],
    open: async (_tab, url) => {
      opened.push(url)
      return '200'
    },
    sleep: async () => undefined,
    ...over
  })
  return { verb, asked, opened }
}

describe('koloft secret sudo (what Koloft’s password helper runs)', () => {
  it('shows the owner the command that asked, and prints the password only for sudo', async () => {
    const { verb, asked } = setup()
    const r = await verb(
      ['sudo', 'Password:', '/usr/bin/sudo -A brew services restart nginx'],
      caller(42)
    )
    expect(r).toEqual({ exit: 0, text: 'pw' })
    expect(asked[0].header('fix-login')).toContain('sudo password')
    expect(asked[0].body).toContain('/usr/bin/sudo -A brew services restart nginx')
  })

  it('without Discord, or with no answer in time, sudo gets nothing', async () => {
    expect((await setup({}, null).verb(['sudo', 'Password:', 'x'], caller())).text).toBe(NO_DISCORD)
    const late = setup({ ask: async () => undefined })
    expect((await late.verb(['sudo', 'Password:', 'x'], caller())).text).toBe(NOT_IN_TIME)
  })

  it('a password that arrives after the command stopped waiting on this Mac is not written out', async () => {
    const { verb } = setup({ alive: () => false })
    expect((await verb(['sudo', 'Password:', 'x'], caller(42))).text).toBe(ASKER_GONE)
  })

  it('on another machine the pid is not this Mac’s, so it is not checked here', async () => {
    const { verb } = setup({ alive: () => false, machine: () => 'lab' })
    expect(await verb(['sudo', 'Password:', 'x'], caller(42))).toEqual({ exit: 0, text: 'pw' })
  })
})

describe('koloft secret page', () => {
  it('fills the one field the selector matches, names its site and field to the owner, and says it submitted', async () => {
    const scripts: string[] = []
    const p = page(
      'https://accounts.example.com/login?x=1',
      { count: 1, label: 'Password' },
      scripts
    )
    const { verb, asked } = setup({ pages: () => [p] })
    const r = await verb(['page', 'input[type=password]'], caller())
    expect(r).toEqual({ exit: 0, text: FILLED })
    expect(asked[0].body).toContain('https://accounts.example.com')
    expect(asked[0].body).toContain('Password')
    expect(asked[0].body).not.toContain('x=1')
  })

  it('a field still holding the text after the submit is emptied, so a later look at the page cannot read it', async () => {
    const p = page('https://a.example', { count: 1, label: 'Code', keptAfterSubmit: true })
    const { verb } = setup({ pages: () => [p] })
    expect((await verb(['page', '#otp'], caller())).text).toBe(FILLED_AND_EMPTIED)
  })

  it('asks nothing unless exactly one field in all open pages matches', async () => {
    for (const pages of [
      [],
      [page('https://a.example', { count: 2 })],
      [
        page('https://a.example', { count: 1, label: 'x' }),
        page('https://b.example', { count: 1, label: 'y' })
      ]
    ]) {
      const { verb, asked } = setup({ pages: () => pages })
      expect((await verb(['page', 'input'], caller())).text).toBe(NO_SUCH_FIELD)
      expect(asked).toEqual([])
    }
  })

  it('fills nothing when the page went to another site while the owner answered', async () => {
    const p = page('https://a.example/login', { count: 1, label: 'Password' })
    const { verb } = setup({
      pages: () => [p],
      ask: async () => {
        p.url_ = 'https://evil.example/'
        return 'pw'
      }
    })
    expect((await verb(['page', '#pw'], caller())).text).toBe(PAGE_CHANGED)
  })
})

describe('koloft secret url', () => {
  it('opens a pasted 127.0.0.1 or localhost address on the session’s machine and says what it answered', async () => {
    const { verb, opened, asked } = setup(
      {},
      ' http://127.0.0.1:1455/auth/callback?code=c&state=s '
    )
    const r = await verb(['url', 'https://auth.example/authorize?x'], caller())
    expect(opened).toEqual(['http://127.0.0.1:1455/auth/callback?code=c&state=s'])
    expect(r.text).toContain('answered 200')
    expect(asked[0].body).toContain('https://auth.example/authorize?x')
  })

  it('anything that is not a loopback http address is not opened', async () => {
    for (const pasted of [
      'https://evil.example/cb?code=c',
      'http://10.0.0.2:1455/cb',
      'not a url'
    ]) {
      const { verb, opened } = setup({}, pasted)
      expect((await verb(['url', 'https://auth.example'], caller())).text).toBe(NOT_LOOPBACK)
      expect(opened).toEqual([])
    }
  })
})
