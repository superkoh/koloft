import fs from 'fs'
import type { GhAccount } from '@shared/types'
import type { Gh } from './prChecks'

// PLATFORM§43
export function parseGhAccounts(stdout: string): GhAccount[] {
  try {
    const entries = JSON.parse(stdout)?.hosts?.['github.com']
    if (!Array.isArray(entries)) return []
    return entries
      .filter(
        (e) =>
          e &&
          typeof e.login === 'string' &&
          e.login &&
          !String(e.tokenSource ?? '').endsWith('_TOKEN')
      )
      .map((e) => ({ login: e.login, active: e.active === true, ok: e.state === 'success' }))
  } catch {
    return []
  }
}

export function workspaceOfCwd(cwd: string, workspaces: string[]): string | undefined {
  let best: string | undefined
  for (const ws of workspaces)
    if ((cwd === ws || cwd.startsWith(ws + '/')) && (!best || ws.length > best.length)) best = ws
  return best
}

// PLATFORM§43
async function storedToken(gh: Gh, login: string | null): Promise<string | null> {
  const r = await gh(['auth', 'token', '-h', 'github.com', ...(login ? ['-u', login] : [])])
  return r.code === 0 ? r.stdout.trim() || null : null
}

export class GithubAccountPicks {
  private picks: Record<string, string>
  private tokens = new Map<string, string>()

  constructor(
    private file: string,
    private gh: Gh
  ) {
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
      this.picks = saved && typeof saved === 'object' ? saved : {}
    } catch {
      this.picks = {}
    }
  }

  picked(ws: string): string | undefined {
    return this.picks[ws]
  }

  token(ws: string): string | undefined {
    return this.tokens.get(ws)
  }

  async pick(ws: string, login: string | null): Promise<void> {
    if (login) this.picks[ws] = login
    else delete this.picks[ws]
    fs.writeFileSync(this.file, JSON.stringify(this.picks, null, 2))
    await this.refresh()
  }

  async refresh(): Promise<void> {
    const next = new Map<string, string>()
    let current: string | null | undefined
    for (const [ws, login] of Object.entries(this.picks)) {
      const token =
        (await storedToken(this.gh, login)) ??
        (current === undefined ? (current = await storedToken(this.gh, null)) : current)
      if (token) next.set(ws, token)
    }
    this.tokens = next
  }
}
