import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { placeKoloftSkill, prepareMuseHome } from '../../src/main/museAccounts'
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
  it("links back to the owner's muse settings and every other app's settings, but keeps its own sign-in", () => {
    fs.writeFileSync(path.join(owner, 'muse', 'settings.json'), '{}')
    prepareMuseHome(home, owner)
    expect(fs.readlinkSync(path.join(home, 'muse', 'settings.json'))).toBe(
      path.join(owner, 'muse', 'settings.json')
    )
    expect(fs.readlinkSync(path.join(home, 'gh'))).toBe(path.join(owner, 'gh'))
    fs.writeFileSync(path.join(home, 'muse', 'auth.json'), '{}')
    prepareMuseHome(home, owner)
    expect(fs.lstatSync(path.join(home, 'muse', 'auth.json')).isSymbolicLink()).toBe(false)
  })

  // MUSE§13
  it("leaves out the link to an AGENTS.md the owner does not have, since muse will not start on it, links it once the owner has one and drops it again once the owner deletes theirs, and links trust and settings the owner has not got yet so muse writes them in the owner's folder", () => {
    prepareMuseHome(home, owner)
    expect(fs.lstatSync(path.join(home, 'muse', 'AGENTS.md'), { throwIfNoEntry: false })).toBe(
      undefined
    )
    for (const name of ['trust.json', 'settings.json'])
      expect(fs.readlinkSync(path.join(home, 'muse', name))).toBe(path.join(owner, 'muse', name))
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
  it("links in each of the owner's own skills, keeps Koloft's skill its own, and takes it away again when asked", () => {
    fs.mkdirSync(path.join(owner, 'muse', 'skills', 'review'), { recursive: true })
    fs.mkdirSync(path.join(owner, 'muse', 'skills', 'koloft'), { recursive: true })
    prepareMuseHome(home, owner)
    const skills = path.join(home, 'muse', 'skills')
    expect(fs.readlinkSync(path.join(skills, 'review'))).toBe(
      path.join(owner, 'muse', 'skills', 'review')
    )
    placeKoloftSkill(home, true)
    expect(fs.lstatSync(path.join(skills, 'koloft')).isSymbolicLink()).toBe(false)
    expect(fs.readFileSync(path.join(skills, 'koloft', 'SKILL.md'), 'utf8')).toContain('koloft')
    placeKoloftSkill(home, false)
    expect(fs.existsSync(path.join(skills, 'koloft'))).toBe(false)
    expect(fs.existsSync(path.join(owner, 'muse', 'skills', 'koloft'))).toBe(true)
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
