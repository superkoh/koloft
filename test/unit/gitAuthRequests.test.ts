import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { GitAuthRequests } from '../../src/main/gitAuthRequests'

let dir: string
let rejected: string[]
let requests: GitAuthRequests

const TOKENS: Record<string, string> = { bob: 'gho_bob' }
const ONE_SWEEP_FOR_A_LOST_DROP_HAS_RUN_MS = 1200
const A_LOST_WATCH_EVENT_IS_SWEPT_UP_MS = 5000

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-gitauth-'))
  rejected = []
  requests = new GitAuthRequests({
    token: async (_host, login) => TOKENS[login] ?? null,
    rejected: (host, login) => void rejected.push(`${host}/${login}`)
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
  it("answers a credential request with the account's token, and takes the request away", async () => {
    const name = drop('a1', { kind: 'credential', host: 'github.com', account: 'bob' })
    await requests.answer(dir, name, { kind: 'credential', host: 'github.com', account: 'bob' })
    expect(reply('a1')).toEqual({ username: 'bob', password: 'gho_bob' })
    await vi.waitFor(() => expect(fs.existsSync(path.join(dir, name))).toBe(false))
  })

  it('answers a gh request with the token and its host', async () => {
    await requests.answer(dir, 'git-a2.json', {
      kind: 'gh-token',
      host: 'github.com',
      account: 'bob'
    })
    expect(reply('a2')).toEqual({ token: 'gho_bob', host: 'github.com' })
  })

  it('answers {} at once for an account with no token and for a request it cannot read, so the script never waits out its time', async () => {
    await requests.answer(dir, 'git-a3.json', {
      kind: 'credential',
      host: 'github.com',
      account: 'eve'
    })
    await requests.answer(dir, 'git-a4.json', {
      kind: 'credential',
      host: 'example.com',
      account: 'bob'
    })
    await requests.answer(dir, 'git-a5.json', 'nonsense')
    for (const id of ['a3', 'a4', 'a5']) expect(reply(id)).toEqual({})
  })

  it('a rejected token is reported and never answered', async () => {
    await requests.answer(dir, 'git-a6.json', {
      kind: 'rejected',
      host: 'github.com',
      account: 'bob'
    })
    expect(rejected).toEqual(['github.com/bob'])
    expect(fs.existsSync(path.join(dir, 'gitres-a6.json'))).toBe(false)
  })

  it('watching the folder answers each request once and never takes its own reply for a request', async () => {
    const watcher = requests.watch(dir)
    try {
      drop('w1', { kind: 'credential', host: 'github.com', account: 'bob' })
      await vi.waitFor(
        () => expect(reply('w1')).toEqual({ username: 'bob', password: 'gho_bob' }),
        { timeout: A_LOST_WATCH_EVENT_IS_SWEPT_UP_MS }
      )
      fs.writeFileSync(
        path.join(dir, 'gitres-w2.json'),
        JSON.stringify({ kind: 'rejected', host: 'github.com', account: 'bob' })
      )
      drop('w3', { kind: 'rejected', host: 'github.com', account: 'bob' })
      await vi.waitFor(() => expect(rejected).toEqual(['github.com/bob']), {
        timeout: A_LOST_WATCH_EVENT_IS_SWEPT_UP_MS
      })
      await new Promise((r) => setTimeout(r, ONE_SWEEP_FOR_A_LOST_DROP_HAS_RUN_MS))
      expect(rejected).toEqual(['github.com/bob'])
    } finally {
      watcher?.close()
    }
  })
})
