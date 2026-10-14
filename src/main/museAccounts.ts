import fs from 'fs'
import path from 'path'
import type { AccountView } from '@shared/types'
import { usableAccounts } from '@shared/accountUsage'
import { record } from './codexObservation'

const MUSE_HOMES = 'muse-homes'

// MUSE§13
export const MUSE_FILE_CREDENTIALS = { TBH_CREDENTIAL_BACKEND: 'file' }

export function museHomeOf(userData: string, name: string): string {
  return path.join(userData, MUSE_HOMES, name)
}

// MUSE§2 MUSE§13
export function museAccountEnv(home: string): Record<string, string> {
  return { XDG_CONFIG_HOME: home, ...MUSE_FILE_CREDENTIALS }
}

const SHARED_WITH_THE_OWNER = ['settings.json', 'trust.json', 'AGENTS.md']

function readJson(file: string): Record<string, unknown> {
  try {
    return record(JSON.parse(fs.readFileSync(file, 'utf8')))
  } catch {
    return {}
  }
}

// MUSE§10
function keepTrustOf(own: string, owners: string): void {
  const mine = readJson(own)
  const theirs = readJson(owners)
  const projects = { ...record(mine.projects), ...record(theirs.projects) }
  fs.mkdirSync(path.dirname(owners), { recursive: true })
  fs.writeFileSync(owners, JSON.stringify({ schema_version: 1, ...theirs, projects }, null, 2))
}

function linkBack(own: string, owners: string): void {
  const there = fs.lstatSync(own, { throwIfNoEntry: false })
  if (there?.isSymbolicLink()) return
  if (there) {
    if (path.basename(own) === 'trust.json') keepTrustOf(own, owners)
    else if (!fs.existsSync(owners)) {
      fs.mkdirSync(path.dirname(owners), { recursive: true })
      fs.renameSync(own, owners)
    }
    fs.rmSync(own, { force: true })
  }
  fs.symlinkSync(owners, own)
}

// MUSE§2 MUSE§13
export function prepareMuseHome(home: string, ownersConfig: string): void {
  const own = path.join(home, 'muse')
  fs.mkdirSync(own, { recursive: true, mode: 0o700 })
  for (const name of SHARED_WITH_THE_OWNER)
    linkBack(path.join(own, name), path.join(ownersConfig, 'muse', name))
  let entries: string[] = []
  try {
    entries = fs.readdirSync(ownersConfig)
  } catch {}
  for (const entry of entries) {
    const mine = path.join(home, entry)
    if (entry === 'muse' || fs.lstatSync(mine, { throwIfNoEntry: false })) continue
    fs.symlinkSync(path.join(ownersConfig, entry), mine)
  }
}

export class MuseAccountPicker {
  private turn = 0

  pick(accounts: AccountView[], resumedOn?: string): AccountView | undefined {
    const pool = usableAccounts(accounts, ['muse-home'])
    if (pool.length === 0) return undefined
    return pool.find((a) => a.name === resumedOn) ?? pool[this.turn++ % pool.length]
  }
}
