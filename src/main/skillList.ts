import path from 'path'
import type { BackendId, SkillSuggestion } from '@shared/types'
import { SKILL_PREFIX } from '@shared/sessionBackend'
import type { AgentFlags } from '@core/agent/manifest'
import { agentManifest } from '@core/agent/registry'

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
  moreInTheHome?: readonly string[]
}

export interface SkillFolders {
  skills: string[]
  commands?: string[]
}

export function skillFolders(backend: BackendId, p: SkillPlaces): Record<Source, SkillFolders> {
  const { inTheWorkspace, inTheHome } = agentManifest(backend).skillFolders
  const ws = (rel: string): string => path.join(p.workspace, rel)
  const home = (rel: string): string => path.join(p.home, rel)
  return {
    project: { skills: inTheWorkspace.skills.map(ws), commands: inTheWorkspace.commands.map(ws) },
    home: {
      skills: [...(p.moreInTheHome ?? []), ...inTheHome.skills.map(home)],
      commands: inTheHome.commands.map(home)
    }
  }
}

function byName(a: SkillSuggestion, b: SkillSuggestion): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
}

function skillsIn(
  fs: SkillFs,
  roots: string[],
  prefix: string,
  source: Source,
  reads: AgentFlags
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
      if (reads.typesASkillOnlyByTheNameInItsFile && fm.name === undefined) continue
      if (reads.refusesATypedSkillMarkedNotUserInvocable && fm['user-invocable'] === 'false')
        continue
      const name = fm.name ?? dir
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
  const out: SkillSuggestion[] = []
  const seen = new Set<string>()
  for (const source of ['project', 'home'] as const) {
    const { skills, commands = [] } = folders[source]
    for (const s of [
      ...skillsIn(fs, skills, prefix, source, agentManifest(backend).flags),
      ...commandsIn(fs, commands, prefix, source)
    ]) {
      if (seen.has(s.name)) continue
      seen.add(s.name)
      out.push(s)
    }
  }
  return out
}
