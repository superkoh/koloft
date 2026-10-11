import fs from 'fs'
import path from 'path'
import { AGENT_GUIDE, AGENT_SKILL_DESCRIPTION } from '@shared/agentGuide'

function agentSkillMarkdown(): string {
  return `---\nname: koloft\ndescription: ${JSON.stringify(AGENT_SKILL_DESCRIPTION)}\n---\n\n${AGENT_GUIDE}\n`
}

// CC§13
export function agentPluginFiles(): Record<string, string> {
  return {
    '.claude-plugin/plugin.json': JSON.stringify({
      name: 'koloft',
      description: 'Lets this session use Koloft, the app it runs in.'
    }),
    'skills/koloft/SKILL.md': agentSkillMarkdown()
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
