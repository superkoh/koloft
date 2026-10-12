import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { SessionInfo } from '../../src/shared/types'
import { discordVerb, NOT_A_CONDUCTOR, NOT_THE_SETUP_TASK } from '../../src/main/agentDiscord'
import { EXIT_USAGE } from '../../src/main/agentRequests'
import { GLOBAL_SCOPE } from '../../src/shared/conductors'
import type { DiscordFile } from '../../src/main/discord/link'

let cwd: string
beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-discord-send-'))
})
afterEach(() => fs.rmSync(cwd, { recursive: true, force: true }))

function verb(conductor: boolean, setupTask = false) {
  const sent: { channelId: string; files: DiscordFile[]; text: string }[] = []
  const bound: string[] = []
  const run = discordVerb({
    channelOf: () => (conductor ? '222' : undefined),
    send: async (channelId, files, text) => {
      sent.push({ channelId, files, text })
    },
    isSetupTask: () => setupTask,
    status: () => 'Bot token: saved',
    tokenFromPage: async () => 'Saved the bot token.',
    invite: () => 'https://discord.com/oauth2/authorize?client_id=700',
    bindNewChannel: async (scope) => {
      bound.push(scope)
      return { ok: true }
    }
  })
  const call = (args: string[]) => run(args, { tabId: 'pty-1', cwd, session: {} as SessionInfo })
  return { call, sent, bound }
}

describe('koloft discord setup commands', () => {
  it('answer only the global Assist’s Discord setup task, and nothing runs for anyone else', async () => {
    const { call, bound } = verb(true, false)
    for (const args of [
      ['status'],
      ['token', '--from-page'],
      ['invite'],
      ['bind', '--new-channel']
    ])
      expect(await call(args)).toEqual({ text: NOT_THE_SETUP_TASK, exit: 1 })
    expect(bound).toEqual([])
  })

  it('bind --new-channel binds the global Assist, or the workspace named after --workspace', async () => {
    const { call, bound } = verb(false, true)
    expect(await call(['bind', '--new-channel'])).toEqual({
      text: 'Bound to a new channel.',
      exit: 0
    })
    expect((await call(['bind', '--new-channel', '--workspace', '/ws/a'])).exit).toBe(0)
    expect((await call(['bind', '--new-channel', '--workspace'])).exit).toBe(EXIT_USAGE)
    expect(bound).toEqual([GLOBAL_SCOPE, '/ws/a'])
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

  it('is refused to a session that is not a conductor', async () => {
    fs.writeFileSync(path.join(cwd, 'a.txt'), 'a')
    const { call, sent } = verb(false)
    expect(await call(['send', 'a.txt'])).toEqual({ text: NOT_A_CONDUCTOR, exit: 1 })
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
