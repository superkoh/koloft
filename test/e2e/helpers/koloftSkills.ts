import fs from 'fs'
import path from 'path'

const DOCS_PLUGIN = 'docs-plugin'

export function docsSkillHandedOut(home: string, claudeArgs: readonly string[]): string[] {
  const copies = fs
    .readdirSync(home, { recursive: true, encoding: 'utf8' })
    .filter((rel) => path.basename(rel) === 'koloft-docs')
    .filter((rel) => !rel.split(path.sep).includes(DOCS_PLUGIN))
  const wire = path.join(home, 'fake-codex-wire.jsonl')
  const codexRoots =
    fs.existsSync(wire) && fs.readFileSync(wire, 'utf8').includes(DOCS_PLUGIN) ? [wire] : []
  return [...copies, ...claudeArgs.filter((a) => a.includes(DOCS_PLUGIN)), ...codexRoots]
}

export function koloftSkillsUnder(dir: string): string[] {
  return fs
    .readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((rel) => rel.endsWith(path.join('koloft', 'SKILL.md')))
    .map((rel) => fs.readFileSync(path.join(dir, rel), 'utf8'))
    .filter((text) => text.startsWith('---\nname: koloft\n'))
}
