import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import http from 'http'
import type { AddressInfo } from 'net'
import { startFakeGithub, type FakeGithub } from '../e2e/helpers/fakeGithub'

let fake: FakeGithub
let api: typeof import('../../src/main/githubApi')

beforeAll(async () => {
  fake = await startFakeGithub()
  fake.addUser('tok-bob', { login: 'bob', id: 42, name: 'Bob Example' })
  fake.addUser('tok-fine', { login: 'carol', scopes: null })
  fake.addUser('tok-narrow', { login: 'dave', scopes: 'repo, gist' })
  fake.setAccess('tok-bob', 'o/pushable', 'push')
  fake.setAccess('tok-bob', 'o/readonly', 'read')
  fake.setAccess('tok-bob', 'acme/locked', 'org-blocked')
  process.env.KOLOFT_GITHUB_API_URL = fake.url
  api = await import('../../src/main/githubApi')
})

afterAll(async () => {
  await fake.close()
})

async function closedPortUrl(): Promise<string> {
  const s = http.createServer()
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r))
  const port = (s.address() as AddressInfo).port
  await new Promise((r) => s.close(r))
  return `http://127.0.0.1:${port}`
}

describe('whoami', () => {
  it('reads login, id, name and the granted scopes of a classic token', async () => {
    expect(await api.whoami('tok-bob')).toEqual({
      ok: true,
      login: 'bob',
      id: 42,
      name: 'Bob Example',
      scopes: ['gist', 'read:org', 'repo', 'workflow']
    })
    expect(fake.hits.at(-1)?.authorization).toBe('Bearer tok-bob')
  })

  it('a token GitHub answers 401 for is expired', async () => {
    expect(await api.whoami('tok-unknown')).toEqual({ ok: false, error: 'expired' })
  })
})

describe('pushAccess', () => {
  it('reads permissions.push, and a repo the token cannot see is none', async () => {
    expect(await api.pushAccess('tok-bob', 'o', 'pushable')).toEqual({
      kind: 'push',
      allowed: true
    })
    expect(await api.pushAccess('tok-bob', 'o', 'readonly')).toEqual({
      kind: 'push',
      allowed: false
    })
    expect(await api.pushAccess('tok-bob', 'o', 'hidden')).toEqual({ kind: 'none' })
    expect(await api.pushAccess('tok-unknown', 'o', 'pushable')).toEqual({ kind: 'expired' })
  })

  it('a 403 about OAuth App access restrictions names the organization that blocks the app', async () => {
    expect(await api.pushAccess('tok-bob', 'acme', 'locked')).toEqual({
      kind: 'org-blocked',
      org: 'acme'
    })
  })
})

describe('unreachable GitHub', () => {
  it('a refused connection reads as offline for whoami and pushAccess alike', async () => {
    const before = process.env.KOLOFT_GITHUB_API_URL
    process.env.KOLOFT_GITHUB_API_URL = await closedPortUrl()
    vi.resetModules()
    const offline = await import('../../src/main/githubApi')
    process.env.KOLOFT_GITHUB_API_URL = before
    expect(await offline.whoami('tok-bob')).toEqual({ ok: false, error: 'offline' })
    expect(await offline.pushAccess('tok-bob', 'o', 'pushable')).toEqual({ kind: 'offline' })
  })
})
