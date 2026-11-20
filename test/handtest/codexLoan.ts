import fs from 'fs'
import path from 'path'
import { codexHomeOf } from '../../src/main/codexAccounts'

// CODEX§15
const CODEX_REFRESHES_THIS_CLOSE_TO_EXPIRY_MS = 5 * 60_000
export const LONGEST_SANDBOX_RUN_MS = 24 * 3_600_000

export interface InstalledAccount {
  name: string
  kind: string
  enabled: boolean
}

export type CodexLoan = { name: string; auth: string; safeUntil?: number } | { notLent: string }

type Refresh = { never: true } | { at: number } | { unknown: true }

function whenCodexRefreshes(auth: string): Refresh {
  try {
    const { tokens } = JSON.parse(auth) as { tokens?: { access_token?: unknown } }
    if (!tokens) return { never: true }
    const token = String(tokens.access_token)
    const { exp } = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString()) as {
      exp?: unknown
    }
    return typeof exp === 'number'
      ? { at: exp * 1000 - CODEX_REFRESHES_THIS_CLOSE_TO_EXPIRY_MS }
      : { unknown: true }
  } catch {
    return { unknown: true }
  }
}

export function codexLoan(
  profile: string,
  accounts: readonly InstalledAccount[],
  now: number
): CodexLoan {
  const logins = accounts
    .filter((a) => a.kind === 'codex-home' && a.enabled)
    .map((a) => ({ name: a.name, file: path.join(codexHomeOf(profile, a.name), 'auth.json') }))
    .filter((l) => fs.existsSync(l.file))
    .map((l) => {
      const auth = fs.readFileSync(l.file, 'utf8')
      return { name: l.name, auth, refresh: whenCodexRefreshes(auth) }
    })
  if (logins.length === 0)
    return { notLent: 'the installed Koloft has no enabled Codex account signed in' }
  const apiKey = logins.find((l) => 'never' in l.refresh)
  if (apiKey) return { name: apiKey.name, auth: apiKey.auth }
  const freshest = logins
    .flatMap((l) => ('at' in l.refresh ? [{ ...l, at: l.refresh.at }] : []))
    .sort((a, b) => b.at - a.at)[0]
  if (!freshest)
    return { notLent: `no enabled Codex login has an access-token expiry that can be read` }
  if (freshest.at <= now + LONGEST_SANDBOX_RUN_MS)
    return {
      notLent:
        `Codex refreshes the freshest enabled login, "${freshest.name}", at ` +
        `${new Date(freshest.at).toISOString()}, within ${LONGEST_SANDBOX_RUN_MS / 3_600_000} h, ` +
        `and a refresh in the sandbox would sign the installed Koloft out of it; it is lent ` +
        `again once the installed Koloft has refreshed it`
    }
  return { name: freshest.name, auth: freshest.auth, safeUntil: freshest.at }
}
