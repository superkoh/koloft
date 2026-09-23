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

function serviceForAppNameAtCall(kind: AccountKind): string {
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

// ADR-0001
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
  if (fixture) return readFixture(fixture)[serviceForAppNameAtCall(kind)]?.[name] ?? null
  const { code, stdout } = await execSecurity([
    'find-generic-password',
    '-s',
    serviceForAppNameAtCall(kind),
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
    const svc = serviceForAppNameAtCall(kind)
    data[svc] = { ...(data[svc] ?? {}), [name]: secret }
    try {
      fs.writeFileSync(fixture, JSON.stringify(data, null, 2), { mode: 0o600 })
      return true
    } catch {
      return false
    }
  }
  const { code } = await execSecurity([
    'add-generic-password',
    '-s',
    serviceForAppNameAtCall(kind),
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
    const svc = serviceForAppNameAtCall(kind)
    if (data[svc]) {
      delete data[svc][name]
      try {
        fs.writeFileSync(fixture, JSON.stringify(data, null, 2), { mode: 0o600 })
      } catch {}
    }
    return
  }
  await execSecurity(['delete-generic-password', '-s', serviceForAppNameAtCall(kind), '-a', name])
}

export function listAccounts(): AccountMeta[] {
  return loadSettings().accounts
}

export function findAccount(name: string, kind: AccountKind): AccountMeta | undefined {
  return listAccounts().find((a) => a.kind === kind && a.name.toLowerCase() === name.toLowerCase())
}

export type AddValidation = 'ok' | 'invalid-name' | 'duplicate'

export function validateNewAccount(name: string, kind: AccountKind): AddValidation {
  if (!ACCOUNT_NAME_RE.test(name)) return 'invalid-name'
  if (findAccount(name, kind)) return 'duplicate'
  return 'ok'
}

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

const consecutive401 = new Map<string, number>()

function keyOf(name: string, kind: AccountKind): string {
  return `${kind}:${name.toLowerCase()}`
}

export type ProbeOutcome = 'ok' | '401' | 'fail'

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
  consecutive401.delete(k)
  return acct.status
}

export function resetProbeOutcomeState(): void {
  consecutive401.clear()
}

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
