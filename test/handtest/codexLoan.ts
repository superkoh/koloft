import fs from 'fs'
import path from 'path'
import { codexHomeOf } from '../../src/main/codexAccounts'

// CODEX§15
const CODEX_REFRESHES_THIS_CLOSE_TO_EXPIRY_MS = 5 * 60_000
const LONGEST_SANDBOX_RUN_MS = 24 * 3_600_000

export interface InstalledAccount {
  name: string
  kind: string
  enabled: boolean
}

export type CodexLoan = { name: string; auth: string } | { notLent: string }

function accessTokenExpiry(auth: string): number | undefined {
  const token = (JSON.parse(auth) as { tokens?: { access_token?: unknown } }).tokens?.access_token
  if (typeof token !== 'string') return undefined
  const { exp } = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString()) as {
    exp?: unknown
  }
  return typeof exp === 'number' ? exp * 1000 : undefined
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
      return { name: l.name, auth, expiry: accessTokenExpiry(auth) }
    })
    .sort((a, b) => (b.expiry ?? 0) - (a.expiry ?? 0))
  const [freshest] = logins
  if (!freshest) return { notLent: 'the installed Koloft has no enabled Codex account signed in' }
  if (freshest.expiry === undefined)
    return { notLent: `the login of "${freshest.name}" has no access-token expiry to check` }
  const lentUntil = now + LONGEST_SANDBOX_RUN_MS + CODEX_REFRESHES_THIS_CLOSE_TO_EXPIRY_MS
  if (freshest.expiry <= lentUntil)
    return {
      notLent:
        `the login of "${freshest.name}" expires ${new Date(freshest.expiry).toISOString()}, ` +
        `less than ${LONGEST_SANDBOX_RUN_MS / 3_600_000} h away, so Codex in the sandbox could ` +
        `refresh it and sign the installed Koloft out of it; it is lent again once the ` +
        `installed Koloft has refreshed it`
    }
  return { name: freshest.name, auth: freshest.auth }
}
