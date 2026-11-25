import path from 'path'
import type { AgentCatalog, AgentOneShot, OneShotTarget } from '@core/agent/agentsMain'
import type { ListedModel } from '@shared/sessionPicks'
import { readAgyModels } from './agyAccounts'
import { withSystemFirst, type ModelAndEffort } from '@core/assistModels'
import { foldersUpToRoot, jsonServers, textOrNull, textsIn } from '../../../main/mcpServers'

// AGY§20 AGY§21
const AGY_ONE_SHOT = (task: string, launch: ModelAndEffort): string[] => [
  '-p',
  task,
  '--output-format',
  'json',
  ...(launch.model ? ['--model', launch.model] : []),
  ...(launch.effort ? ['--effort', launch.effort] : [])
]

// AGY§20
function agyResponse(out: string): string | null {
  try {
    const result = JSON.parse(out) as { status?: unknown; response?: unknown }
    return result.status === 'SUCCESS' && typeof result.response === 'string'
      ? result.response
      : null
  } catch {
    return null
  }
}

export const agyOneShot: AgentOneShot = {
  argv: (job, launch) => AGY_ONE_SHOT(withSystemFirst(job), launch),
  stdin: () => '',
  answerFrom: agyResponse,
  sometimesAnswersLate: false,
  // AGY§21
  saysItHasNoSuchModel: /invalid model selection/
}

async function listedModelsWith(
  oneShotTarget: () => Promise<OneShotTarget | null>
): Promise<ListedModel[] | undefined> {
  const target = await oneShotTarget()
  if (!target) return undefined
  return readAgyModels(target.binary, target.env, target.args ?? []).finally(() => target.done())
}

// AGY§30
export const AGY_PROJECT_MCP_FILE = '.agents/mcp_config.json'

// AGY§30
export async function foldersUpToRepoTop(
  folder: string,
  holdsGit: (folder: string) => Promise<boolean>
): Promise<string[]> {
  const up = foldersUpToRoot(folder)
  const top = (await Promise.all(up.map(holdsGit))).indexOf(true)
  return top < 0 ? [folder] : up.slice(0, top + 1)
}

export const agyCatalog = (
  ownersGemini: () => string,
  holdsGit: (folder: string) => Promise<boolean>,
  oneShotTarget: () => Promise<OneShotTarget | null>
): AgentCatalog => ({
  // AGY§21
  listedModels: () => listedModelsWith(oneShotTarget),
  oneShot: agyOneShot,
  // AGY§4 AGY§31
  moreSkillFoldersEveryAccountReadsOnThisMac: () => [],
  // AGY§30
  mcpServersOn: async (folders) => {
    const walks = await Promise.all(
      folders.map(async (onlyIn) => ({
        onlyIn,
        folders: await foldersUpToRepoTop(onlyIn, holdsGit)
      }))
    )
    const [own, projectFiles] = await Promise.all([
      textOrNull(path.join(ownersGemini(), 'config', 'mcp_config.json')),
      textsIn(walks, AGY_PROJECT_MCP_FILE)
    ])
    return jsonServers('agy', [{ text: own }, ...projectFiles])
  }
})
