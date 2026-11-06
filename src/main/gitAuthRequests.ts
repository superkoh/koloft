import fs from 'fs'
import path from 'path'
import { watchAndSweepJsonDrops, writeWholeBeforeVisible } from './jsonDrops'

export const GIT_AUTH_REQUEST_NAME = /^git-([A-Za-z0-9-]+)\.json$/
const CLAIM_OUTLIVES_DROP_REREADS_MS = 500

export interface GitAuthRequest {
  kind: 'credential' | 'gh-token' | 'rejected'
  account: string
  protocol: string
  host: string
}

function text(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function parseGitAuthRequest(raw: unknown): GitAuthRequest | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (r.kind !== 'credential' && r.kind !== 'gh-token' && r.kind !== 'rejected') return null
  if (typeof r.account !== 'string' || !r.account) return null
  return { kind: r.kind, account: r.account, protocol: text(r.protocol), host: text(r.host) }
}

export interface GitCredential {
  username: string
  password: string
}

export interface GitAuthRequestDeps {
  credential(req: GitAuthRequest): Promise<GitCredential | null>
  ghToken(account: string): Promise<string | null>
  rejected(account: string): void
}

// ADR-0033 CODEX§29
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
    if (req?.kind === 'rejected') return this.deps.rejected(req.account)
    let reply = {}
    if (req?.kind === 'credential') reply = (await this.deps.credential(req)) ?? {}
    if (req?.kind === 'gh-token') {
      const token = await this.deps.ghToken(req.account)
      if (token) reply = { token }
    }
    try {
      writeWholeBeforeVisible(path.join(dir, `gitres-${id}.json`), JSON.stringify(reply))
    } catch {}
  }
}
