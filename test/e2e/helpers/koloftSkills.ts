import fs from 'fs'
import path from 'path'

export function koloftSkillsUnder(dir: string): string[] {
  return fs
    .readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((rel) => rel.endsWith(path.join('koloft', 'SKILL.md')))
    .map((rel) => fs.readFileSync(path.join(dir, rel), 'utf8'))
    .filter((text) => text.startsWith('---\nname: koloft\n'))
}
