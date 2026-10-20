import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { SessionInfo } from '../../src/shared/types'
import { discordVerb, NOT_A_PAGE, NOT_THE_BUTLER } from '../../src/main/agentDiscord'
import { EXIT_USAGE } from '../../src/main/agentRequests'
import { DISCORD_SETUP_STEPS } from '../../src/main/discord/setupSteps'
import type { DiscordFile } from '../../src/main/discord/link'

let cwd: string
beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-discord-send-'))
})
afterEach(() => fs.rmSync(cwd, { recursive: true, force: true }))

function verb(butler: boolean, pageHeight = 900) {
  const sent: { channelId: string; files: DiscordFile[]; text: string }[] = []
  const shot: string[] = []
  let bound = 0
  const run = discordVerb({
    channelOf: () => (butler ? '222' : undefined),
    send: async (channelId, files, text) => {
      sent.push({ channelId, files, text })
    },
    shoot: async (url) => {
      shot.push(url)
      const files = pageHeight > 8000 ? ['page-1.png', 'page-2.png'] : ['page.png']
      return {
        files: files.map((name) => ({ name, data: Buffer.from(name) })),
        shownHeight: Math.min(pageHeight, 16000),
        pageHeight
      }
    },
    status: () => 'Bot token: saved',
    tokenFromPage: async () => 'Saved the bot token.',
    reload: async () => 'Reloaded.',
    invite: () => 'https://discord.com/oauth2/authorize?client_id=700',
    bindNewChannel: async () => {
      bound++
      return { ok: true }
    }
  })
  const call = (args: string[]) => run(args, { tabId: 'pty-1', cwd, session: {} as SessionInfo })
  return { call, sent, shot, bound: () => bound }
}

describe('koloft discord setup commands', () => {
  it('run for any session, so the one the butler starts to set Discord up can use them', async () => {
    const { call, bound } = verb(false)
    expect(await call(['setup'])).toEqual({ text: DISCORD_SETUP_STEPS, exit: 0 })
    expect(await call(['status'])).toEqual({ text: 'Bot token: saved', exit: 0 })
    expect(await call(['token', '--from-page'])).toEqual({
      text: 'Saved the bot token.',
      exit: 0
    })
    expect(await call(['bind', '--new-channel'])).toEqual({
      text: 'Bound to a new channel.',
      exit: 0
    })
    expect(bound()).toBe(1)
  })

  it('bind takes no workspace: there is only the butler’s channel', async () => {
    const { call, bound } = verb(false)
    expect((await call(['bind', '--new-channel', '--workspace', '/ws/a'])).exit).toBe(EXIT_USAGE)
    expect(bound()).toBe(0)
  })
})

describe('koloft discord send', () => {
  it('sends files named relative to the conductor’s folder, with the text after --', async () => {
    fs.mkdirSync(path.join(cwd, 'out'))
    fs.writeFileSync(path.join(cwd, 'out', 'shot.png'), 'png bytes')
    const { call, sent } = verb(true)
    expect(await call(['send', 'out/shot.png', '--', 'The', 'login', 'page.'])).toEqual({
      text: 'Sent to Discord.',
      exit: 0
    })
    expect(sent).toHaveLength(1)
    expect(sent[0].channelId).toBe('222')
    expect(sent[0].text).toBe('The login page.')
    expect(sent[0].files.map((f) => [f.name, f.data.toString()])).toEqual([
      ['shot.png', 'png bytes']
    ])
  })

  it('is refused to a session that is not the butler', async () => {
    fs.writeFileSync(path.join(cwd, 'a.txt'), 'a')
    const { call, sent } = verb(false)
    expect(await call(['send', 'a.txt'])).toEqual({ text: NOT_THE_BUTLER, exit: 1 })
    expect(sent).toEqual([])
  })

  it('refuses a file over 20 MB and sends nothing', async () => {
    fs.writeFileSync(path.join(cwd, 'small.txt'), 'a')
    const big = path.join(cwd, 'big.bin')
    fs.writeFileSync(big, '')
    fs.truncateSync(big, 21 * 1024 * 1024)
    const { call, sent } = verb(true)
    expect(await call(['send', 'small.txt', 'big.bin'])).toEqual({
      text: 'koloft: File too large (21.0 MB); the limit is 20 MB.',
      exit: 1
    })
    expect(sent).toEqual([])
  })
})

describe('koloft discord shot', () => {
  it('opens a file named relative to the butler’s folder as a file address, and sends its picture with the text after --', async () => {
    fs.writeFileSync(path.join(cwd, 'plan page.html'), '<p>plan</p>')
    const { call, sent, shot } = verb(true)
    expect(await call(['shot', 'plan page.html', '--', 'The', 'plan.'])).toEqual({
      text: 'Sent a picture of the page to Discord.',
      exit: 0
    })
    expect(shot).toEqual([`file://${encodeURI(path.join(cwd, 'plan page.html'))}`])
    expect(sent.map((s) => [s.channelId, s.text, s.files.map((f) => f.name)])).toEqual([
      ['222', 'The plan.', ['page.png']]
    ])
  })

  it('opens a web address as it is, and says how many pictures a tall page took and where they stop', async () => {
    const { call, shot } = verb(true, 20000)
    expect(await call(['shot', 'http://localhost:5173/'])).toEqual({
      text: 'Sent the page to Discord as 2 pictures, top to bottom. The page is 20000 pixels tall; the pictures stop at 16000.',
      exit: 0
    })
    expect(shot).toEqual(['http://localhost:5173/'])
  })

  it('refuses a file that is not there or not a web page, a second page, and any session that is not the butler', async () => {
    fs.writeFileSync(path.join(cwd, 'a.html'), 'a')
    fs.writeFileSync(path.join(cwd, 'notes.txt'), 'n')
    const butler = verb(true)
    expect(await butler.call(['shot', 'missing.html'])).toEqual({ text: NOT_A_PAGE, exit: 1 })
    expect(await butler.call(['shot', 'notes.txt'])).toEqual({ text: NOT_A_PAGE, exit: 1 })
    expect((await butler.call(['shot', 'a.html', 'a.html'])).exit).toBe(EXIT_USAGE)
    const other = verb(false)
    expect(await other.call(['shot', 'a.html'])).toEqual({ text: NOT_THE_BUTLER, exit: 1 })
    expect([...butler.shot, ...other.shot]).toEqual([])
  })
})
