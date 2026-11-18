import { describe, expect, it } from 'vitest'
import { secretVerb, type FieldPage } from '../../src/main/agentSecret'
import type { SecretAnswer, SecretAsk } from '../../src/main/discord/secretAsks'
import {
  ASKPASS,
  SUDO_FILES_WHERE_ANY_TERMINAL_IS_THE_OWNERS,
  SUDO_SHIM_FILES
} from '../../src/main/sudoShim'
import type { AgentCaller } from '../../src/main/agentRequests'
import type { SessionInfo } from '../../src/shared/types'

const caller: AgentCaller = {
  tabId: 'tab-1',
  cwd: '/w',
  session: { tabId: 'tab-1', title: 'Fix login' } as SessionInfo
}

const fieldPage = (keptAfterSubmit: boolean, moves = false): FieldPage => {
  let url = 'https://accounts.example.com/login?x=1'
  return {
    guestId: 7,
    url: () => url,
    run: async (script) => {
      if (script.includes('requestSubmit')) return true
      if (script.includes("set(els[0], '')")) return keptAfterSubmit
      if (script.includes('.focus()') && moves) url = 'https://evil.example/'
      return { count: 1, label: 'Password' }
    }
  }
}

async function said(
  args: string[],
  answer: SecretAnswer,
  over: { asleep?: boolean; pages?: FieldPage[]; machine?: string } = {}
): Promise<string> {
  const asked: SecretAsk[] = []
  const verb = secretVerb({
    sessionTab: (tabId) => tabId,
    ask: async (a) => {
      asked.push(a)
      return answer
    },
    ownerAsleep: () => !!over.asleep,
    machine: () => over.machine,
    pages: () => over.pages ?? [],
    showSignIn: () => undefined,
    open: async () => '200',
    sleep: async () => undefined
  })
  const reply = await verb(args, caller)
  const ask = asked[0]
  return [
    `$ koloft secret ${args.join(' ')}  → ${JSON.stringify(answer)}`,
    ...(ask
      ? [`  header: ${ask.header('NAME')}`, `  body: ${ask.body}`, `  label: ${ask.label}`]
      : []),
    `  exit ${reply.exit}: ${reply.text}`
  ].join('\n')
}

const SUDO = ['sudo', 'Password:', '/usr/bin/sudo -A brew services restart nginx']
const URL = ['url', 'https://auth.example/authorize?x']
const LOOPBACK = 'http://127.0.0.1:1455/auth/callback?code=c'

describe('the full text of koloft secret and of the sudo files it rests on, pinned so that moving them changes no character', () => {
  it('what the owner is asked and what the agent hears, for each way an ask ends', async () => {
    const lines = [
      await said(SUDO, { typed: 'pw' }),
      await said(SUDO, { ended: 'declined' }),
      await said(SUDO, { ended: 'timeout' }),
      await said(SUDO, { doneInKoloft: true }),
      await said(SUDO, { typed: 'pw' }, { asleep: true }),
      await said(['sudo'], { typed: 'pw' }),
      await said(['page', '#pw'], { typed: 'pw' }, { pages: [fieldPage(false)] }),
      await said(['page', '#pw'], { typed: 'pw' }, { pages: [fieldPage(true)] }),
      await said(['page', '#pw'], { doneInKoloft: true }, { pages: [fieldPage(false)] }),
      await said(['page', '#pw'], { doneInKoloft: true }, { pages: [fieldPage(true)] }),
      await said(['page', '#pw'], { typed: 'pw' }, { pages: [fieldPage(false, true)] }),
      await said(['page', '#pw'], { typed: 'pw' }),
      await said(URL, { typed: LOOPBACK }),
      await said(URL, { typed: LOOPBACK }, { machine: 'devbox' }),
      await said(URL, { doneInKoloft: true }),
      await said(URL, { doneInKoloft: true }, { machine: 'devbox' }),
      await said(URL, { typed: 'https://evil.example/cb' }),
      await said(['nope'], { typed: 'pw' })
    ]
    await expect(lines.join('\n') + '\n').toMatchFileSnapshot('./secret-verb-text/replies.txt')
  })

  it('the sudo wrapper and askpass files, as each kind of session tab gets them', async () => {
    const files = (set: Record<string, string>): string =>
      Object.entries(set)
        .map(([name, text]) => `=== ${name}\n${text}`)
        .join('')
    await expect(files(SUDO_SHIM_FILES)).toMatchFileSnapshot(
      './secret-verb-text/sudo-shim-files.txt'
    )
    await expect(files(SUDO_FILES_WHERE_ANY_TERMINAL_IS_THE_OWNERS)).toMatchFileSnapshot(
      './secret-verb-text/sudo-files-any-terminal.txt'
    )
    expect(SUDO_SHIM_FILES['koloft-askpass']).toBe(ASKPASS)
  })
})
