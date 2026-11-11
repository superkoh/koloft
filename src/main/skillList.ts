import path from 'path'
import type { BackendId, SkillSuggestion } from '@shared/types'
import { SKILL_PREFIX } from '@shared/sessionBackend'

export interface SkillFs {
  readdir(p: string): string[]
  readFile(p: string): string
  isDir(p: string): boolean
  isFile(p: string): boolean
}

function readdirSafe(fs: SkillFs, p: string): string[] {
  try {
    return fs.readdir(p)
  } catch {
    return []
  }
}

function readFileSafe(fs: SkillFs, p: string): string | null {
  try {
    return fs.readFile(p)
  } catch {
    return null
  }
}

function isDirSafe(fs: SkillFs, p: string): boolean {
  try {
    return fs.isDir(p)
  } catch {
    return false
  }
}

function isFileSafe(fs: SkillFs, p: string): boolean {
  try {
    return fs.isFile(p)
  } catch {
    return false
  }
}

function unquote(s: string): string {
  const t = s.trim()
  if (t.length >= 2 && (t[0] === '"' || t[0] === "'") && t[t.length - 1] === t[0]) {
    return t.slice(1, -1).trim()
  }
  return t
}

type FrontMatterKey = 'name' | 'description' | 'user-invocable'

function frontMatter(text: string): Partial<Record<FrontMatterKey, string>> {
  const lines = text.split(/\r?\n/)
  if (lines[0]?.trim() !== '---') return {}
  const out: Partial<Record<FrontMatterKey, string>> = {}
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === '---') break
    const m = /^(name|description|user-invocable)\s*:(.*)$/.exec(line)
    if (!m) continue
    const key = m[1] as FrontMatterKey
    if (out[key] !== undefined) continue
    let value = unquote(m[2])
    if (value === '>' || value === '|' || value === '>-' || value === '|-') {
      value = ''
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].trim() === '---') break
        if (!/^\s/.test(lines[j])) break
        if (lines[j].trim() === '') continue
        value = unquote(lines[j])
        break
      }
    }
    if (value !== '') out[key] = value
  }
  return out
}

function cut120(s: string): string {
  return s.length > 120 ? s.slice(0, 120) : s
}

type Source = SkillSuggestion['source']

export interface SkillPlaces {
  workspace: string
  home: string
  configHome: string
  codexHome?: string
}

export interface SkillFolders {
  skills: string[]
  commands?: string[]
}

// CC§9 CODEX§17 MUSE§16 AGY§31
export function skillFolders(backend: BackendId, p: SkillPlaces): Record<Source, SkillFolders> {
  const ws = (...rel: string[]): string => path.join(p.workspace, ...rel)
  const home = (...rel: string[]): string => path.join(p.home, ...rel)
  switch (backend) {
    case 'claude':
      return {
        project: { skills: [ws('.claude', 'skills')], commands: [ws('.claude', 'commands')] },
        home: { skills: [home('.claude', 'skills')], commands: [home('.claude', 'commands')] }
      }
    case 'codex':
      return {
        project: { skills: [ws('.agents', 'skills'), ws('.codex', 'skills')] },
        home: {
          skills: [
            ...(p.codexHome ? [path.join(p.codexHome, 'skills')] : []),
            home('.agents', 'skills')
          ]
        }
      }
    case 'muse':
      return {
        project: { skills: [ws('.agents', 'skills'), ws('.claude', 'skills')] },
        home: {
          skills: [
            path.join(p.configHome, 'muse', 'skills'),
            home('.agents', 'skills'),
            home('.claude', 'skills'),
            home('.codex', 'skills')
          ]
        }
      }
    case 'agy':
      return {
        project: {
          skills: [ws('.agents', 'skills'), ws('_agents', 'skills'), ws('.agent', 'skills')]
        },
        home: { skills: [] }
      }
  }
}

// AGY§31
const NAMED_ONLY_IN_ITS_SKILL_FILE: ReadonlySet<BackendId> = new Set(['agy'])

function byName(a: SkillSuggestion, b: SkillSuggestion): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
}

function skillsIn(
  fs: SkillFs,
  roots: string[],
  prefix: string,
  source: Source,
  folderNames: boolean
): SkillSuggestion[] {
  const out: SkillSuggestion[] = []
  for (const root of roots) {
    for (const dir of readdirSafe(fs, root)) {
      const folder = path.join(root, dir)
      if (!isDirSafe(fs, folder)) continue
      const file = path.join(folder, 'SKILL.md')
      if (!isFileSafe(fs, file)) continue
      const text = readFileSafe(fs, file)
      const fm = text === null ? {} : frontMatter(text)
      if (fm['user-invocable'] === 'false') continue
      const name = fm.name ?? (folderNames ? dir : undefined)
      if (name === undefined) continue
      out.push({
        name: prefix + name,
        ...(fm.description ? { description: cut120(fm.description) } : {}),
        source
      })
    }
  }
  return out.sort(byName)
}

function commandsIn(
  fs: SkillFs,
  roots: string[],
  prefix: string,
  source: Source
): SkillSuggestion[] {
  const out: SkillSuggestion[] = []
  for (const root of roots) {
    for (const entry of readdirSafe(fs, root)) {
      if (!entry.endsWith('.md')) continue
      if (!isFileSafe(fs, path.join(root, entry))) continue
      out.push({ name: prefix + entry.slice(0, -3), source })
    }
  }
  return out.sort(byName)
}

export function listSkills(
  fs: SkillFs,
  backend: BackendId,
  places: SkillPlaces
): SkillSuggestion[] {
  const prefix = SKILL_PREFIX[backend]
  const folders = skillFolders(backend, places)
  const folderNames = !NAMED_ONLY_IN_ITS_SKILL_FILE.has(backend)
  const out: SkillSuggestion[] = []
  const seen = new Set<string>()
  for (const source of ['project', 'home'] as const) {
    const { skills, commands = [] } = folders[source]
    for (const s of [
      ...skillsIn(fs, skills, prefix, source, folderNames),
      ...commandsIn(fs, commands, prefix, source)
    ]) {
      if (seen.has(s.name)) continue
      seen.add(s.name)
      out.push(s)
    }
  }
  return out
}
