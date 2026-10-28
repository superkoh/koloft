import fs from 'fs'
import path from 'path'
import { AGENT_GUIDE, AGENT_SKILL_DESCRIPTION, koloftPrompt } from '@shared/agentGuide'
import { writeWholeBeforeVisible } from './jsonDrops'

export const AGENT_PROMPT_FILE = 'koloft-prompt.md'
const SKILLS = 'skills'
export const KOLOFT_SKILL = 'koloft'
export const KOLOFT_SKILL_FILE = `${SKILLS}/${KOLOFT_SKILL}/SKILL.md`

export function agentPluginSkills(pluginDir: string): string {
  return path.join(pluginDir, SKILLS)
}

export function keepKoloftSkillIn(skillsDir: string, on: boolean): void {
  const dir = path.join(skillsDir, KOLOFT_SKILL)
  if (!on) return fs.rmSync(dir, { recursive: true, force: true })
  const file = path.join(dir, 'SKILL.md')
  const text = agentSkillMarkdown()
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === text) return
  fs.mkdirSync(dir, { recursive: true })
  writeWholeBeforeVisible(file, text)
}

export function agentSkillMarkdown(): string {
  return `---\nname: koloft\ndescription: ${JSON.stringify(AGENT_SKILL_DESCRIPTION)}\n---\n\n${AGENT_GUIDE}\n`
}

// CC§13
export function agentPluginFiles(): Record<string, string> {
  return {
    '.claude-plugin/plugin.json': JSON.stringify({
      name: 'koloft',
      description: 'Lets this session use Koloft, the app it runs in.'
    }),
    [KOLOFT_SKILL_FILE]: agentSkillMarkdown(),
    [AGENT_PROMPT_FILE]: `${koloftPrompt('claude')}\n`
  }
}

export function writeAgentPlugin(userData: string): string {
  const dir = path.join(userData, 'agent-plugin')
  for (const [rel, text] of Object.entries(agentPluginFiles())) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    fs.writeFileSync(path.join(dir, rel), text)
  }
  return dir
}
