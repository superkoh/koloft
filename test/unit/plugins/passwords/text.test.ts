import { describe, expect, it } from 'vitest'
import { secretVerb } from '../../../../src/plugins/passwords/main/secretVerb'
import type { SecretAnswer, SecretAsk } from '../../../../src/plugins/passwords/main/secretAsks'
import {
  ASKPASS,
  SUDO_FILES_WHERE_ANY_TERMINAL_IS_THE_OWNERS,
  SUDO_SHIM_FILES
} from '../../../../src/plugins/passwords/main/sudoShim'
import { pageVerb, type TapPage } from '../../../../src/main/agentPageTap'
import type { TapRounds } from '../../../../src/main/discord/secretCards'
import type { WebPage } from '../../../../src/core/webPage'
import type { AgentCaller } from '../../../../src/main/agentRequests'
import type { SessionInfo } from '../../../../src/shared/types'

const caller: AgentCaller = {
  tabId: 'tab-1',
  cwd: '/w',
  session: { tabId: 'tab-1', title: 'Fix login' } as SessionInfo
}

const fieldPage = (keptAfterSubmit: boolean, moves = false): WebPage => {
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
  over: { asleep?: boolean; pages?: WebPage[]; machine?: string } = {}
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
    await expect(lines.join('\n') + '\n').toMatchFileSnapshot('./text/replies.txt')
  })

  it('what the owner is asked and what the agent hears from koloft page tap, and what each tap round says', async () => {
    const part = { x: 10, y: 10, width: 100, height: 60 }
    const view = { x: 0, y: 0, width: 800, height: 600 }
    const tapPage = (count: number, inView = true): TapPage => ({
      guestId: 7,
      url: () => 'https://shop.example/checkout',
      find: async () =>
        count === 1
          ? { count, box: inView ? part : { ...part, x: 2000 }, view, ratio: 2, frames: [] }
          : { count },
      picture: async () => Buffer.from('png'),
      tap: async () => undefined
    })
    const tapSaid = async (
      args: string[],
      answer: SecretAnswer,
      over: { asleep?: boolean; pages?: TapPage[] } = {}
    ): Promise<string> => {
      const asked: (SecretAsk & { taps: TapRounds })[] = []
      const verb = pageVerb({
        sessionTab: (tabId) => tabId,
        ask: async (a) => {
          asked.push(a)
          return answer
        },
        ownerAsleep: () => !!over.asleep,
        pages: () => over.pages ?? [tapPage(1)],
        draw: async () => ({ name: 'grid.png', data: Buffer.from('grid') }),
        sleep: async () => undefined
      })
      const reply = await verb(args, caller)
      const ask = asked[0]
      const rounds: string[] = []
      if (ask && 'passed' in answer) {
        rounds.push(`  tap before a picture: ${await ask.taps.tap('A1', () => true)}`)
        const shot = await ask.taps.picture()
        shot.seen()
        rounds.push(`  picture: ${shot.file.name}`)
        rounds.push(`  tap A1 B2: ${await ask.taps.tap('A1 B2', () => true)}`)
        rounds.push(`  tap Z99 Q: ${await ask.taps.tap('Z99 Q', () => true)}`)
        rounds.push(`  tap nothing: ${await ask.taps.tap('', () => true)}`)
      }
      return [
        `$ koloft page ${args.join(' ')}  → ${JSON.stringify(answer)}`,
        ...(ask
          ? [`  header: ${ask.header('NAME')}`, `  body: ${ask.body}`, `  label: ${ask.label}`]
          : []),
        ...rounds,
        `  exit ${reply.exit}: ${reply.text}`
      ].join('\n')
    }
    const TAP = ['tap', 'iframe', '--', 'Pass the robot check']
    let pictureError = ''
    const outOfView = pageVerb({
      sessionTab: (tabId) => tabId,
      ask: async (a) => {
        pictureError = await a.taps.picture().then(
          () => 'none',
          (e: Error) => e.message
        )
        return { ended: 'declined' }
      },
      ownerAsleep: () => false,
      pages: () => [tapPage(1, false)],
      draw: async () => ({ name: 'grid.png', data: Buffer.from('grid') }),
      sleep: async () => undefined
    })
    await outOfView(TAP, caller)
    const lines = [
      await tapSaid(TAP, { passed: true }),
      await tapSaid(TAP, { doneInKoloft: true }),
      await tapSaid(TAP, { ended: 'declined' }),
      await tapSaid(TAP, { ended: 'timeout' }),
      await tapSaid(TAP, { passed: true }, { asleep: true }),
      await tapSaid(TAP, { passed: true }, { pages: [tapPage(0)] }),
      await tapSaid(TAP, { passed: true }, { pages: [tapPage(1), tapPage(1)] }),
      await tapSaid(['tap', 'iframe'], { passed: true }),
      `the picture of a part out of view fails with: ${pictureError}`
    ]
    await expect(lines.join('\n') + '\n').toMatchFileSnapshot('./text/page-tap.txt')
  })

  it('the sudo wrapper and askpass files, as each kind of session tab gets them', async () => {
    const files = (set: Record<string, string>): string =>
      Object.entries(set)
        .map(([name, text]) => `=== ${name}\n${text}`)
        .join('')
    await expect(files(SUDO_SHIM_FILES)).toMatchFileSnapshot('./text/sudo-shim-files.txt')
    await expect(files(SUDO_FILES_WHERE_ANY_TERMINAL_IS_THE_OWNERS)).toMatchFileSnapshot(
      './text/sudo-files-any-terminal.txt'
    )
    expect(SUDO_SHIM_FILES['koloft-askpass']).toBe(ASKPASS)
  })
})
