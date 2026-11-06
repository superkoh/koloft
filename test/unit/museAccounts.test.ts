import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mergeMuseSettings, placeKoloftSkills, prepareMuseHome } from '../../src/main/museAccounts'
import { HomeAccountPicker } from '../../src/main/codexAccounts'
import type { AccountView } from '../../src/shared/types'

let root: string
let owner: string
let home: string

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'muse-accounts-')))
  owner = path.join(root, 'config')
  home = path.join(root, 'homes', 'work')
  fs.mkdirSync(path.join(owner, 'muse'), { recursive: true })
  fs.mkdirSync(path.join(owner, 'gh'))
})
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

const trusted = (file: string): string[] =>
  Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).projects ?? {})

describe("a Muse account's own settings folder", () => {
  it("links back to the owner's muse trust list and every other app's settings, but keeps its own sign-in", () => {
    fs.writeFileSync(path.join(owner, 'muse', 'trust.json'), '{}')
    prepareMuseHome(home, owner)
    expect(fs.readlinkSync(path.join(home, 'muse', 'trust.json'))).toBe(
      path.join(owner, 'muse', 'trust.json')
    )
    expect(fs.readlinkSync(path.join(home, 'gh'))).toBe(path.join(owner, 'gh'))
    fs.writeFileSync(path.join(home, 'muse', 'auth.json'), '{}')
    prepareMuseHome(home, owner)
    expect(fs.lstatSync(path.join(home, 'muse', 'auth.json')).isSymbolicLink()).toBe(false)
  })

  // MUSE§13
  it("leaves out the link to an AGENTS.md the owner does not have, since muse will not start on it, links it once the owner has one and drops it again once the owner deletes theirs, and links a trust list the owner has not got yet so muse writes it in the owner's folder", () => {
    prepareMuseHome(home, owner)
    expect(fs.lstatSync(path.join(home, 'muse', 'AGENTS.md'), { throwIfNoEntry: false })).toBe(
      undefined
    )
    expect(fs.readlinkSync(path.join(home, 'muse', 'trust.json'))).toBe(
      path.join(owner, 'muse', 'trust.json')
    )
    fs.writeFileSync(path.join(owner, 'muse', 'AGENTS.md'), '# rules')
    prepareMuseHome(home, owner)
    expect(fs.readFileSync(path.join(home, 'muse', 'AGENTS.md'), 'utf8')).toBe('# rules')
    fs.rmSync(path.join(owner, 'muse', 'AGENTS.md'))
    prepareMuseHome(home, owner)
    expect(fs.lstatSync(path.join(home, 'muse', 'AGENTS.md'), { throwIfNoEntry: false })).toBe(
      undefined
    )
  })

  it("keeps a folder muse trusted while the link was replaced, in the owner's trust list", () => {
    fs.writeFileSync(
      path.join(owner, 'muse', 'trust.json'),
      JSON.stringify({ schema_version: 1, projects: { '/a': { decision: 'trusted' } } })
    )
    prepareMuseHome(home, owner)
    const mine = path.join(home, 'muse', 'trust.json')
    fs.rmSync(mine)
    fs.writeFileSync(
      mine,
      JSON.stringify({ schema_version: 1, projects: { '/b': { decision: 'trusted' } } })
    )
    prepareMuseHome(home, owner)
    expect(fs.lstatSync(mine).isSymbolicLink()).toBe(true)
    expect(trusted(path.join(owner, 'muse', 'trust.json')).sort()).toEqual(['/a', '/b'])
  })

  // MUSE§16
  it("links in each of the owner's own skills, keeps Koloft's two skills its own, and takes the koloft skill away again when asked while koloft-docs stays", () => {
    for (const skill of ['review', 'koloft', 'koloft-docs'])
      fs.mkdirSync(path.join(owner, 'muse', 'skills', skill), { recursive: true })
    prepareMuseHome(home, owner)
    const skills = path.join(home, 'muse', 'skills')
    expect(fs.readlinkSync(path.join(skills, 'review'))).toBe(
      path.join(owner, 'muse', 'skills', 'review')
    )
    for (const skill of ['koloft', 'koloft-docs'])
      expect(fs.lstatSync(path.join(skills, skill), { throwIfNoEntry: false })).toBeUndefined()
    placeKoloftSkills(home, true)
    for (const skill of ['koloft', 'koloft-docs'])
      expect(fs.lstatSync(path.join(skills, skill)).isSymbolicLink()).toBe(false)
    expect(fs.readFileSync(path.join(skills, 'koloft', 'SKILL.md'), 'utf8')).toContain('koloft')
    placeKoloftSkills(home, false)
    expect(fs.existsSync(path.join(skills, 'koloft'))).toBe(false)
    expect(fs.existsSync(path.join(owner, 'muse', 'skills', 'koloft'))).toBe(true)
    expect(fs.readFileSync(path.join(skills, 'koloft-docs', 'SKILL.md'), 'utf8')).toMatch(
      /^---\nname: koloft-docs\n/
    )
    expect(fs.existsSync(path.join(skills, 'koloft-docs', 'references', 'core.md'))).toBe(true)
  })
})

describe("a Muse account's own settings.json and approval policy (ADR-0048 MUSE§21)", () => {
  const ownersFile = (): string => path.join(owner, 'muse', 'settings.json')
  const copy = (): string => path.join(home, 'muse', 'settings.json')
  const policyFile = (): string => path.join(home, 'muse', 'approval-policy.json')
  const read = (file: string): Record<string, unknown> => JSON.parse(fs.readFileSync(file, 'utf8'))
  const servers = (): Record<string, Record<string, unknown>> =>
    read(copy()).mcpServers as Record<string, Record<string, unknown>>
  const playwright = { command: 'npx', args: ['-y', '@playwright/mcp@latest'] }
  const toolNames = (): unknown[] =>
    (read(policyFile()).rules as { rule: { tool_name: string } }[]).map((r) => r.rule.tool_name)

  beforeEach(() => {
    fs.writeFileSync(
      ownersFile(),
      JSON.stringify({
        schema_version: 1,
        theme: 'dark',
        mcpServers: {
          pw: playwright,
          mine: { ...playwright, env: { PLAYWRIGHT_MCP_CDP_ENDPOINT: 'ws://owner' } },
          'my-pw': playwright,
          github: { command: 'npx', args: ['@modelcontextprotocol/server-github'] }
        }
      })
    )
  })

  it("turns the account's link to the owner's settings into Koloft's copy, whose Playwright entries take the Workbench browser's address from muse's own environment, and leaves the owner's file as it was", () => {
    fs.mkdirSync(path.join(home, 'muse'), { recursive: true })
    fs.symlinkSync(ownersFile(), copy())
    const ownersText = fs.readFileSync(ownersFile(), 'utf8')
    mergeMuseSettings(home, owner, true)
    expect(fs.lstatSync(copy()).isSymbolicLink()).toBe(false)
    expect(fs.readFileSync(ownersFile(), 'utf8')).toBe(ownersText)
    expect(read(copy()).theme).toBe('dark')
    expect(servers().pw.env).toEqual({
      PLAYWRIGHT_MCP_CDP_ENDPOINT: '${PLAYWRIGHT_MCP_CDP_ENDPOINT}',
      PLAYWRIGHT_MCP_ALLOW_UNRESTRICTED_FILE_ACCESS:
        '${PLAYWRIGHT_MCP_ALLOW_UNRESTRICTED_FILE_ACCESS}'
    })
    expect(servers().mine.env).toEqual({
      PLAYWRIGHT_MCP_CDP_ENDPOINT: 'ws://owner',
      PLAYWRIGHT_MCP_ALLOW_UNRESTRICTED_FILE_ACCESS:
        '${PLAYWRIGHT_MCP_ALLOW_UNRESTRICTED_FILE_ACCESS}'
    })
    expect(servers().github.env).toBeUndefined()
  })

  it('writes the same copy whether or not the tab has the Workbench browser, so tabs of one account never undo each other', () => {
    mergeMuseSettings(home, owner, true)
    const withBrowser = fs.readFileSync(copy(), 'utf8')
    mergeMuseSettings(home, owner, false)
    expect(fs.readFileSync(copy(), 'utf8')).toBe(withBrowser)
  })

  it("copies each setting muse changed in the copy from inside a Koloft tab back into the owner's file, without Koloft's lines and keeping what the owner changed meanwhile, and hands the owner's later edits to the copy", () => {
    mergeMuseSettings(home, owner, true)
    const { theme, ...musesCopy } = read(copy())
    expect(theme).toBe('dark')
    const github = { command: 'npx', args: ['@modelcontextprotocol/server-github', '--ro'] }
    fs.writeFileSync(
      copy(),
      JSON.stringify({
        ...musesCopy,
        tui: { compact: true },
        mcpServers: { ...servers(), github }
      })
    )
    const ownersBefore = read(ownersFile())
    fs.writeFileSync(
      ownersFile(),
      JSON.stringify({
        ...ownersBefore,
        model: 'big',
        mcpServers: { ...(ownersBefore.mcpServers as object), extra: { command: 'x' } }
      })
    )
    mergeMuseSettings(home, owner, true)
    const owners = read(ownersFile())
    expect(owners).toMatchObject({ model: 'big', tui: { compact: true } })
    expect(owners).not.toHaveProperty('theme')
    expect(owners.mcpServers).toMatchObject({
      pw: playwright,
      mine: { env: { PLAYWRIGHT_MCP_CDP_ENDPOINT: 'ws://owner' } },
      github,
      extra: { command: 'x' }
    })
    expect(JSON.stringify(owners)).not.toContain('${')
    fs.writeFileSync(ownersFile(), JSON.stringify({ ...owners, theme: 'blue' }))
    mergeMuseSettings(home, owner, true)
    expect(read(copy())).toMatchObject({ theme: 'blue', model: 'big', tui: { compact: true } })
    expect(servers().pw.env).toHaveProperty('PLAYWRIGHT_MCP_CDP_ENDPOINT')
  })

  it("never writes the owner's file from a copy it cannot read, and touches nothing while the owner's own file cannot be read", () => {
    mergeMuseSettings(home, owner, true)
    const ownersText = fs.readFileSync(ownersFile(), 'utf8')
    fs.writeFileSync(copy(), '{"schema_version": 1, "the')
    mergeMuseSettings(home, owner, true)
    expect(fs.readFileSync(ownersFile(), 'utf8')).toBe(ownersText)
    expect(read(copy()).theme).toBe('dark')
    fs.writeFileSync(ownersFile(), '{ // a comment')
    const copyText = fs.readFileSync(copy(), 'utf8')
    mergeMuseSettings(home, owner, true)
    expect(fs.readFileSync(copy(), 'utf8')).toBe(copyText)
    expect(fs.readFileSync(ownersFile(), 'utf8')).toBe('{ // a comment')
  })

  it("keeps muse's change in the copy, to try again next launch, while the owner's file cannot be written, and still starts", () => {
    mergeMuseSettings(home, owner, true)
    fs.writeFileSync(copy(), JSON.stringify({ ...read(copy()), theme: 'light' }))
    fs.chmodSync(path.join(owner, 'muse'), 0o500)
    try {
      expect(() => mergeMuseSettings(home, owner, true)).not.toThrow()
      expect(read(copy()).theme).toBe('light')
    } finally {
      fs.chmodSync(path.join(owner, 'muse'), 0o700)
    }
    mergeMuseSettings(home, owner, true)
    expect(read(ownersFile()).theme).toBe('light')
  })

  // MUSE§13
  it('gives the copy a schema version when the owner has no settings file, since muse will not start on one without it', () => {
    fs.rmSync(ownersFile())
    mergeMuseSettings(home, owner, true)
    expect(read(copy())).toEqual({ schema_version: 1 })
    expect(fs.existsSync(policyFile())).toBe(false)
  })

  it("allows every Playwright tool that is not read-only by name while the tab has the Workbench browser, keeps the account's other rules, adds none for a tool another rule names, and takes only its own back once a tab has none, leaving them be when Koloft only readies the account folder", () => {
    const own = {
      effect: 'allow',
      durability: 'local_persistent',
      rule: { kind: 'tool_action', tool_name: 'mcp__pw__browser_click' },
      reason: null
    }
    const deny = {
      ...own,
      effect: 'deny',
      rule: { ...own.rule, tool_name: 'mcp__pw__browser_evaluate' }
    }
    fs.mkdirSync(path.join(home, 'muse'), { recursive: true })
    fs.writeFileSync(policyFile(), JSON.stringify({ schema_version: 2, rules: [own, deny] }))
    mergeMuseSettings(home, owner, true)
    const names = toolNames()
    expect(names.slice(0, 2)).toEqual(['mcp__pw__browser_click', 'mcp__pw__browser_evaluate'])
    expect(names).toContain('mcp__pw__browser_navigate')
    expect(names).toContain('mcp__pw__browser_run_code_unsafe')
    expect(names).toContain('mcp__mine__browser_click')
    expect(names).toContain('mcp__my_pw__browser_navigate')
    expect(names).not.toContain('mcp__pw__browser_snapshot')
    for (const twice of ['mcp__pw__browser_click', 'mcp__pw__browser_evaluate'])
      expect(names.filter((n) => n === twice)).toHaveLength(1)
    prepareMuseHome(home, owner)
    expect(toolNames()).toEqual(names)
    expect(names.some((n) => String(n).startsWith('mcp__github__browser'))).toBe(false)
    mergeMuseSettings(home, owner, false)
    expect(read(policyFile())).toEqual({ schema_version: 2, rules: [own, deny] })
  })
})

describe('picking a Muse account', () => {
  const account = (name: string, extra: Partial<AccountView> = {}): AccountView => ({
    name,
    kind: 'muse-home',
    enabled: true,
    fable: 'unknown',
    status: 'ok',
    addedAt: 0,
    ...extra
  })

  it('keeps a resumed session on its account, takes turns otherwise, and skips one that is off or signed out', () => {
    const picker = new HomeAccountPicker('muse-home')
    const all = [account('a'), account('b'), account('c', { status: 'expired' })]
    expect(picker.pick(all, 'b')?.name).toBe('b')
    expect([picker.pick(all)?.name, picker.pick(all)?.name, picker.pick(all)?.name]).toEqual([
      'a',
      'b',
      'a'
    ])
    expect(picker.pick([account('a', { enabled: false })])).toBeUndefined()
  })
})
