import http from 'http'
import type { AddressInfo } from 'net'

export type ForgeKind = 'gitlab' | 'gitea'

export interface FakeForgeUser {
  login: string
  id: number
  name: string
  scopes: string[]
}

export interface FakeForgeHit {
  url: string
  basic: { username: string; password: string } | null
}

export interface FakeForge {
  url: string
  hits: FakeForgeHit[]
  addUser(token: string, user: Partial<FakeForgeUser> & { login: string }): void
  setAccess(token: string, repoPath: string, access: 'push' | 'read'): void
  refuseHttps(answer?: string): void
  close(): Promise<void>
}

const FAKE_SHA = 'b'.repeat(40)
const SMART_HTTP = /^\/(.+?)(?:\.git)?\/info\/refs\?service=(git-upload-pack|git-receive-pack)$/
const GITLAB_PROJECT = /^\/api\/v4\/projects\/([^/?]+)$/
const GITEA_REPO = /^\/api\/v1\/repos\/([^/]+)\/([^/?]+)$/
const GITLAB_DEVELOPER = 30
const GITLAB_REPORTER = 20
// PLATFORM§52
const HTTPS_OFF_TEXT: Record<ForgeKind, string> = {
  gitlab: 'Git access over HTTP is not allowed',
  gitea: 'Interacting with repositories by HTTP protocol is not allowed'
}

const pkt = (s: string): string => (s.length + 4).toString(16).padStart(4, '0') + s

function advertisement(service: string): string {
  const head =
    service === 'git-upload-pack'
      ? pkt(`${FAKE_SHA} HEAD\0\n`) + pkt(`${FAKE_SHA} refs/heads/main\n`)
      : pkt(`${FAKE_SHA} refs/heads/main\0report-status\n`)
  return pkt(`# service=${service}\n`) + '0000' + head + '0000'
}

function basicOf(header: string | undefined): FakeForgeHit['basic'] {
  if (!header?.startsWith('Basic ')) return null
  const raw = Buffer.from(header.slice('Basic '.length), 'base64').toString()
  const at = raw.indexOf(':')
  return at < 0 ? null : { username: raw.slice(0, at), password: raw.slice(at + 1) }
}

export async function startFakeForge(kind: ForgeKind): Promise<FakeForge> {
  const users = new Map<string, FakeForgeUser>()
  const access = new Map<string, 'push' | 'read'>()
  const hits: FakeForgeHit[] = []
  const realm = kind === 'gitlab' ? 'GitLab' : 'Gitea'
  let httpsOff: string | null = null

  const send = (res: http.ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
  }

  const server = http.createServer((req, res) => {
    const url = req.url ?? '/'
    const basic = basicOf(req.headers.authorization)
    hits.push({ url, basic })
    const smart = SMART_HTTP.exec(url)
    if (smart) {
      if (httpsOff) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
        return res.end(httpsOff)
      }
      if (!basic || !users.has(basic.password)) {
        res.writeHead(401, { 'WWW-Authenticate': `Basic realm="${realm}"` })
        return res.end()
      }
      res.writeHead(200, { 'Content-Type': `application/x-${smart[2]}-advertisement` })
      return res.end(advertisement(smart[2]))
    }
    if (url === '/api/v1/version') return send(res, 200, { version: '1.22.0' })
    const token = /^(?:Bearer|token) (.+)$/.exec(req.headers.authorization ?? '')?.[1]
    const user = token ? users.get(token) : undefined
    if (!token || !user) return send(res, 401, { message: '401 Unauthorized' })
    if (kind === 'gitlab') {
      if (url === '/api/v4/user')
        return send(res, 200, { username: user.login, id: user.id, name: user.name })
      if (url === '/api/v4/personal_access_tokens/self')
        return send(res, 200, { scopes: user.scopes })
      const project = GITLAB_PROJECT.exec(url)
      if (project) {
        const level = access.get(`${token} ${decodeURIComponent(project[1])}`)
        if (!level) return send(res, 404, { message: '404 Project Not Found' })
        const accessLevel = level === 'push' ? GITLAB_DEVELOPER : GITLAB_REPORTER
        return send(res, 200, {
          permissions: { project_access: { access_level: accessLevel }, group_access: null }
        })
      }
    } else {
      if (url === '/api/v1/user')
        return send(res, 200, { login: user.login, id: user.id, full_name: user.name })
      const repo = GITEA_REPO.exec(url)
      if (repo) {
        const level = access.get(`${token} ${repo[1]}/${repo[2]}`)
        if (!level) return send(res, 404, { message: 'Not Found' })
        return send(res, 200, { permissions: { push: level === 'push', pull: true } })
      }
    }
    send(res, 404, { message: 'Not Found' })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as AddressInfo).port
  let nextId = 2000

  return {
    url: `http://127.0.0.1:${port}`,
    hits,
    addUser: (token, user) => {
      nextId++
      users.set(token, {
        login: user.login,
        id: user.id ?? nextId,
        name: user.name ?? user.login,
        scopes: user.scopes ?? ['write_repository', 'read_api']
      })
    },
    setAccess: (token, repoPath, level) => {
      access.set(`${token} ${repoPath}`, level)
    },
    refuseHttps: (answer = HTTPS_OFF_TEXT[kind]) => {
      httpsOff = answer
    },
    close: () =>
      new Promise<void>((r) => {
        server.close(() => r())
        server.closeAllConnections()
      })
  }
}
