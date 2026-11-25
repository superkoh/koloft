import path from 'path'
import { encodeCwd } from '@shared/cwdKey'
import type { FolderSplitByWorkspace } from '@core/agent/mirrorFolders'
import { remoteBase } from '../../../main/remote/paths'

export const REMOTE_CLAUDE_PROJECTS = '.claude/projects'
const PROJECTS_MIRROR = 'projects'

export function mirrorProjectsRoot(userData: string, host: string): string {
  return path.join(remoteBase(userData, host), PROJECTS_MIRROR)
}

// CC§2 CC§4 PLATFORM§34
function projectFlags(slugs: string[]): string[] {
  return [
    '--inplace',
    '-m',
    '--delete',
    ...slugs.flatMap((slug) => {
      const project = `/${slug}*`
      return [
        `--include=${project}/`,
        `--include=${project}/*.jsonl`,
        `--include=${project}/*.title`,
        `--include=${project}/*/`,
        `--include=${project}/*/**`
      ]
    }),
    '--exclude=*'
  ]
}

export function claudeRecordsFolder(landing: string): FolderSplitByWorkspace {
  return {
    from: REMOTE_CLAUDE_PROJECTS,
    to: path.join(landing, PROJECTS_MIRROR),
    holds: 'records',
    subfolderOf: encodeCwd,
    flagsFor: projectFlags
  }
}
