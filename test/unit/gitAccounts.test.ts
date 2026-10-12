import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import fs from 'fs'
import path from 'path'

vi.mock('electron', async () => {
  const nfs = await import('node:fs')
  const nos = await import('node:os')
  const npath = await import('node:path')
  const base = nfs.mkdtempSync(npath.join(nos.tmpdir(), 'koloft-gitaccounts-'))
  return { app: { getPath: () => base, getName: () => 'koloft', isPackaged: false } }
})

import { app } from 'electron'
import {
  dismissSuggestion,
  findGitAccount,
  listGitAccounts,
  listGitPicks,
  pickForRepo,
  removeGitAccount,
  setDefaultGitAccount,
  setGitPick,
  suggestionDismissed,
  upsertGitAccount
} from '../../src/main/gitAccounts'
import type { GitAccount } from '../../src/shared/types'

const userData = app.getPath('userData')

function account(login: string, addedAt: number): GitAccount {
  return {
    host: 'github.com',
    login,
    id: addedAt,
    name: login,
    default: false,
    status: 'ok',
    addedAt
  }
}

const defaults = (): string[] =>
  listGitAccounts()
    .filter((a) => a.default)
    .map((a) => a.login)

beforeEach(() => {
  fs.rmSync(path.join(userData, 'settings.json'), { force: true })
})

afterAll(() => {
  fs.rmSync(userData, { recursive: true, force: true })
})

describe('git accounts', () => {
  it('the first account added is the default; later ones and re-logins leave the default where it is', () => {
    upsertGitAccount(account('alice', 1))
    upsertGitAccount({ ...account('bob', 2), default: true })
    expect(defaults()).toEqual(['alice'])
    upsertGitAccount({ ...account('alice', 1), status: 'expired' })
    expect(defaults()).toEqual(['alice'])
    expect(findGitAccount('ALICE')?.status).toBe('expired')
    setDefaultGitAccount('bob')
    expect(defaults()).toEqual(['bob'])
  })

  it('removing the default hands it to the oldest account left, and drops every repository picked for the removed one', () => {
    upsertGitAccount(account('alice', 1))
    upsertGitAccount(account('carol', 3))
    upsertGitAccount(account('bob', 2))
    setGitPick('/r/one/.git', 'alice')
    setGitPick('/r/two/.git', 'bob')
    setGitPick('/r/three/.git', 'alice')
    dismissSuggestion('/r/one/.git')

    const { removedPicks } = removeGitAccount('alice')

    expect(removedPicks.map((p) => p.repo)).toEqual(['/r/one/.git', '/r/three/.git'])
    expect(listGitPicks()).toEqual([{ repo: '/r/two/.git', host: 'github.com', login: 'bob' }])
    expect(defaults()).toEqual(['bob'])
    expect(suggestionDismissed('/r/one/.git')).toBe(true)
  })

  it('a pick names a known account or nothing; null clears it', () => {
    upsertGitAccount(account('bob', 1))
    setGitPick('/r/one/.git', 'nobody')
    expect(pickForRepo('/r/one/.git')).toBeUndefined()
    setGitPick('/r/one/.git', 'BOB')
    expect(pickForRepo('/r/one/.git')?.login).toBe('bob')
    setGitPick('/r/one/.git', null)
    expect(pickForRepo('/r/one/.git')).toBeUndefined()
  })

  it('a dismissed suggestion is remembered for that repository only', () => {
    expect(suggestionDismissed('/r/one/.git')).toBe(false)
    dismissSuggestion('/r/one/.git')
    dismissSuggestion('/r/one/.git')
    expect(suggestionDismissed('/r/one/.git')).toBe(true)
    expect(suggestionDismissed('/r/two/.git')).toBe(false)
  })
})
