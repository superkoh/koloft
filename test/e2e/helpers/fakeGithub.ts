import http from 'http'
import type { AddressInfo } from 'net'

export interface FakeGithubUser {
  login: string
  id: number
  name: string | null
  scopes: string | null
}

export type FakeRepoAccess = 'push' | 'read' | 'org-blocked'

export interface FakeGithubHit {
  method: string
  url: string
  authorization: string | null
  basic: { username: string; password: string } | null
}

export interface FakeGithub {
  url: string
  hits: FakeGithubHit[]
  addUser(token: string, user: Partial<FakeGithubUser> & { login: string }): void
  removeToken(token: string): void
  setAccess(token: string, repo: string, access: FakeRepoAccess): void
  close(): Promise<void>
}

export const FAKE_GITHUB_FULL_SCOPES = 'gist, read:org, repo, workflow'
const FAKE_SHA = 'a'.repeat(40)
const SMART_HTTP =
  /^\/([^/]+)\/([^/]+?)(?:\.git)?\/info\/refs\?service=(git-upload-pack|git-receive-pack)$/
const REPO_ROUTE = /^\/repos\/([^/]+)\/([^/?]+)$/
const ENTERPRISE_API = '/api/v3'

const pkt = (s: string): string => (s.length + 4).toString(16).padStart(4, '0') + s

function advertisement(service: string): string {
  const head =
    service === 'git-upload-pack'
      ? pkt(`${FAKE_SHA} HEAD\0\n`) + pkt(`${FAKE_SHA} refs/heads/main\n`)
      : pkt(`${FAKE_SHA} refs/heads/main\0report-status\n`)
  return pkt(`# service=${service}\n`) + '0000' + head + '0000'
}

function basicOf(header: string | undefined): FakeGithubHit['basic'] {
  if (!header?.startsWith('Basic ')) return null
  const raw = Buffer.from(header.slice('Basic '.length), 'base64').toString()
  const at = raw.indexOf(':')
  return at < 0 ? null : { username: raw.slice(0, at), password: raw.slice(at + 1) }
}

function bearerOf(header: string | undefined): string | null {
  const m = /^(?:Bearer|token) (.+)$/.exec(header ?? '')
  return m ? m[1] : null
}

function orgBlockedMessage(org: string): string {
  return `Although you appear to have the correct authorization credentials, the \`${org}\` organization has enabled OAuth App access restrictions, meaning that data access to third-parties is limited.`
}

export async function startFakeGithub(): Promise<FakeGithub> {
  const users = new Map<string, FakeGithubUser>()
  const access = new Map<string, FakeRepoAccess>()
  const hits: FakeGithubHit[] = []

  const send = (res: http.ServerResponse, status: number, body: unknown, headers = {}): void => {
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers })
    res.end(JSON.stringify(body))
  }

  const server = http.createServer((req, res) => {
    const url = req.url ?? '/'
    const basic = basicOf(req.headers.authorization)
    hits.push({
      method: req.method ?? 'GET',
      url,
      authorization: req.headers.authorization ?? null,
      basic
    })
    const smart = SMART_HTTP.exec(url)
    if (smart) {
      if (!basic || !users.has(basic.password)) {
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="GitHub"' })
        return res.end()
      }
      res.writeHead(200, {
        'Content-Type': `application/x-${smart[3]}-advertisement`,
        'Cache-Control': 'no-cache'
      })
      return res.end(advertisement(smart[3]))
    }
    const token = bearerOf(req.headers.authorization)
    const user = token ? users.get(token) : undefined
    if (!user) return send(res, 401, { message: 'Bad credentials', status: '401' })
    const route = url.startsWith(ENTERPRISE_API) ? url.slice(ENTERPRISE_API.length) : url
    if (route === '/user') {
      const headers = user.scopes === null ? {} : { 'X-OAuth-Scopes': user.scopes }
      return send(res, 200, { login: user.login, id: user.id, name: user.name }, headers)
    }
    const repo = REPO_ROUTE.exec(route)
    if (repo) {
      const full = `${repo[1]}/${repo[2]}`
      const level = access.get(`${token} ${full}`)
      if (!level) return send(res, 404, { message: 'Not Found', status: '404' })
      if (level === 'org-blocked')
        return send(res, 403, { message: orgBlockedMessage(repo[1]), status: '403' })
      return send(res, 200, {
        full_name: full,
        permissions: { admin: false, push: level === 'push', pull: true }
      })
    }
    send(res, 404, { message: 'Not Found', status: '404' })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as AddressInfo).port
  let nextId = 1000

  return {
    url: `http://127.0.0.1:${port}`,
    hits,
    addUser: (token, user) => {
      nextId++
      users.set(token, {
        id: user.id ?? nextId,
        name: user.name === undefined ? user.login : user.name,
        scopes: user.scopes === undefined ? FAKE_GITHUB_FULL_SCOPES : user.scopes,
        login: user.login
      })
    },
    removeToken: (token) => {
      users.delete(token)
    },
    setAccess: (token, repo, level) => {
      access.set(`${token} ${repo}`, level)
    },
    close: () =>
      new Promise<void>((r) => {
        server.close(() => r())
        server.closeAllConnections()
      })
  }
}
