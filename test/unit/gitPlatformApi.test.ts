import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import http from 'http'
import type { AddressInfo } from 'net'
import { identify, missingScopeOn, pushAccessOn } from '../../src/main/gitPlatformApi'

type Answer = [number, unknown]
let routes: Map<string, (auth: string) => Answer>
let server: http.Server
let base: string

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const route = routes.get((req.url ?? '').split('?')[0])
    const [status, body] = route
      ? route(req.headers.authorization ?? '')
      : [404, { message: 'Not Found' }]
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  server.closeAllConnections()
  await new Promise((r) => server.close(r))
})

beforeEach(() => {
  routes = new Map()
})

const signedIn =
  (token: string, body: unknown): ((auth: string) => Answer) =>
  (auth) =>
    auth === `Bearer ${token}` ? [200, body] : [401, { message: '401 Unauthorized' }]

async function closedPortUrl(): Promise<string> {
  const s = http.createServer()
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r))
  const port = (s.address() as AddressInfo).port
  await new Promise((r) => s.close(r))
  return `http://127.0.0.1:${port}`
}

describe('GitLab', () => {
  it('names the user, takes the commit email the user set, and reads a personal token’s scopes', async () => {
    routes.set(
      '/api/v4/user',
      signedIn('glpat', { username: 'dev', id: 7, name: 'Dev Ops', commit_email: 'dev@corp.com' })
    )
    routes.set(
      '/api/v4/personal_access_tokens/self',
      signedIn('glpat', { scopes: ['write_repository', 'read_api'] })
    )
    expect(await identify({ platform: 'gitlab', url: base }, 'glpat')).toEqual({
      ok: true,
      login: 'dev',
      scopes: ['write_repository', 'read_api'],
      author: { name: 'Dev Ops', email: 'dev@corp.com' }
    })
  })

  it('with no commit email set, the author is GitLab’s private address on that host; an OAuth token has no scope list', async () => {
    routes.set('/api/v4/user', signedIn('oauth', { username: 'dev', id: 7, name: '' }))
    expect(await identify({ platform: 'gitlab', url: base }, 'oauth')).toEqual({
      ok: true,
      login: 'dev',
      scopes: null,
      author: { name: 'dev', email: '7-dev@users.noreply.127.0.0.1' }
    })
  })

  it('can push from Developer (30) up; Reporter (20) cannot; an unseen project is none', async () => {
    const project = (level: number) =>
      signedIn('glpat', {
        permissions: { project_access: null, group_access: { access_level: level } }
      })
    routes.set(`/api/v4/projects/${encodeURIComponent('grp/sub/app')}`, project(30))
    expect(await pushAccessOn({ platform: 'gitlab', url: base }, 'glpat', 'grp/sub/app')).toEqual({
      kind: 'push',
      allowed: true
    })
    routes.set(`/api/v4/projects/${encodeURIComponent('grp/sub/app')}`, project(20))
    expect(await pushAccessOn({ platform: 'gitlab', url: base }, 'glpat', 'grp/sub/app')).toEqual({
      kind: 'push',
      allowed: false
    })
    expect(await pushAccessOn({ platform: 'gitlab', url: base }, 'glpat', 'grp/other')).toEqual({
      kind: 'none'
    })
  })

  it('missingScopeOn names a missing GitLab scope, but says nothing when no scope list could be read', () => {
    expect(missingScopeOn('gitlab', ['read_api'])).toBe('write_repository')
    expect(missingScopeOn('gitlab', null)).toBeUndefined()
    expect(missingScopeOn('github', null)).toBe('repo')
    expect(missingScopeOn('github', ['repo', 'gist'])).toBe('read:org')
    expect(missingScopeOn('github', ['gist', 'read:org', 'repo', 'workflow'])).toBeUndefined()
    expect(missingScopeOn('gitea', null)).toBeUndefined()
  })
})

describe('Gitea / Forgejo', () => {
  const user = signedIn('tea', { login: 'carol', id: 12, full_name: 'Carol C' })

  it('the private commit address carries the id from Gitea 1.26 on, and not before', async () => {
    routes.set('/api/v1/user', user)
    routes.set('/api/v1/version', () => [200, { version: '1.26.0' }])
    expect(await identify({ platform: 'gitea', url: base }, 'tea')).toMatchObject({
      ok: true,
      login: 'carol',
      author: { name: 'Carol C', email: '12+carol@noreply.127.0.0.1' }
    })
    routes.set('/api/v1/version', () => [200, { version: '1.25.3' }])
    expect(await identify({ platform: 'gitea', url: base }, 'tea')).toMatchObject({
      author: { email: 'carol@noreply.127.0.0.1' }
    })
  })

  it('a Forgejo version is read by the Gitea version it carries', async () => {
    routes.set('/api/v1/user', user)
    routes.set('/api/v1/version', () => [200, { version: '7.0.0+gitea-1.22.0' }])
    expect(await identify({ platform: 'gitea', url: base }, 'tea')).toMatchObject({
      author: { email: 'carol@noreply.127.0.0.1' }
    })
  })

  it('reads permissions.push', async () => {
    routes.set('/api/v1/repos/o/r', signedIn('tea', { permissions: { push: true } }))
    expect(await pushAccessOn({ platform: 'gitea', url: base }, 'tea', 'o/r')).toEqual({
      kind: 'push',
      allowed: true
    })
  })
})

describe('Azure DevOps', () => {
  it('names the signed-in user from connectionData, with the token as Basic and no sign-in redirect', async () => {
    let headers: string[] = []
    routes.set('/acme/_apis/connectionData', (auth) => {
      headers = [auth]
      return auth === `Basic ${Buffer.from(':pat').toString('base64')}`
        ? [200, { authenticatedUser: { properties: { Account: { $value: 'me@acme.com' } } } }]
        : [203, {}]
    })
    expect(await identify({ platform: 'azure', url: `${base}/acme` }, 'pat')).toEqual({
      ok: true,
      login: 'me@acme.com',
      scopes: null
    })
    expect(headers[0]).toMatch(/^Basic /)
  })

  it('the 203 sign-in page Azure gives a bad token reads as expired', async () => {
    routes.set('/acme/_apis/connectionData', () => [203, {}])
    expect(await identify({ platform: 'azure', url: `${base}/acme` }, 'bad')).toEqual({
      ok: false,
      error: 'expired'
    })
  })
})

describe('every platform', () => {
  it('a 401 is expired', async () => {
    routes.set('/api/v4/user', () => [401, {}])
    routes.set('/api/v1/user', () => [401, {}])
    expect(await identify({ platform: 'gitlab', url: base }, 'x')).toEqual({
      ok: false,
      error: 'expired'
    })
    expect(await identify({ platform: 'gitea', url: base }, 'x')).toEqual({
      ok: false,
      error: 'expired'
    })
  })

  it('a server that does not answer is offline, never expired', async () => {
    const gone = await closedPortUrl()
    expect(await identify({ platform: 'gitlab', url: gone }, 'x')).toEqual({
      ok: false,
      error: 'offline'
    })
    expect(await pushAccessOn({ platform: 'gitea', url: gone }, 'x', 'o/r')).toEqual({
      kind: 'offline'
    })
  })
})
