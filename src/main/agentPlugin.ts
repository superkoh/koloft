import fs from 'fs'
import path from 'path'
import { AGENT_GUIDE, AGENT_SKILL_DESCRIPTION } from '@shared/agentGuide'

function agentSkillMarkdown(): string {
  return `---\nname: koloft\ndescription: ${JSON.stringify(AGENT_SKILL_DESCRIPTION)}\n---\n\n${AGENT_GUIDE}\n`
}

// CC§13
export function writeAgentPlugin(userData: string): string {
  const dir = path.join(userData, 'agent-plugin')
  fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'skills', 'koloft'), { recursive: true })
  fs.writeFileSync(
    path.join(dir, '.claude-plugin', 'plugin.json'),
    JSON.stringify({
      name: 'koloft',
      description: 'Lets this session use Koloft, the app it runs in.'
    })
  )
  fs.writeFileSync(path.join(dir, 'skills', 'koloft', 'SKILL.md'), agentSkillMarkdown())
  return dir
}
