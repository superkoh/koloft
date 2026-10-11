import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GithubAccountPicks, parseGhAccounts, workspaceOfCwd } from '../../src/main/githubAccounts'
import { ghAccountView } from '../../src/renderer/src/freshnessView'
import type { GhResult } from '../../src/main/prChecks'

const STATUS = JSON.stringify({
  hosts: {
    'github.com': [
      {
        state: 'success',
        active: true,
        host: 'github.com',
        login: 'alice',
        tokenSource: 'keyring'
      },
      { state: 'error', active: false, host: 'github.com', login: 'bob', tokenSource: 'keyring' },
      { state: 'success', active: false, host: 'github.com', login: '', tokenSource: 'GH_TOKEN' }
    ]
  }
})

// PLATFORM§43
describe('the gh accounts a workspace can pick from', () => {
  it("lists gh's own accounts, marks the current one and a refused token, and leaves out a token from the environment", () => {
    expect(parseGhAccounts(STATUS)).toEqual([
      { login: 'alice', active: true, ok: true },
      { login: 'bob', active: false, ok: false }
    ])
    expect(parseGhAccounts('{"hosts":{}}')).toEqual([])
  })

  it('a worktree inside a workspace belongs to that workspace, the deepest one when they nest', () => {
    const pinned = ['/w/app', '/w/app/sub', '/w/other']
    expect(workspaceOfCwd('/w/app/.claude/worktrees/x', pinned)).toBe('/w/app')
    expect(workspaceOfCwd('/w/app/sub/src', pinned)).toBe('/w/app/sub')
    expect(workspaceOfCwd('/w/apple', pinned)).toBeUndefined()
  })
})

describe('the git panel account rows', () => {
  const alice = { login: 'alice', active: true, ok: true }
  const bob = { login: 'bob', active: false, ok: true }

  it("with one account there are no rows, only who it is; with two, gh's current carries the check until another is picked", () => {
    expect(ghAccountView({ accounts: [alice], picked: null })).toMatchObject({
      only: 'alice',
      rows: []
    })
    const follows = ghAccountView({ accounts: [alice, bob], picked: null })
    expect(follows.rows.map((r) => [r.login, r.inUse])).toEqual([
      ['alice', true],
      ['bob', false]
    ])
    const picked = ghAccountView({ accounts: [alice, bob], picked: 'bob' })
    expect(picked.rows.map((r) => [r.login, r.inUse])).toEqual([
      ['alice', false],
      ['bob', true]
    ])
    expect(picked.gone).toBeNull()
  })

  it("a picked account that left gh stays as a checked row, says it is signed out and names gh's current one in use", () => {
    const v = ghAccountView({ accounts: [alice], picked: 'bob' })
    expect(v.gone).toBe('bob')
    expect(v.current).toBe('alice')
    expect(v.rows).toEqual([
      { login: 'alice', active: true, ok: true, inUse: false },
      { login: 'bob', active: false, ok: false, inUse: true }
    ])
  })
})

describe('the account a workspace picked', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-picks-'))
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  const tokens: Record<string, string> = { '': 'tok-current', bob: 'tok-bob' }
  const gh = async (args: string[]): Promise<GhResult> => {
    const u = args.indexOf('-u')
    const token = tokens[u < 0 ? '' : args[u + 1]]
    return { code: token ? 0 : 1, stdout: token ? token + '\n' : '', stderr: '', missing: false }
  }

  it("hands the workspace that account's token, keeps the pick across restarts, and forgets it when unpicked", async () => {
    const file = path.join(dir, 'picks.json')
    const picks = new GithubAccountPicks(file, gh)
    await picks.pick('/w/app', 'bob')
    expect(picks.token('/w/app')).toBe('tok-bob')
    expect(picks.token('/w/other')).toBeUndefined()

    const again = new GithubAccountPicks(file, gh)
    await again.refresh()
    expect(again.picked('/w/app')).toBe('bob')
    expect(again.token('/w/app')).toBe('tok-bob')

    await again.pick('/w/app', null)
    expect(again.token('/w/app')).toBeUndefined()
  })

  it("falls back to gh's current account when the picked one has no token any more", async () => {
    const picks = new GithubAccountPicks(path.join(dir, 'picks.json'), gh)
    await picks.pick('/w/app', 'carol')
    expect(picks.token('/w/app')).toBe('tok-current')
  })
})
