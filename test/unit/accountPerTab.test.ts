process.env.TZ = 'UTC'

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import path from 'path'

const appName = vi.hoisted(() => ({ now: 'koloft' }))

vi.mock('electron', async () => {
  const nfs = await import('node:fs')
  const nos = await import('node:os')
  const npath = await import('node:path')
  const base = nfs.mkdtempSync(npath.join(nos.tmpdir(), 'koloft-account-per-tab-'))
  return { app: { getPath: () => base, getName: () => appName.now, isPackaged: false } }
})

vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('child_process')>()),
  execFile: (cmd: string) => {
    throw new Error(`a test reached the real ${cmd}`)
  }
}))

import { app } from 'electron'
import type { AccountKind, AccountMeta, AccountView, CodexLimits } from '@shared/types'
import { AccountPicker, type PickDeps } from '../../src/main/accountPicker'
import { HomeAccountPicker } from '../../src/agents/codex/main/codexAccounts'
import { keychainDelete, keychainRead, keychainWrite } from '../../src/main/accounts'
import { meta, NOW_MS, NOW_S, usage } from './helpers/accounts'

const PINNED = './account-per-tab'
const userData = app.getPath('userData')
const keychainFile = path.join(userData, 'fake-keychain.json')
const ENV_KEYS = ['KOLOFT_TEST_BACKGROUND', 'KOLOFT_KEYCHAIN_FILE'] as const
const envBefore = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW_MS)
  fs.rmSync(keychainFile, { force: true })
  process.env.KOLOFT_TEST_BACKGROUND = '1'
  process.env.KOLOFT_KEYCHAIN_FILE = keychainFile
  appName.now = 'koloft'
})

afterEach(() => vi.useRealTimers())

afterAll(() => {
  for (const k of ENV_KEYS) {
    if (envBefore[k] === undefined) delete process.env[k]
    else process.env[k] = envBefore[k]
  }
  fs.rmSync(userData, { recursive: true, force: true })
})

const HOURS = 3600
const FIVE_HOURS = 300
const A_WEEK = 10_080

const claudeAccounts = {
  pro: meta({ name: 'made-up-pro', kind: 'oauth' }),
  max: meta({ name: 'made-up-max', kind: 'oauth' }),
  key: meta({ name: 'made-up-key', kind: 'apikey' }),
  proxy: meta({
    name: 'made-up-proxy',
    kind: 'custom',
    baseUrl: 'https://llm-proxy.example.test/v1',
    model: 'made-up-model-7b'
  })
}

const WITH_FABLE_LEFT = { hasOi: true, soi: 'allowed', uoi: 0.1 }
const room = usage({ ...WITH_FABLE_LEFT, u5: 0.1, u7: 0.2 })
const busier = usage({ ...WITH_FABLE_LEFT, u5: 0.3, u7: 0.6 })
const atItsLimit = usage({
  ...WITH_FABLE_LEFT,
  u5: 1,
  s5: 'rejected',
  r5: NOW_S + 2 * HOURS,
  u7: 0.5
})
const noFableLeft = usage({ hasOi: true, soi: 'rejected', uoi: 1, u5: 0.1, u7: 0.2 })

function claudePicker(accounts: AccountMeta[], usageOf: Record<string, typeof room>) {
  const deps: PickDeps = {
    listAccounts: () => accounts,
    fablePriority: () => false,
    readSecret: (kind, name) => keychainRead(kind, name),
    probe: async () => ({ ok: false, error: 'network' }),
    onProbeOutcome: () => {},
    launchedSessions: () => [],
    recordPick: () => {},
    now: () => NOW_MS
  }
  const picker = new AccountPicker(deps)
  for (const a of accounts) if (usageOf[a.name]) picker.cacheUsage(a.kind, a.name, usageOf[a.name])
  return picker
}

const homeLimits = (fiveHours: number, week: number): CodexLimits => ({
  windows: [
    { minutes: FIVE_HOURS, used: fiveHours, resetsAt: NOW_S + 2 * HOURS },
    { minutes: A_WEEK, used: week, resetsAt: NOW_S + 72 * HOURS }
  ],
  at: NOW_MS
})

const homeAccount = (name: string, kind: AccountKind, p: Partial<AccountView>): AccountView => ({
  ...meta({ name, kind }),
  ...p
})

function homeAccounts(kind: AccountKind) {
  return {
    first: homeAccount('made-up-first', kind, { limits: homeLimits(0.1, 0.6) }),
    second: homeAccount('made-up-second', kind, { limits: homeLimits(0.1, 0.2) }),
    firstFull: homeAccount('made-up-first', kind, { limits: homeLimits(1, 0.6) }),
    secondFull: homeAccount('made-up-second', kind, { limits: homeLimits(1, 0.9) }),
    key: homeAccount('made-up-key', kind, { apiKey: true })
  }
}

const OTHER_AGENTS_KINDS = {
  claude: ['codex-home', 'agy-home'],
  codex: ['oauth', 'apikey', 'custom', 'agy-home'],
  agy: ['oauth', 'apikey', 'custom', 'codex-home']
} as const

function line(situation: string, got: string): string {
  return `${situation.padEnd(70)} → ${got}`
}

async function claudeRows(): Promise<string[]> {
  const { pro, max, key, proxy } = claudeAccounts
  const pick = async (
    accounts: AccountMeta[],
    usageOf: Record<string, typeof room>,
    resumedOn?: string
  ): Promise<string> => {
    const r = await claudePicker(accounts, usageOf).pick('pty-t1', resumedOn)
    if (r.account === null) return `none (${r.reason})`
    return `${r.account} [${r.kind}] banner "${r.banner}"${r.warning ? ` warning "${r.warning}"` : ''}`
  }
  const both = { [pro.name]: busier, [max.name]: room }
  return [
    line('a new session, two subscriptions and a key', await pick([pro, max, key], both)),
    line(
      'resuming a session that ran on the busier subscription',
      await pick([pro, max, key], both, pro.name)
    ),
    line(
      'resuming a session whose subscription is at its limit',
      await pick([pro, max, key], { [pro.name]: atItsLimit, [max.name]: room }, pro.name)
    ),
    line(
      'every subscription at its limit, a key account there',
      await pick([pro, max, key], { [pro.name]: atItsLimit, [max.name]: atItsLimit })
    ),
    line(
      'every subscription at its limit, a custom endpoint there',
      await pick([pro, max, proxy], { [pro.name]: atItsLimit, [max.name]: atItsLimit })
    ),
    line(
      'every subscription at its limit, nothing else',
      await pick([pro, max], { [pro.name]: atItsLimit, [max.name]: atItsLimit })
    ),
    line(
      'the only subscription has no fable allowance left',
      await pick([max], { [max.name]: noFableLeft })
    ),
    line('only a key account', await pick([key], {})),
    line('only a custom endpoint', await pick([proxy], {})),
    line(
      'the only subscription disabled, the other expired',
      await pick(
        [
          { ...pro, enabled: false },
          { ...max, status: 'expired' }
        ],
        both
      )
    ),
    line('no account at all', await pick([], {})),
    line(
      `only other agents' kinds (${OTHER_AGENTS_KINDS.claude.join(', ')})`,
      await pick(
        OTHER_AGENTS_KINDS.claude.map((kind) => meta({ name: `made-up-${kind}`, kind })),
        {}
      )
    )
  ]
}

function homeRows(kind: 'codex-home' | 'agy-home', agent: 'codex' | 'agy'): string[] {
  const a = homeAccounts(kind)
  const pick = (accounts: AccountView[], resumedOn?: string): string =>
    new HomeAccountPicker(kind).pick(accounts, resumedOn)?.name ?? 'none'
  const twoEqual = [
    homeAccount('made-up-left', kind, { limits: homeLimits(0.1, 0.3) }),
    homeAccount('made-up-right', kind, { limits: homeLimits(0.1, 0.3) })
  ]
  const asking = new HomeAccountPicker(kind)
  const askedTwice = [asking.peek(twoEqual)?.name, asking.peek(twoEqual)?.name]
  const startedTwice = [asking.pick(twoEqual)?.name, asking.pick(twoEqual)?.name]
  return [
    line('a new session, two subscriptions and a key', pick([a.first, a.second, a.key])),
    line(
      'resuming a session that ran on the busier subscription',
      pick([a.first, a.second, a.key], a.first.name)
    ),
    line(
      'resuming a session whose subscription is at its limit',
      pick([a.firstFull, a.second, a.key], a.first.name)
    ),
    line(
      'every subscription at its limit, a key account there',
      pick([a.firstFull, a.secondFull, a.key])
    ),
    line(
      'every subscription at its limit, nothing else (the first back)',
      pick([a.firstFull, a.secondFull])
    ),
    line('only a key account', pick([a.key])),
    line(
      'the only subscription disabled, the other expired',
      pick([
        { ...a.first, enabled: false },
        { ...a.second, status: 'expired' }
      ])
    ),
    line('no account at all', pick([])),
    line(
      `only other agents' kinds (${OTHER_AGENTS_KINDS[agent].join(', ')})`,
      pick(OTHER_AGENTS_KINDS[agent].map((k) => homeAccount(`made-up-${k}`, k, {})))
    ),
    line(
      'only asking twice, then two starts, two accounts with equal room',
      `asked ${askedTwice.join(', ')}; started ${startedTwice.join(', ')}`
    )
  ]
}

describe('which account each start gets, for every kind of account and each situation — pinned so that moving the pickers into the agents changes no row', () => {
  it('Claude Code (oauth, apikey, custom), on this Mac and over SSH alike', async () => {
    await expect(['=== Claude Code ===', ...(await claudeRows())].join('\n')).toMatchFileSnapshot(
      `${PINNED}/which-account-claude.txt`
    )
  })

  it('Codex (codex-home), on this Mac and over SSH alike', async () => {
    await expect(
      ['=== Codex ===', ...homeRows('codex-home', 'codex')].join('\n')
    ).toMatchFileSnapshot(`${PINNED}/which-account-codex.txt`)
  })

  it('Antigravity (agy-home), on this Mac and over SSH alike', async () => {
    await expect(
      ['=== Antigravity ===', ...homeRows('agy-home', 'agy')].join('\n')
    ).toMatchFileSnapshot(`${PINNED}/which-account-agy.txt`)
  })
})

const EVERY_KIND_KOLOFT_KEEPS_IN_THE_KEYCHAIN: AccountKind[] = [
  'oauth',
  'apikey',
  'custom',
  'agy-home'
]
const BUILDS = ['koloft', 'koloft-dev']

describe('the name of the Keychain entry each kind of account is kept under, as written, read and deleted — pinned only through the test keychain file', () => {
  it('for an installed Koloft and for a development build', async () => {
    const steps: string[] = []
    const keychain = (): string =>
      fs.existsSync(keychainFile) ? fs.readFileSync(keychainFile, 'utf8') : '(no file)'
    for (const build of BUILDS) {
      appName.now = build
      fs.rmSync(keychainFile, { force: true })
      for (const kind of EVERY_KIND_KOLOFT_KEEPS_IN_THE_KEYCHAIN) {
        const name = `made-up-${kind}`
        const secret = `made-up-secret-of-${kind}`
        await keychainWrite(kind, name, secret)
        const read = await keychainRead(kind, name)
        steps.push(`${build} · ${kind}: written, read back ${read === secret ? 'the same' : read}`)
      }
      steps.push(`=== ${build}: the keychain after writing one of each ===`, keychain())
      for (const kind of EVERY_KIND_KOLOFT_KEEPS_IN_THE_KEYCHAIN)
        await keychainDelete(kind, `made-up-${kind}`)
      steps.push(`=== ${build}: the keychain after deleting each ===`, keychain())
    }
    await expect(steps.join('\n')).toMatchFileSnapshot(`${PINNED}/keychain-entry-names.txt`)
  })
})
