import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { GitAuthRequests, type GitAuthRequest } from '../../src/main/gitAuthRequests'

let dir: string
let rejected: string[]
let asked: GitAuthRequest[]
let requests: GitAuthRequests

const TOKENS: Record<string, string> = { 'github.com/bob': 'gho_bob' }
const ONE_SWEEP_FOR_A_LOST_DROP_HAS_RUN_MS = 1200
const A_LOST_WATCH_EVENT_IS_SWEPT_UP_MS = 5000
const BOB = 'github.com/bob'

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-gitauth-'))
  rejected = []
  asked = []
  requests = new GitAuthRequests({
    credential: async (req) => {
      asked.push(req)
      const token = TOKENS[req.account]
      return token ? { username: 'bob', password: token } : null
    },
    ghToken: async (account) => TOKENS[account] ?? null,
    rejected: (account) => void rejected.push(account)
  })
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

function drop(id: string, body: unknown): string {
  const name = `git-${id}.json`
  fs.writeFileSync(path.join(dir, name), JSON.stringify(body))
  return name
}

const reply = (id: string): unknown =>
  JSON.parse(fs.readFileSync(path.join(dir, `gitres-${id}.json`), 'utf8'))

describe('GitAuthRequests', () => {
  it("answers a credential request with the account's credential, hands main git's protocol and host, and takes the request away", async () => {
    const body = { kind: 'credential', account: BOB, protocol: 'http', host: '127.0.0.1:3000' }
    const name = drop('a1', body)
    await requests.answer(dir, name, body)
    expect(reply('a1')).toEqual({ username: 'bob', password: 'gho_bob' })
    expect(asked).toEqual([body])
    await vi.waitFor(() => expect(fs.existsSync(path.join(dir, name))).toBe(false))
  })

  it('answers a gh request with the token', async () => {
    await requests.answer(dir, 'git-a2.json', { kind: 'gh-token', account: BOB })
    expect(reply('a2')).toEqual({ token: 'gho_bob' })
  })

  it('answers {} at once when main has nothing to hand over and for a request it cannot read, so the script never waits out its time', async () => {
    await requests.answer(dir, 'git-a3.json', { kind: 'credential', account: 'github.com/eve' })
    await requests.answer(dir, 'git-a4.json', { kind: 'gh-token', account: 'github.com/eve' })
    await requests.answer(dir, 'git-a5.json', 'nonsense')
    await requests.answer(dir, 'git-a7.json', { kind: 'credential' })
    for (const id of ['a3', 'a4', 'a5', 'a7']) expect(reply(id)).toEqual({})
  })

  it('a rejected token is reported and never answered', async () => {
    await requests.answer(dir, 'git-a6.json', { kind: 'rejected', account: BOB })
    expect(rejected).toEqual([BOB])
    expect(fs.existsSync(path.join(dir, 'gitres-a6.json'))).toBe(false)
  })

  it('watching the folder answers each request once and never takes its own reply for a request', async () => {
    const watcher = requests.watch(dir)
    try {
      drop('w1', { kind: 'credential', account: BOB, protocol: 'https', host: 'github.com' })
      await vi.waitFor(
        () => expect(reply('w1')).toEqual({ username: 'bob', password: 'gho_bob' }),
        { timeout: A_LOST_WATCH_EVENT_IS_SWEPT_UP_MS }
      )
      fs.writeFileSync(
        path.join(dir, 'gitres-w2.json'),
        JSON.stringify({ kind: 'rejected', account: BOB })
      )
      drop('w3', { kind: 'rejected', account: BOB })
      await vi.waitFor(() => expect(rejected).toEqual([BOB]), {
        timeout: A_LOST_WATCH_EVENT_IS_SWEPT_UP_MS
      })
      await new Promise((r) => setTimeout(r, ONE_SWEEP_FOR_A_LOST_DROP_HAS_RUN_MS))
      expect(rejected).toEqual([BOB])
    } finally {
      watcher?.close()
    }
  })
})
