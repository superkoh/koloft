import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import fs from 'fs'
import path from 'path'

/** U3 — registry persistence, name validation (an injection surface), the Keychain
 *  adapter seams, and the 401 double-confirm / heal state machine (tests.md §2.2). */

vi.mock('electron', async () => {
  const nfs = await import('node:fs')
  const nos = await import('node:os')
  const npath = await import('node:path')
  const base = nfs.mkdtempSync(npath.join(nos.tmpdir(), 'koloft-accounts-'))
  // getName() drives the Keychain namespace; 'koloft' = a production build, so the
  // fixture keys below are the production service names
  return { app: { getPath: () => base, getName: () => 'koloft', isPackaged: false } }
})

import { app } from 'electron'
import { loadSettings, saveSettings } from '../../src/main/settings'
import {
  keychainRead,
  keychainWrite,
  keychainDelete,
  listAccounts,
  upsertAccountMeta,
  removeAccountMeta,
  setAccountEnabled,
  validateNewAccount,
  recordProbeOutcome,
  recordFableCapability,
  resetProbeOutcomeState
} from '../../src/main/accounts'
import { keychainNamespace, keychainService, type AccountMeta } from '../../src/shared/types'

const userData = app.getPath('userData')
const settingsFile = path.join(userData, 'settings.json')
const fixtureFile = path.join(userData, 'keychain-fixture.json')

const ENV_KEYS = ['KOLOFT_TEST_BACKGROUND', 'KOLOFT_KEYCHAIN_FILE'] as const
const savedEnv: Record<string, string | undefined> = {}
for (const k of ENV_KEYS) savedEnv[k] = process.env[k]

function meta(p: Partial<AccountMeta>): AccountMeta {
  return {
    name: 'acct',
    kind: 'oauth',
    enabled: true,
    fable: 'unknown',
    status: 'ok',
    addedAt: 1,
    ...p
  }
}

beforeEach(() => {
  fs.rmSync(settingsFile, { force: true })
  fs.rmSync(`${settingsFile}.tmp`, { force: true })
  fs.rmSync(fixtureFile, { force: true })
  resetProbeOutcomeState()
  process.env.KOLOFT_TEST_BACKGROUND = '1'
  process.env.KOLOFT_KEYCHAIN_FILE = fixtureFile
})

afterAll(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  fs.rmSync(userData, { recursive: true, force: true })
})

describe('U3 · registry persistence', () => {
  it('add / toggle / remove merge into settings.json and survive a reload', () => {
    upsertAccountMeta(meta({ name: 'bravo' }))
    upsertAccountMeta(meta({ name: 'alpha' }))
    expect(
      loadSettings()
        .accounts.map((a) => a.name)
        .sort()
    ).toEqual(['alpha', 'bravo'])

    setAccountEnabled('bravo', 'oauth', false)
    expect(listAccounts().find((a) => a.name === 'bravo')?.enabled).toBe(false)

    removeAccountMeta('alpha', 'oauth')
    expect(listAccounts().map((a) => a.name)).toEqual(['bravo'])
  })

  // regression: probes rewrite entries constantly (status / fable / heal), and the
  // settings list renders this array verbatim. An append-on-update reorders the rows
  // under the user's cursor mid-probe — a click aimed at one row's × can land on a
  // different account by the time it registers.
  it('updating an account keeps its POSITION; only new ones append', () => {
    for (const n of ['alpha', 'bravo', 'charlie']) upsertAccountMeta(meta({ name: n }))
    upsertAccountMeta(meta({ name: 'bravo', status: 'expired' }))
    upsertAccountMeta(meta({ name: 'alpha', fable: 'yes' }))
    expect(listAccounts().map((a) => a.name)).toEqual(['alpha', 'bravo', 'charlie'])
    upsertAccountMeta(meta({ name: 'api', kind: 'apikey' }))
    expect(listAccounts().map((a) => a.name)).toEqual(['alpha', 'bravo', 'charlie', 'api'])
  })

  // a custom endpoint's baseUrl and model land in shell exports inside the shim, so
  // they get the same "never trust the disk" treatment as account names
  it('custom entries survive only with a valid http(s) URL and a safe model id', () => {
    saveSettings({})
    const raw = JSON.parse(fs.readFileSync(settingsFile, 'utf8'))
    const base = { kind: 'custom', enabled: true, fable: 'unknown', status: 'ok', addedAt: 1 }
    raw.accounts = [
      { ...base, name: 'good', baseUrl: 'https://ok.test/api', model: 'glm-5.2[1m]' },
      { ...base, name: 'nourl' }, // unusable: would inject an empty ANTHROPIC_BASE_URL
      { ...base, name: 'badscheme', baseUrl: 'file:///etc/passwd' },
      { ...base, name: 'quoted', baseUrl: 'https://x.test/"; rm -rf $HOME; #' },
      { ...base, name: 'badmodel', baseUrl: 'https://ok.test', model: 'a"; touch /tmp/pwned; #' }
    ]
    fs.writeFileSync(settingsFile, JSON.stringify(raw))
    const kept = loadSettings().accounts
    expect(kept.map((a) => a.name)).toEqual(['good', 'badmodel'])
    expect(kept[0].model).toBe('glm-5.2[1m]') // real-world model ids keep their suffix
    expect(kept[1].model).toBeUndefined() // hostile model dropped, account still usable
  })

  it('saveSettings writes atomically: no .tmp remains, content is complete JSON', () => {
    upsertAccountMeta(meta({ name: 'bravo' }))
    expect(fs.existsSync(`${settingsFile}.tmp`)).toBe(false)
    const parsed = JSON.parse(fs.readFileSync(settingsFile, 'utf8'))
    expect(parsed.accounts).toHaveLength(1)
  })

  it('LEAK ASSERTION: settings.json never contains sk-ant bytes', async () => {
    await keychainWrite('oauth', 'bravo', 'sk-ant-oat01-SUPER-SECRET')
    upsertAccountMeta(meta({ name: 'bravo' }))
    expect(fs.readFileSync(settingsFile, 'utf8')).not.toContain('sk-ant')
  })

  it('hostile entries on disk are dropped on load (names reach a shell)', () => {
    saveSettings({}) // create a valid file first
    const raw = JSON.parse(fs.readFileSync(settingsFile, 'utf8'))
    raw.accounts = [
      { name: 'ok-name', kind: 'oauth', enabled: true, fable: 'unknown', status: 'ok', addedAt: 1 },
      { name: 'bad;rm -rf $HOME', kind: 'oauth', enabled: true },
      { name: 'ok-name', kind: 'oauth', enabled: true }, // duplicate
      { name: 'x'.repeat(64), kind: 'oauth', enabled: true }, // too long
      { name: 'other', kind: 'not-a-kind', enabled: true } // bad kind
    ]
    fs.writeFileSync(settingsFile, JSON.stringify(raw))
    expect(loadSettings().accounts.map((a) => a.name)).toEqual(['ok-name'])
  })
})

describe('U3 · name validation (main-side)', () => {
  it.each(['a b', 'a"b', 'a$b', 'a`b`', 'a[31m', '', '.dot-start', 'x'.repeat(33)])(
    'rejects %j',
    (bad) => {
      expect(validateNewAccount(bad as string, 'oauth')).toBe('invalid-name')
    }
  )

  it('rejects duplicates case-insensitively within a kind, allows across kinds', () => {
    upsertAccountMeta(meta({ name: 'Bravo' }))
    expect(validateNewAccount('bravo', 'oauth')).toBe('duplicate')
    expect(validateNewAccount('bravo', 'apikey')).toBe('ok')
  })
})

describe('U3 · per-build keychain namespace', () => {
  // the production namespace is load-bearing for MIGRATION: these three strings are
  // byte-identical to the pre-namespacing constants, so a shipped install keeps its
  // credentials. Changing them silently orphans every real user's accounts.
  it('a production build keeps the historical service names', () => {
    expect(keychainService('koloft', 'oauth')).toBe('koloft-claude-oauth')
    expect(keychainService('koloft', 'apikey')).toBe('koloft-anthropic-api')
    expect(keychainService('koloft', 'custom')).toBe('koloft-custom-endpoint')
  })

  it('dev and beta builds get stores of their own', () => {
    expect(keychainService('koloft-dev', 'oauth')).toBe('koloft-dev-claude-oauth')
    expect(keychainService('koloft-beta', 'oauth')).toBe('koloft-beta-claude-oauth')
    expect(keychainService('koloft-dev', 'oauth')).not.toBe(keychainService('koloft', 'oauth'))
  })

  // a rename of package.json "name" moves userData (recoverable — settings only), but
  // must NOT move the credential store: those items would become invisible orphans
  // holding live tokens. Anything unrecognised falls back to production.
  it.each(['koloft', 'Koloft', 'koloft2', '', 'something-else', 'koloft-'])(
    'unrecognised app name %j falls back to the production namespace',
    (n) => {
      expect(keychainNamespace(n as string)).toBe('koloft')
    }
  )

  it("never yields a name that could break out of the shim's bash assignment", () => {
    for (const n of ['koloft-dev', 'koloft-beta', 'koloft', 'koloft-a"; rm -rf $HOME; #']) {
      expect(keychainNamespace(n)).toMatch(/^[a-z0-9-]+$/)
    }
  })
})

describe('U3 · keychain adapter seams', () => {
  it('fixture roundtrip: write → read → delete, file mode 0600', async () => {
    expect(await keychainWrite('oauth', 'bravo', 'tok-1')).toBe(true)
    expect(await keychainRead('oauth', 'bravo')).toBe('tok-1')
    // kinds are separate services
    expect(await keychainRead('apikey', 'bravo')).toBeNull()
    const mode = fs.statSync(fixtureFile).mode & 0o777
    expect(mode).toBe(0o600)
    await keychainDelete('oauth', 'bravo')
    expect(await keychainRead('oauth', 'bravo')).toBeNull()
  })

  it('outside test mode the fixture is IGNORED (production refuses the plaintext seam)', async () => {
    fs.writeFileSync(fixtureFile, JSON.stringify({ 'koloft-claude-oauth': { bravo: 'tok-x' } }))
    delete process.env.KOLOFT_TEST_BACKGROUND
    // falls through to the real `security` CLI, where this entry does not exist
    expect(await keychainRead('oauth', 'bravo')).toBeNull()
  })
})

describe('U3 · 401 double-confirm / heal (only 401 ever mutates status)', () => {
  beforeEach(() => {
    upsertAccountMeta(meta({ name: 'bravo' }))
  })

  it('a lone 401 is a flap: status unchanged', () => {
    expect(recordProbeOutcome('bravo', 'oauth', '401')).toBe('ok')
    expect(listAccounts()[0].status).toBe('ok')
  })

  it('two consecutive 401s → expired; a later success heals back to ok', () => {
    recordProbeOutcome('bravo', 'oauth', '401')
    expect(recordProbeOutcome('bravo', 'oauth', '401')).toBe('expired')
    expect(listAccounts()[0].status).toBe('expired')
    expect(recordProbeOutcome('bravo', 'oauth', 'ok')).toBe('ok')
    expect(listAccounts()[0].status).toBe('ok')
  })

  it('a plain failure BREAKS the 401 chain (401, fail, 401 ≠ expired)', () => {
    recordProbeOutcome('bravo', 'oauth', '401')
    recordProbeOutcome('bravo', 'oauth', 'fail')
    recordProbeOutcome('bravo', 'oauth', '401')
    expect(listAccounts()[0].status).toBe('ok')
  })

  it('plain failures never mutate status, and enabled stays untouched throughout', () => {
    setAccountEnabled('bravo', 'oauth', true)
    recordProbeOutcome('bravo', 'oauth', 'fail')
    recordProbeOutcome('bravo', 'oauth', '401')
    recordProbeOutcome('bravo', 'oauth', '401')
    const a = listAccounts()[0]
    expect(a.status).toBe('expired')
    expect(a.enabled).toBe(true) // user intent and availability are separate axes
  })
})

// ① (closed defensively): while an account is known no-fable, routine
// probes must stop firing the fable model — the downgrade clock lives on the meta.
describe('U3 · fable capability + §08 downgrade clock', () => {
  it("a 'no' verdict stamps fableCheckedAt", () => {
    upsertAccountMeta(meta({ name: 'acct' }))
    recordFableCapability('acct', 'oauth', 'no', 555)
    const a = listAccounts()[0]
    expect(a.fable).toBe('no')
    expect(a.fableCheckedAt).toBe(555)
  })

  it("a repeat 'no' RESTAMPS — the weekly retry measures from the LAST verdict", () => {
    upsertAccountMeta(meta({ name: 'acct', fable: 'no', fableCheckedAt: 555 }))
    recordFableCapability('acct', 'oauth', 'no', 999)
    expect(listAccounts()[0].fableCheckedAt).toBe(999)
  })

  it("a 'yes' verdict flips the badge back", () => {
    upsertAccountMeta(meta({ name: 'acct', fable: 'no', fableCheckedAt: 555 }))
    recordFableCapability('acct', 'oauth', 'yes', 999)
    expect(listAccounts()[0].fable).toBe('yes')
  })

  it('fableCheckedAt survives the settings sanitizer; non-numeric garbage is dropped', () => {
    saveSettings({})
    const raw = JSON.parse(fs.readFileSync(settingsFile, 'utf8'))
    const base = { kind: 'oauth', enabled: true, fable: 'no', status: 'ok', addedAt: 1 }
    raw.accounts = [
      { ...base, name: 'good', fableCheckedAt: 123 },
      { ...base, name: 'evil', fableCheckedAt: 'DROP TABLE' }
    ]
    fs.writeFileSync(settingsFile, JSON.stringify(raw))
    const accs = loadSettings().accounts
    expect(accs.find((a) => a.name === 'good')?.fableCheckedAt).toBe(123)
    expect(accs.find((a) => a.name === 'evil')?.fableCheckedAt).toBeUndefined()
  })
})

describe('U4 · accounts:add IPC wiring', () => {
  // main's handler takes a 4th `endpoint` argument (baseUrl + model for a custom
  // endpoint) and the renderer passes it — the preload in between is the only hop that
  // can drop it, and a drop is silent: the account saves, just with no endpoint.
  it('the preload forwards the endpoint argument to main', () => {
    const root = path.resolve(__dirname, '../..')
    const preload = fs.readFileSync(path.join(root, 'src/preload/index.ts'), 'utf8')
    const call = preload.match(
      /add:\s*\(([^)]*)\)\s*=>\s*ipcRenderer\.invoke\('accounts:add',([^)]*)\)/
    )
    expect(call, 'accounts.add is not a direct ipcRenderer.invoke').not.toBeNull()
    const params = call![1].split(',').map((s) => s.trim())
    const forwarded = call![2].split(',').map((s) => s.trim())
    expect(params).toEqual(['name', 'kind', 'secret', 'endpoint'])
    expect(forwarded).toEqual(params)
  })
})
