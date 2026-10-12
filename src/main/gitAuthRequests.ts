import fs from 'fs'
import path from 'path'
import type { GitHost } from '@shared/types'
import { watchAndSweepJsonDrops, writeWholeBeforeVisible } from './jsonDrops'

export const GIT_AUTH_REQUEST_NAME = /^git-([A-Za-z0-9-]+)\.json$/
const CLAIM_OUTLIVES_DROP_REREADS_MS = 500

interface GitAuthRequest {
  kind: 'credential' | 'gh-token' | 'rejected'
  host: GitHost
  account: string
}

function parseGitAuthRequest(raw: unknown): GitAuthRequest | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (r.kind !== 'credential' && r.kind !== 'gh-token' && r.kind !== 'rejected') return null
  if (r.host !== 'github.com' || typeof r.account !== 'string' || !r.account) return null
  return { kind: r.kind, host: r.host, account: r.account }
}

export interface GitAuthRequestDeps {
  token(host: GitHost, login: string): Promise<string | null>
  rejected(host: GitHost, login: string): void
}

export class GitAuthRequests {
  private claimed = new Set<string>()

  constructor(private deps: GitAuthRequestDeps) {}

  watch(dir: string): fs.FSWatcher | null {
    return watchAndSweepJsonDrops(dir, (name) =>
      GIT_AUTH_REQUEST_NAME.test(name) ? (obj): void => void this.answer(dir, name, obj) : null
    )
  }

  async answer(dir: string, name: string, raw: unknown): Promise<void> {
    const id = GIT_AUTH_REQUEST_NAME.exec(name)?.[1]
    const full = path.join(dir, name)
    if (!id || this.claimed.has(full)) return
    this.claimed.add(full)
    fs.rm(full, { force: true }, () =>
      setTimeout(() => this.claimed.delete(full), CLAIM_OUTLIVES_DROP_REREADS_MS)
    )
    const req = parseGitAuthRequest(raw)
    if (req?.kind === 'rejected') return this.deps.rejected(req.host, req.account)
    const token = req ? await this.deps.token(req.host, req.account) : null
    let reply = {}
    if (req && token)
      reply =
        req.kind === 'credential'
          ? { username: req.account, password: token }
          : { token, host: req.host }
    try {
      writeWholeBeforeVisible(path.join(dir, `gitres-${id}.json`), JSON.stringify(reply))
    } catch {}
  }
}
