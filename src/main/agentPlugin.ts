import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { AGENT_GUIDE, AGENT_SKILL_DESCRIPTION, koloftPrompt } from '@shared/agentGuide'
import { writePrivateAtomically } from './privateFile'
import DOCS_SKILL_MD from './docsSkill/SKILL.md?raw'
import CORE_MD from './docsSkill/references/core.md?raw'
import DIAGRAMS_MD from './docsSkill/references/diagrams.md?raw'
import GENERAL_MD from './docsSkill/references/general.md?raw'
import PRODUCT_MD from './docsSkill/references/product.md?raw'
import SYSTEM_DESIGN_MD from './docsSkill/references/system-design.md?raw'
import TECHNICAL_MD from './docsSkill/references/technical.md?raw'
import UI_DESIGN_MD from './docsSkill/references/ui-design.md?raw'

export const AGENT_PROMPT_FILE = 'koloft-prompt.md'
const SKILLS = 'skills'
export const KOLOFT_SKILL = 'koloft'
export const KOLOFT_DOCS_SKILL = 'koloft-docs'
export const KOLOFT_SKILLS = [KOLOFT_DOCS_SKILL, KOLOFT_SKILL]

type Files = Record<string, string>

const DOCS_SKILL_FILES: Files = {
  'SKILL.md': DOCS_SKILL_MD,
  'references/core.md': CORE_MD,
  'references/diagrams.md': DIAGRAMS_MD,
  'references/general.md': GENERAL_MD,
  'references/product.md': PRODUCT_MD,
  'references/system-design.md': SYSTEM_DESIGN_MD,
  'references/technical.md': TECHNICAL_MD,
  'references/ui-design.md': UI_DESIGN_MD
}

export function pluginSkills(pluginDir: string): string {
  return path.join(pluginDir, SKILLS)
}

export function pluginSkillDir(skill: string): string {
  return `${SKILLS}/${skill}`
}

function holdsExactly(dir: string, files: Files): boolean {
  let names: string[]
  try {
    names = fs
      .readdirSync(dir, { recursive: true, encoding: 'utf8' })
      .filter((name) => fs.statSync(path.join(dir, name)).isFile())
  } catch {
    return false
  }
  return (
    names.length === Object.keys(files).length &&
    names.every((name) => {
      const text = files[name.split(path.sep).join('/')]
      return text !== undefined && fs.readFileSync(path.join(dir, name), 'utf8') === text
    })
  )
}

function keepFolder(dir: string, files: Files): void {
  if (holdsExactly(dir, files)) return
  const next = `${dir}.new-${process.pid}`
  fs.rmSync(next, { recursive: true, force: true })
  for (const [rel, text] of Object.entries(files)) {
    const file = path.join(next, rel)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, text)
  }
  fs.rmSync(dir, { recursive: true, force: true })
  fs.renameSync(next, dir)
}

const skillsCheckedThisRun = new Set<string>()

function keepSkill(dir: string, files: Files): void {
  if (skillsCheckedThisRun.has(dir) && fs.existsSync(path.join(dir, 'SKILL.md'))) return
  keepFolder(dir, files)
  skillsCheckedThisRun.add(dir)
}

export function keepSkillsIn(skillsDir: string, koloftOn: boolean): void {
  keepSkill(path.join(skillsDir, KOLOFT_DOCS_SKILL), DOCS_SKILL_FILES)
  const koloft = path.join(skillsDir, KOLOFT_SKILL)
  if (koloftOn) return keepSkill(koloft, koloftSkillFiles())
  fs.rmSync(koloft, { recursive: true, force: true })
  skillsCheckedThisRun.delete(koloft)
}

function koloftSkillFiles(): Files {
  return {
    'SKILL.md': `---\nname: koloft\ndescription: ${JSON.stringify(AGENT_SKILL_DESCRIPTION)}\n---\n\n${AGENT_GUIDE}\n`
  }
}

function pluginFiles(name: string, description: string, skill: Files): Files {
  const files: Files = { '.claude-plugin/plugin.json': JSON.stringify({ name, description }) }
  for (const [rel, text] of Object.entries(skill)) files[`${pluginSkillDir(name)}/${rel}`] = text
  return files
}

// CC§13
export function agentPluginFiles(): Files {
  return {
    ...pluginFiles(
      KOLOFT_SKILL,
      'Lets this session use Koloft, the app it runs in.',
      koloftSkillFiles()
    ),
    [AGENT_PROMPT_FILE]: `${koloftPrompt('claude')}\n`
  }
}

// CC§13
export function docsPluginFiles(): Files {
  return pluginFiles(
    KOLOFT_DOCS_SKILL,
    'How this session writes documents for its owner.',
    DOCS_SKILL_FILES
  )
}

export const claudeProjectPrompt = (rules: string): string => `${koloftPrompt('claude', rules)}\n`

export function projectPromptFile(userData: string, rules: string): string | undefined {
  const text = claudeProjectPrompt(rules)
  const name = crypto.createHash('sha256').update(text).digest('hex').slice(0, 16)
  const file = path.join(userData, 'agent-prompts', `${name}.md`)
  try {
    if (!fs.existsSync(file)) {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      writePrivateAtomically(file, text)
    }
    return file
  } catch (err) {
    console.error('[koloft] could not write the project prompt', err)
    return undefined
  }
}

export function writeAgentPlugin(userData: string): string {
  const dir = path.join(userData, 'agent-plugin')
  keepFolder(dir, agentPluginFiles())
  return dir
}

export function writeDocsPlugin(userData: string): string {
  const dir = path.join(userData, 'docs-plugin')
  keepFolder(dir, docsPluginFiles())
  return dir
}
