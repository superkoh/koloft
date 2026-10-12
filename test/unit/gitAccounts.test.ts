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
  removeGitAccount,
  setDefaultGitAccount,
  setGitPick,
  suggestionDismissed,
  upsertGitAccount
} from '../../src/main/gitAccounts'
import type { GitAccount } from '../../src/shared/types'

const userData = app.getPath('userData')

function account(login: string, addedAt: number, host = 'github.com'): GitAccount {
  const github = host === 'github.com'
  return {
    id: `${host}/${login}`,
    platform: github ? 'github' : 'gitlab',
    url: `https://${host}`,
    host,
    login,
    default: false,
    status: 'ok',
    addedAt
  }
}

const defaults = (): string[] =>
  listGitAccounts()
    .filter((a) => a.default)
    .map((a) => a.id)

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
    expect(defaults()).toEqual(['github.com/alice'])
    upsertGitAccount({ ...account('alice', 1), status: 'expired' })
    expect(defaults()).toEqual(['github.com/alice'])
    expect(findGitAccount('github.com/alice')?.status).toBe('expired')
    setDefaultGitAccount('github.com/bob')
    expect(defaults()).toEqual(['github.com/bob'])
  })

  it('each host has its own default: the first account on a new host is its default, and making one default leaves other hosts alone', () => {
    upsertGitAccount(account('alice', 1))
    upsertGitAccount(account('bob', 2))
    upsertGitAccount(account('dev', 3, 'gitlab.com'))
    upsertGitAccount(account('ops', 4, 'gitlab.com'))
    expect(defaults()).toEqual(['github.com/alice', 'gitlab.com/dev'])
    setDefaultGitAccount('gitlab.com/ops')
    expect(defaults()).toEqual(['github.com/alice', 'gitlab.com/ops'])
  })

  it('removing the default hands it to the oldest account left, and drops every repository picked for the removed one', () => {
    upsertGitAccount(account('alice', 1))
    upsertGitAccount(account('carol', 3))
    upsertGitAccount(account('bob', 2))
    setGitPick('/r/one/.git', 'github.com/alice')
    setGitPick('/r/two/.git', 'github.com/bob')
    setGitPick('/r/three/.git', 'github.com/alice')
    dismissSuggestion('/r/one/.git')

    removeGitAccount('github.com/alice')

    expect(listGitPicks()).toEqual([{ repo: '/r/two/.git', account: 'github.com/bob' }])
    expect(defaults()).toEqual(['github.com/bob'])
    expect(suggestionDismissed('/r/one/.git')).toBe(true)
  })

  it('removing a host’s default promotes the oldest account on that host, never one from another host', () => {
    upsertGitAccount(account('old', 0, 'gitlab.com'))
    upsertGitAccount(account('alice', 1))
    upsertGitAccount(account('bob', 2))
    upsertGitAccount(account('dev', 3, 'gitlab.com'))
    setDefaultGitAccount('github.com/bob')
    setDefaultGitAccount('gitlab.com/dev')

    removeGitAccount('github.com/bob')

    expect(defaults()).toEqual(['github.com/alice', 'gitlab.com/dev'])
  })

  it('a pick names a known account or nothing; null clears it', () => {
    upsertGitAccount(account('bob', 1))
    setGitPick('/r/one/.git', 'github.com/nobody')
    expect(listGitPicks().find((p) => p.repo === '/r/one/.git')).toBeUndefined()
    setGitPick('/r/one/.git', 'github.com/bob')
    expect(listGitPicks().find((p) => p.repo === '/r/one/.git')?.account).toBe('github.com/bob')
    setGitPick('/r/one/.git', null)
    expect(listGitPicks().find((p) => p.repo === '/r/one/.git')).toBeUndefined()
  })

  it('a dismissed suggestion is remembered for that repository only', () => {
    expect(suggestionDismissed('/r/one/.git')).toBe(false)
    dismissSuggestion('/r/one/.git')
    dismissSuggestion('/r/one/.git')
    expect(suggestionDismissed('/r/one/.git')).toBe(true)
    expect(suggestionDismissed('/r/two/.git')).toBe(false)
  })
})
