import fs from 'fs'
import path from 'path'

const DOCS_PLUGIN = 'docs-plugin'

function pathsUnderWhileTheAppWrites(dir: string, rel = ''): string[] {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true })
  } catch {
    return []
  }
  return entries.flatMap((e) => {
    const child = path.join(rel, e.name)
    return e.isDirectory() ? [child, ...pathsUnderWhileTheAppWrites(dir, child)] : [child]
  })
}

function readIfStillThere(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

export function docsSkillHandedOut(home: string, claudeArgs: readonly string[]): string[] {
  const copies = pathsUnderWhileTheAppWrites(home)
    .filter((rel) => path.basename(rel) === 'koloft-docs')
    .filter((rel) => !rel.split(path.sep).includes(DOCS_PLUGIN))
  const wire = path.join(home, 'fake-codex-wire.jsonl')
  const codexRoots = readIfStillThere(wire).includes(DOCS_PLUGIN) ? [wire] : []
  return [...copies, ...claudeArgs.filter((a) => a.includes(DOCS_PLUGIN)), ...codexRoots]
}

export function filesNamedUnder(dir: string, name: string): string[] {
  return pathsUnderWhileTheAppWrites(dir).filter((rel) => path.basename(rel) === name)
}

export function claudePromptFilesUnder(dir: string): string[] {
  return filesNamedUnder(dir, 'koloft-prompt.md')
    .map((rel) => readIfStillThere(path.join(dir, rel)))
    .filter(Boolean)
}

export function koloftSkillsUnder(dir: string): string[] {
  return pathsUnderWhileTheAppWrites(dir)
    .filter((rel) => rel.endsWith(path.join('koloft', 'SKILL.md')))
    .map((rel) => readIfStillThere(path.join(dir, rel)))
    .filter((text) => text.startsWith('---\nname: koloft\n'))
}
