import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  agySignedIn,
  agyTokenFile,
  agyTrustsFolder,
  agyQuotaFrom,
  mergeAgyHooks,
  mergeAgySettings,
  oneShotAgyHome,
  prepareAgyHome,
  setAgyApiKeyRoute,
  trustAgyFolder
} from '../../src/main/agyAccounts'

let root: string
let home: string
let owners: string

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agy-accounts-')))
  home = path.join(root, 'agy-homes', 'work')
  owners = path.join(root, '.gemini')
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

const settingsOf = (dir: string): string => path.join(dir, 'antigravity-cli', 'settings.json')
const hooksOf = (dir: string): string => path.join(dir, 'config', 'hooks.json')
const readJson = (file: string): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(file, 'utf8'))
function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value))
}

const SHARED_FOLDERS = [
  'antigravity-cli/conversations',
  'antigravity-cli/brain',
  'antigravity-cli/annotations',
  'antigravity-cli/presence',
  'config/projects',
  'config/rules',
  'config/plugins',
  'antigravity'
]

describe("prepareAgyHome (an account's folder shares the owner's conversations, AGY§4)", () => {
  it("links every shared folder into the owner's ~/.gemini and makes the target folders first, so agy never meets a link to nothing", () => {
    prepareAgyHome(home, owners)
    for (const folder of SHARED_FOLDERS) {
      const own = path.join(home, folder)
      expect(fs.readlinkSync(own), folder).toBe(path.join(owners, folder))
      expect(fs.statSync(own).isDirectory(), folder).toBe(true)
    }
    expect(fs.readlinkSync(path.join(home, 'antigravity-cli', 'conversation_summaries.db'))).toBe(
      path.join(owners, 'antigravity-cli', 'conversation_summaries.db')
    )
    expect(fs.readlinkSync(path.join(home, 'config', 'mcp_config.json'))).toBe(
      path.join(owners, 'config', 'mcp_config.json')
    )
  })

  it('replaces a link that points somewhere else and leaves a right one as it is', () => {
    prepareAgyHome(home, owners)
    const brain = path.join(home, 'antigravity-cli', 'brain')
    fs.unlinkSync(brain)
    fs.mkdirSync(path.join(root, 'elsewhere'))
    fs.symlinkSync(path.join(root, 'elsewhere'), brain)
    const conversations = path.join(home, 'antigravity-cli', 'conversations')
    const before = fs.lstatSync(conversations).ino
    prepareAgyHome(home, owners)
    expect(fs.readlinkSync(brain)).toBe(path.join(owners, 'antigravity-cli', 'brain'))
    expect(fs.lstatSync(conversations).ino).toBe(before)
  })
})

describe("mergeAgySettings (agy's settings.json in an account's folder, AGY§4 AGY§5 AGY§11)", () => {
  const koloft = {
    trust: ['/w/new'],
    titleCommand: '/bin/sh "/k/koloft-agy-title"',
    apiKey: false
  }

  it("starts from the owner's own settings and puts Koloft's title script, status line and trusted folders on top", () => {
    writeJson(settingsOf(owners), {
      colorScheme: 'dark',
      title: { type: 'command', command: '/owner/title' },
      statusLine: { type: 'command', command: '/owner/status' },
      modelProvider: 'gemini',
      trustedWorkspaces: ['/w/owner']
    })
    writeJson(settingsOf(home), { colorScheme: 'light', trustedWorkspaces: ['/w/own'] })
    mergeAgySettings(home, owners, { ...koloft, statusLine: '/k/status' })
    expect(readJson(settingsOf(home))).toEqual({
      colorScheme: 'dark',
      title: { type: 'command', command: '/bin/sh "/k/koloft-agy-title"' },
      statusLine: { type: 'command', command: '/k/status', stack_with_default: true },
      trustedWorkspaces: ['/w/own', '/w/owner', '/w/new']
    })
  })

  it("keeps the owner's status line when Koloft has none, and routes to the API key only when the account has one", () => {
    writeJson(settingsOf(owners), { statusLine: { type: 'command', command: '/owner/status' } })
    mergeAgySettings(home, owners, { ...koloft, apiKey: true })
    expect(readJson(settingsOf(home))).toMatchObject({
      statusLine: { type: 'command', command: '/owner/status' },
      modelProvider: 'gemini'
    })
  })

  it("writes agy's own form (keys sorted, two-space indent, owner-only), so agy does not rewrite the file", () => {
    writeJson(settingsOf(owners), { zeta: 1, alpha: { b: 1, a: 2 } })
    mergeAgySettings(home, owners, koloft)
    const text = fs.readFileSync(settingsOf(home), 'utf8')
    const value = JSON.parse(text)
    expect(Object.keys(value)).toEqual([...Object.keys(value)].sort())
    expect(Object.keys(value.alpha)).toEqual(['a', 'b'])
    expect(text).toBe(`${JSON.stringify(value, null, 2)}\n`)
    expect(fs.statSync(settingsOf(home)).mode & 0o777).toBe(0o600)
  })

  it('leaves the file untouched when nothing changed', () => {
    mergeAgySettings(home, owners, koloft)
    const past = new Date(Date.now() - 60_000)
    fs.utimesSync(settingsOf(home), past, past)
    const before = fs.statSync(settingsOf(home)).mtimeMs
    mergeAgySettings(home, owners, koloft)
    expect(fs.statSync(settingsOf(home)).mtimeMs).toBe(before)
  })
})

describe("mergeAgyHooks (agy's hooks.json, AGY§12)", () => {
  it("keeps the owner's own named hooks and replaces any old koloft entry with Koloft's", () => {
    writeJson(hooksOf(owners), {
      mine: { Stop: [{ command: '/owner/stop' }] },
      koloft: { Stop: [{ command: '/stale' }] }
    })
    mergeAgyHooks(home, owners, { Stop: [{ type: 'command', command: '/k/hook Stop' }] })
    expect(readJson(hooksOf(home))).toEqual({
      koloft: { Stop: [{ command: '/k/hook Stop', type: 'command' }] },
      mine: { Stop: [{ command: '/owner/stop' }] }
    })
  })
})

describe('agySignedIn (AGY§5 AGY§6)', () => {
  const onboarded = (value: Record<string, boolean>): void =>
    writeJson(path.join(home, 'antigravity-cli', 'cache', 'onboarding.json'), value)

  it('needs the onboarding done and either a Google token in the folder or an API key', () => {
    expect(agySignedIn(home, true)).toBe(false)
    onboarded({ consumerOnboardingComplete: true, onboardingComplete: false })
    expect(agySignedIn(home, true)).toBe(true)
    expect(agySignedIn(home, false)).toBe(false)
    fs.writeFileSync(agyTokenFile(home), '{}')
    expect(agySignedIn(home, false)).toBe(true)
    onboarded({ onboardingComplete: false, consumerOnboardingComplete: false })
    expect(agySignedIn(home, false)).toBe(false)
  })
})

describe('oneShotAgyHome (a throwaway folder for one agy -p run, AGY§6 AGY§20)', () => {
  const tmpRoot = (): string => path.join(root, 'tmp')

  it("signs the run in with a copy of the account's token, carries a refreshed token back, and removes the folder", async () => {
    fs.mkdirSync(path.dirname(agyTokenFile(home)), { recursive: true })
    fs.writeFileSync(agyTokenFile(home), 'old token', { mode: 0o600 })
    const shot = oneShotAgyHome(home, tmpRoot(), false)
    expect(fs.readFileSync(agyTokenFile(shot.dir), 'utf8')).toBe('old token')
    fs.writeFileSync(agyTokenFile(shot.dir), 'refreshed token')
    shot.done()
    expect(fs.readFileSync(agyTokenFile(home), 'utf8')).toBe('refreshed token')
    await vi.waitFor(() => expect(fs.existsSync(shot.dir)).toBe(false))
  })

  it('a refreshed token copied back stays readable by the owner alone', () => {
    fs.mkdirSync(path.dirname(agyTokenFile(home)), { recursive: true })
    fs.writeFileSync(agyTokenFile(home), 'old token', { mode: 0o600 })
    const shot = oneShotAgyHome(home, tmpRoot(), false)
    fs.writeFileSync(agyTokenFile(shot.dir), 'refreshed token')
    shot.done()
    expect((fs.statSync(agyTokenFile(home)).mode & 0o777).toString(8)).toBe('600')
  })

  it("leaves the account's token alone when the run did not change it", () => {
    fs.mkdirSync(path.dirname(agyTokenFile(home)), { recursive: true })
    fs.writeFileSync(agyTokenFile(home), 'token', { mode: 0o600 })
    const past = new Date(Date.now() - 60_000)
    fs.utimesSync(agyTokenFile(home), past, past)
    const before = fs.statSync(agyTokenFile(home)).mtimeMs
    oneShotAgyHome(home, tmpRoot(), false).done()
    expect(fs.statSync(agyTokenFile(home)).mtimeMs).toBe(before)
  })

  it('routes an API-key account to the key and copies no token', () => {
    fs.mkdirSync(path.dirname(agyTokenFile(home)), { recursive: true })
    fs.writeFileSync(agyTokenFile(home), 'token')
    const shot = oneShotAgyHome(home, tmpRoot(), true)
    expect(fs.existsSync(agyTokenFile(shot.dir))).toBe(false)
    expect(readJson(settingsOf(shot.dir))).toEqual({ modelProvider: 'gemini' })
    shot.done()
  })
})

describe('agyQuotaFrom (/usage as JSON, AGY§20 AGY§23)', () => {
  it('turns each bucket into a meter named by its group and bucket, with the share used and when it resets', () => {
    const out = JSON.stringify({
      command: {
        name: 'usage',
        data: {
          groups: [
            {
              name: 'Gemini Pro',
              buckets: [
                { name: 'Daily', remaining_fraction: 0.25, reset_time: '2026-10-17T00:00:00Z' },
                { name: 'Weekly', remaining_fraction: 1.2 },
                { name: 'No number' }
              ]
            },
            { buckets: [{ remaining_fraction: 0 }] }
          ]
        }
      }
    })
    expect(agyQuotaFrom(out)).toEqual([
      { label: 'Gemini Pro · Daily', used: 0.75, resetsAt: Date.UTC(2026, 9, 17) },
      { label: 'Gemini Pro · Weekly', used: 0 },
      { label: 'Quota', used: 1 }
    ])
  })

  it('reads the empty list of the API-key route as no meters, and output that is not JSON as unknown', () => {
    expect(agyQuotaFrom(JSON.stringify({ command: { data: { groups: [] } } }))).toEqual([])
    expect(agyQuotaFrom('Loading quota summary...')).toBeUndefined()
  })
})

describe('setAgyApiKeyRoute and trustAgyFolder (AGY§5 AGY§6)', () => {
  it("switches the account's folder to the API key and back, keeping its other settings", () => {
    writeJson(settingsOf(home), { colorScheme: 'dark' })
    setAgyApiKeyRoute(home, true)
    expect(readJson(settingsOf(home))).toEqual({ colorScheme: 'dark', modelProvider: 'gemini' })
    setAgyApiKeyRoute(home, false)
    expect(readJson(settingsOf(home))).toEqual({ colorScheme: 'dark' })
  })

  it('adds folders to the trust list and keeps the ones agy already trusts', () => {
    writeJson(settingsOf(home), { trustedWorkspaces: ['/w/a'], colorScheme: 'dark' })
    trustAgyFolder(home, ['/w/b', '/w/a'])
    expect(readJson(settingsOf(home))).toEqual({
      colorScheme: 'dark',
      trustedWorkspaces: ['/w/a', '/w/b']
    })
    expect(agyTrustsFolder(home, '/w/b')).toBe(true)
    expect(agyTrustsFolder(home, '/w/c')).toBe(false)
  })
})
