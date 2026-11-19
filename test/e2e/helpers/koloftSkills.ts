import fs from 'fs'
import path from 'path'

export function filesNamedUnder(dir: string, name: string): string[] {
  const found: string[] = []
  const walk = (rel: string): void => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const child = path.join(rel, e.name)
      if (e.name === name) found.push(child)
      if (e.isDirectory()) walk(child)
    }
  }
  walk('')
  return found
}

export function koloftSkillsUnder(dir: string): string[] {
  return fs
    .readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((rel) => rel.endsWith(path.join('koloft', 'SKILL.md')))
    .map((rel) => fs.readFileSync(path.join(dir, rel), 'utf8'))
    .filter((text) => text.startsWith('---\nname: koloft\n'))
}
