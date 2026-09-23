import { app } from 'electron'
import { execFile } from 'child_process'
import fs from 'fs'
import path from 'path'
import {
  ACCOUNT_NAME_RE,
  keychainNamespace,
  keychainService,
  type AccountKind,
  type AccountMeta,
  type AccountStatus
} from '@shared/types'
import { loadSettings, saveSettings } from './settings'

/**
 * The account registry + credential store adapter.
 *
 * Metadata lives in settings.json (`Settings.accounts`); secrets live EXCLUSIVELY in
 * the macOS Keychain under Koloft's own namespace (D1/D13 — no external tool's service
 * names, no safeStorage second store). The `security` CLI is the one read path both
 * main and the bash shim share.
 *
 * Test seam: with KOLOFT_TEST_BACKGROUND=1 AND KOLOFT_KEYCHAIN_FILE set, secrets come from
 * a `{service:{account:secret}}` JSON fixture instead. A production run ignores the
 * variable entirely (and ptyManager strips it from tab env) — a stale export in a
 * profile must never silently redirect the credential store to a plaintext file.
 */

// Keychain service names are per-build (see keychainService in @shared/types): the
// installed app, `npm run dev` and `npm run dist:beta` each get their own credential
// store, so a work-in-progress build can never overwrite or delete what the shipped
// app depends on. app.getName() is the same key userData is namespaced by, and it is
// read per call rather than cached — setName() runs in index.ts's body, i.e. AFTER
// this module is evaluated.
function serviceFor(kind: AccountKind): string {
  return keychainService(app.getName(), kind)
}

function testKeychainFile(): string | null {
  if (process.env.KOLOFT_TEST_BACKGROUND !== '1') return null
  const f = process.env.KOLOFT_KEYCHAIN_FILE
  return f && f.length ? f : null
}

type FixtureShape = Record<string, Record<string, string>>

function readFixture(file: string): FixtureShape {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as FixtureShape
  } catch {
    return {}
  }
}

function execSecurity(args: string[]): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    execFile('security', args, { timeout: 10_000 }, (err, stdout) => {
      let code = 0
      if (err) {
        const raw = (err as { code?: unknown }).code
        code = typeof raw === 'number' ? raw : 1
      }
      resolve({ code, stdout: stdout ?? '' })
    })
  })
}

export async function keychainRead(kind: AccountKind, name: string): Promise<string | null> {
  const fixture = testKeychainFile()
  if (fixture) return readFixture(fixture)[serviceFor(kind)]?.[name] ?? null
  const { code, stdout } = await execSecurity([
    'find-generic-password',
    '-s',
    serviceFor(kind),
    '-a',
    name,
    '-w'
  ])
  if (code !== 0) return null
  const secret = stdout.replace(/\n$/, '')
  return secret.length ? secret : null
}

export async function keychainWrite(
  kind: AccountKind,
  name: string,
  secret: string
): Promise<boolean> {
  const fixture = testKeychainFile()
  if (fixture) {
    const data = readFixture(fixture)
    const svc = serviceFor(kind)
    data[svc] = { ...(data[svc] ?? {}), [name]: secret }
    try {
      fs.writeFileSync(fixture, JSON.stringify(data, null, 2), { mode: 0o600 })
      return true
    } catch {
      return false
    }
  }
  // -U updates in place — safe here because add() rejects duplicate names up front,
  // so an update can only ever be a deliberate re-paste of the SAME account (D-table:
  // the expired→re-auth path overwrites its own entry)
  const { code } = await execSecurity([
    'add-generic-password',
    '-s',
    serviceFor(kind),
    '-a',
    name,
    '-w',
    secret,
    '-U'
  ])
  return code === 0
}

export async function keychainDelete(kind: AccountKind, name: string): Promise<void> {
  const fixture = testKeychainFile()
  if (fixture) {
    const data = readFixture(fixture)
    const svc = serviceFor(kind)
    if (data[svc]) {
      delete data[svc][name]
      try {
        fs.writeFileSync(fixture, JSON.stringify(data, null, 2), { mode: 0o600 })
      } catch {
        /* best effort */
      }
    }
    return
  }
  await execSecurity(['delete-generic-password', '-s', serviceFor(kind), '-a', name])
}

// ---- registry (metadata in settings.json; loadSettings sanitizes on read) --------

export function listAccounts(): AccountMeta[] {
  return loadSettings().accounts
}

export function findAccount(name: string, kind: AccountKind): AccountMeta | undefined {
  return listAccounts().find((a) => a.kind === kind && a.name.toLowerCase() === name.toLowerCase())
}

export type AddValidation = 'ok' | 'invalid-name' | 'duplicate'

/** main-side validation — the renderer's checks are advisory only */
export function validateNewAccount(name: string, kind: AccountKind): AddValidation {
  if (!ACCOUNT_NAME_RE.test(name)) return 'invalid-name'
  if (findAccount(name, kind)) return 'duplicate'
  return 'ok'
}

/** Insert or replace one account, KEEPING ITS POSITION. Order is user-visible (the
 *  settings list renders it verbatim) and probes rewrite entries constantly — an
 *  append-on-update would make rows jump under the cursor mid-probe, so a click aimed
 *  at one row's × could land on another account. New accounts append. */
export function upsertAccountMeta(meta: AccountMeta): AccountMeta[] {
  const current = listAccounts()
  const at = current.findIndex(
    (a) => a.kind === meta.kind && a.name.toLowerCase() === meta.name.toLowerCase()
  )
  const next = [...current]
  if (at >= 0) next[at] = meta
  else next.push(meta)
  return saveSettings({ accounts: next }).accounts
}

export function removeAccountMeta(name: string, kind: AccountKind): AccountMeta[] {
  const rest = listAccounts().filter(
    (a) => !(a.kind === kind && a.name.toLowerCase() === name.toLowerCase())
  )
  return saveSettings({ accounts: rest }).accounts
}

export function setAccountEnabled(
  name: string,
  kind: AccountKind,
  enabled: boolean
): AccountMeta[] {
  const acct = findAccount(name, kind)
  if (!acct) return listAccounts()
  return upsertAccountMeta({ ...acct, enabled })
}

function setStatus(name: string, kind: AccountKind, status: AccountStatus): void {
  const acct = findAccount(name, kind)
  if (acct && acct.status !== status) upsertAccountMeta({ ...acct, status })
}

// ---- status transitions (§2.2 rule 6) --------------------------------------------
// Only 401 ever mutates status, and only after TWO consecutive 401s (a lone 401 is a
// network flap); any successful probe heals. 403/429/5xx/timeouts touch nothing.

const consecutive401 = new Map<string, number>()

function keyOf(name: string, kind: AccountKind): string {
  return `${kind}:${name.toLowerCase()}`
}

export type ProbeOutcome = 'ok' | '401' | 'fail'

/** Fold one probe outcome into the account's persisted status. Returns the (possibly
 *  updated) status so callers can react to a fresh expiry (one-shot notification). */
export function recordProbeOutcome(
  name: string,
  kind: AccountKind,
  outcome: ProbeOutcome
): AccountStatus | undefined {
  const acct = findAccount(name, kind)
  if (!acct) return undefined
  const k = keyOf(name, kind)
  if (outcome === 'ok') {
    consecutive401.delete(k)
    if (acct.status !== 'ok') setStatus(name, kind, 'ok')
    return 'ok'
  }
  if (outcome === '401') {
    const n = (consecutive401.get(k) ?? 0) + 1
    consecutive401.set(k, n)
    if (n >= 2 && acct.status !== 'expired') {
      setStatus(name, kind, 'expired')
      return 'expired'
    }
    return acct.status
  }
  // plain failure: break the consecutive-401 chain, change nothing
  consecutive401.delete(k)
  return acct.status
}

/** test-only: reset the in-memory 401 chain between unit cases */
export function resetProbeOutcomeState(): void {
  consecutive401.clear()
}

/** Update the fable capability derived from a probe (display only, D10). A 'no'
 *  verdict also stamps `fableCheckedAt` — the §08 downgrade clock (①):
 *  restamped on EVERY 'no' so the weekly fable retry measures from the last verdict,
 *  not the first. */
export function recordFableCapability(
  name: string,
  kind: AccountKind,
  fable: 'yes' | 'no',
  checkedAt: number = Date.now()
): void {
  const acct = findAccount(name, kind)
  if (!acct) return
  if (fable === 'no') upsertAccountMeta({ ...acct, fable, fableCheckedAt: checkedAt })
  else if (acct.fable !== 'yes') upsertAccountMeta({ ...acct, fable })
}
