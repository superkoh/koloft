import { execFile } from 'child_process'
import fs from 'fs'
import { isRemoteKey } from '@shared/remoteKey'
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

  private otherFolders = new Map<string, string>()

  known(wsPath: string): string | null {
    return this.keys.get(wsPath) ?? this.otherFolders.get(wsPath) ?? null
  }

  async resolve(dir: string): Promise<string | null> {
    const known = this.known(dir)
    if (known || isRemoteKey(dir)) return known
    const found = await repoKeyOf(dir, this.gitOut)
    if (found) this.otherFolders.set(dir, found)
    return found
  }

  async refresh(wsPaths: string[]): Promise<void> {
    const local = wsPaths.filter((p) => !isRemoteKey(p))
    const found = await Promise.all(local.map((p) => repoKeyOf(p, this.gitOut)))
    this.keys = new Map(local.map((p, i) => [p, found[i]]))
  }

  set(wsPath: string, repoKey: string): void {
    this.keys.set(wsPath, repoKey)
  }

  workspacesOf(repoKey: string): string[] {
    return [...this.keys].filter(([, key]) => key === repoKey).map(([wsPath]) => wsPath)
  }
}
