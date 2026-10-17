import fs from 'fs'
import path from 'path'
import { record } from './codexObservation'
import { writeWholeBeforeVisible } from './jsonDrops'

const MUSE_HOMES = 'muse-homes'

// MUSE§13
const MUSE_FILE_CREDENTIALS = { TBH_CREDENTIAL_BACKEND: 'file' }

export function museHomeOf(userData: string, name: string): string {
  return path.join(userData, MUSE_HOMES, name)
}

// MUSE§2 MUSE§13
export function museAccountEnv(home: string): Record<string, string> {
  return { XDG_CONFIG_HOME: home, ...MUSE_FILE_CREDENTIALS }
}

const SHARED_WITH_THE_OWNER = ['settings.json', 'trust.json', 'AGENTS.md']
// MUSE§13
export const MUSE_STOPS_WHEN_THIS_LINK_DANGLES = 'AGENTS.md'

export function readJson(file: string): Record<string, unknown> {
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
  writeWholeBeforeVisible(
    owners,
    JSON.stringify({ schema_version: 1, ...theirs, projects }, null, 2)
  )
}

function linkBack(own: string, owners: string): void {
  const there = fs.lstatSync(own, { throwIfNoEntry: false })
  const mustExist = path.basename(own) === MUSE_STOPS_WHEN_THIS_LINK_DANGLES
  if (there?.isSymbolicLink()) {
    if (mustExist && !fs.existsSync(owners)) fs.unlinkSync(own)
    return
  }
  if (there) {
    if (path.basename(own) === 'trust.json') keepTrustOf(own, owners)
    else if (!fs.existsSync(owners)) {
      fs.mkdirSync(path.dirname(owners), { recursive: true })
      fs.renameSync(own, owners)
    }
    fs.rmSync(own, { force: true })
  }
  if (!mustExist || fs.existsSync(owners)) fs.symlinkSync(owners, own)
}

export const KOLOFT_SKILL = 'koloft'

// MUSE§16
function linkOwnersSkills(own: string, owners: string): void {
  fs.mkdirSync(own, { recursive: true })
  let skills: string[] = []
  try {
    skills = fs.readdirSync(owners)
  } catch {}
  for (const skill of skills) {
    const mine = path.join(own, skill)
    if (skill === KOLOFT_SKILL || fs.lstatSync(mine, { throwIfNoEntry: false })) continue
    fs.symlinkSync(path.join(owners, skill), mine)
  }
}

// MUSE§16
export function placeKoloftSkill(home: string, skill: string | undefined): void {
  const dir = path.join(home, 'muse', 'skills', KOLOFT_SKILL)
  if (!skill) return fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'SKILL.md'), skill)
}

// MUSE§2 MUSE§13
export function prepareMuseHome(home: string, ownersConfig: string): void {
  const own = path.join(home, 'muse')
  fs.mkdirSync(own, { recursive: true, mode: 0o700 })
  fs.mkdirSync(path.join(ownersConfig, 'muse'), { recursive: true })
  for (const name of SHARED_WITH_THE_OWNER)
    linkBack(path.join(own, name), path.join(ownersConfig, 'muse', name))
  linkOwnersSkills(path.join(own, 'skills'), path.join(ownersConfig, 'muse', 'skills'))
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
