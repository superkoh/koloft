import { execFile } from 'child_process'
import fs from 'fs'
import type { GitOut } from './resumePlan'

const REPO_KEY_GIT_TIMEOUT_MS = 5000

const plainGitOut: GitOut = (dir, args, timeoutMs = REPO_KEY_GIT_TIMEOUT_MS) =>
  new Promise((resolve) => {
    execFile('git', ['-C', dir, ...args], { timeout: timeoutMs }, (err, stdout) =>
      resolve(err ? null : stdout)
    )
  })

// PLATFORM§46
export async function repoKeyOf(
  wsPath: string,
  gitOut: GitOut = plainGitOut
): Promise<string | null> {
  const commonDir = (
    await gitOut(wsPath, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  )?.trim()
  if (!commonDir) return null
  try {
    return await fs.promises.realpath(commonDir)
  } catch {
    return null
  }
}

export class GitRepoKeys {
  private keys = new Map<string, string | null>()

  constructor(private gitOut: GitOut = plainGitOut) {}

  known(wsPath: string): string | null {
    return this.keys.get(wsPath) ?? null
  }

  async refresh(wsPaths: string[]): Promise<void> {
    const found = await Promise.all(wsPaths.map((p) => repoKeyOf(p, this.gitOut)))
    this.keys = new Map(wsPaths.map((p, i) => [p, found[i]]))
  }

  workspacesOf(repoKey: string): string[] {
    return [...this.keys].filter(([, key]) => key === repoKey).map(([wsPath]) => wsPath)
  }
}
