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

function frontMatter(text: string): { name?: string; description?: string } {
  const lines = text.split(/\r?\n/)
  if (lines[0]?.trim() !== '---') return {}
  const out: { name?: string; description?: string } = {}
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === '---') break
    const m = /^(name|description)\s*:(.*)$/.exec(line)
    if (!m) continue
    const key = m[1] as 'name' | 'description'
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
  commands: string[]
}

const NO_FOLDERS: SkillFolders = { skills: [], commands: [] }

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
        project: { skills: [ws('.agents', 'skills'), ws('.codex', 'skills')], commands: [] },
        home: {
          skills: [
            ...(p.codexHome ? [path.join(p.codexHome, 'skills')] : []),
            home('.agents', 'skills')
          ],
          commands: []
        }
      }
    case 'muse':
      return {
        project: { skills: [ws('.agents', 'skills'), ws('.claude', 'skills')], commands: [] },
        home: {
          skills: [
            path.join(p.configHome, 'muse', 'skills'),
            home('.agents', 'skills'),
            home('.claude', 'skills'),
            home('.codex', 'skills')
          ],
          commands: []
        }
      }
    case 'agy':
      return {
        project: {
          skills: [ws('.agents', 'skills'), ws('_agents', 'skills'), ws('.agent', 'skills')],
          commands: []
        },
        home: NO_FOLDERS
      }
  }
}

function byName(a: SkillSuggestion, b: SkillSuggestion): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
}

function skillsIn(fs: SkillFs, roots: string[], prefix: string, source: Source): SkillSuggestion[] {
  const out: SkillSuggestion[] = []
  for (const root of roots) {
    for (const dir of readdirSafe(fs, root)) {
      const folder = path.join(root, dir)
      if (!isDirSafe(fs, folder)) continue
      const file = path.join(folder, 'SKILL.md')
      if (!isFileSafe(fs, file)) continue
      const text = readFileSafe(fs, file)
      const fm = text === null ? {} : frontMatter(text)
      out.push({
        name: prefix + (fm.name ?? dir),
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
  const folders = skillFolders(backend, places)
  const prefix = SKILL_PREFIX[backend]
  const out: SkillSuggestion[] = []
  const seen = new Set<string>()
  for (const source of ['project', 'home'] as const) {
    const { skills, commands } = folders[source]
    for (const s of [
      ...skillsIn(fs, skills, prefix, source),
      ...commandsIn(fs, commands, prefix, source)
    ]) {
      if (seen.has(s.name)) continue
      seen.add(s.name)
      out.push(s)
    }
  }
  return out
}
