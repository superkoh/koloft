import fs from 'fs'
import path from 'path'
import type { BackendId } from '../../../src/shared/types'

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

type LogLine = Record<string, unknown>

function logUnder(home: string, name: string): LogLine[] {
  return readIfStillThere(path.join(home, name))
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as LogLine]
      } catch {
        return []
      }
    })
}

const CODEX_INSTRUCTIONS = 'developer_instructions='

export const MUSE_IS_TOLD_ON_A_FIRST_MESSAGE = 'first words'

export function sessionPromptsHandedOut(home: string): Record<BackendId, string[]> {
  return {
    claude: filesNamedUnder(home, 'koloft-prompt.md')
      .map((rel) => readIfStillThere(path.join(home, rel)))
      .filter(Boolean),
    codex: logUnder(home, 'fake-codex-server-calls.jsonl').flatMap((call) =>
      ((call.argv as string[] | undefined) ?? [])
        .filter((a) => a.startsWith(CODEX_INSTRUCTIONS))
        .map((a) => JSON.parse(a.slice(CODEX_INSTRUCTIONS.length)) as string)
    ),
    muse: logUnder(home, 'fake-muse-told.jsonl').map(
      ({ out }) =>
        (JSON.parse(out as string) as { hookSpecificOutput: { additionalContext: string } })
          .hookSpecificOutput.additionalContext
    ),
    agy: logUnder(home, 'fake-agy-injected.jsonl')
      .filter((r) => r.event === 'SessionStart')
      .map((r) => String(r.systemMessage))
  }
}

export const PASSWORDS_IN_THE_SKILL = 'get a password, code or sign-in from the owner'

export const agentPluginSays = (userData: string, words: string): boolean =>
  koloftSkillsUnder(path.join(userData, 'agent-plugin')).some((skill) => skill.includes(words))

export function koloftSkillsUnder(dir: string): string[] {
  return pathsUnderWhileTheAppWrites(dir)
    .filter((rel) => rel.endsWith(path.join('koloft', 'SKILL.md')))
    .map((rel) => readIfStillThere(path.join(dir, rel)))
    .filter((text) => text.startsWith('---\nname: koloft\n'))
}
