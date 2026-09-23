import path from 'path'
import type { SkillSuggestion } from '@shared/types'

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

function skillsIn(fs: SkillFs, base: string, source: 'project' | 'home'): SkillSuggestion[] {
  const root = path.join(base, '.claude', 'skills')
  const out: SkillSuggestion[] = []
  for (const dir of readdirSafe(fs, root).sort()) {
    const folder = path.join(root, dir)
    if (!isDirSafe(fs, folder)) continue
    const file = path.join(folder, 'SKILL.md')
    if (!isFileSafe(fs, file)) continue
    const text = readFileSafe(fs, file)
    const fm = text === null ? {} : frontMatter(text)
    const name = fm.name ?? dir
    out.push({
      name: `/${name}`,
      ...(fm.description ? { description: cut120(fm.description) } : {}),
      source
    })
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

function commandsIn(fs: SkillFs, base: string, source: 'project' | 'home'): SkillSuggestion[] {
  const root = path.join(base, '.claude', 'commands')
  const out: SkillSuggestion[] = []
  for (const entry of readdirSafe(fs, root).sort()) {
    if (!entry.endsWith('.md')) continue
    if (!isFileSafe(fs, path.join(root, entry))) continue
    out.push({ name: `/${entry.slice(0, -3)}`, source })
  }
  return out
}

export function listSkills(fs: SkillFs, workspaceRoot: string, home: string): SkillSuggestion[] {
  const out = [
    ...skillsIn(fs, workspaceRoot, 'project'),
    ...commandsIn(fs, workspaceRoot, 'project')
  ]
  const seen = new Set(out.map((s) => s.name))
  for (const s of [...skillsIn(fs, home, 'home'), ...commandsIn(fs, home, 'home')]) {
    if (seen.has(s.name)) continue
    seen.add(s.name)
    out.push(s)
  }
  return out
}
