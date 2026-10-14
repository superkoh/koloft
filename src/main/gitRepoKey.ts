import { execFile } from 'child_process'
import fs from 'fs'
import { isRemoteKey, parseRemoteKey } from '@shared/remoteKey'
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

export type RemoteRepoKeys = (machine: string, paths: string[]) => Promise<(string | null)[]>

export class GitRepoKeys {
  private keys = new Map<string, string | null>()

  constructor(
    private gitOut: GitOut = plainGitOut,
    private remote: RemoteRepoKeys = async (_, paths) => paths.map(() => null)
  ) {}

  private async keysOf(wsPaths: string[]): Promise<(string | null)[]> {
    const out: (string | null)[] = wsPaths.map(() => null)
    const byMachine = new Map<string, number[]>()
    await Promise.all(
      wsPaths.map(async (p, i) => {
        const remote = parseRemoteKey(p)
        if (!remote) out[i] = await repoKeyOf(p, this.gitOut)
        else byMachine.set(remote.host, [...(byMachine.get(remote.host) ?? []), i])
      })
    )
    await Promise.all(
      [...byMachine].map(async ([machine, at]) => {
        const found = await this.remote(
          machine,
          at.map((i) => parseRemoteKey(wsPaths[i])!.path)
        )
        at.forEach((i, n) => (out[i] = found[n] ?? null))
      })
    )
    return out
  }

  private otherFolders = new Map<string, string>()

  known(wsPath: string): string | null {
    return this.keys.get(wsPath) ?? this.otherFolders.get(wsPath) ?? null
  }

  async resolve(dir: string): Promise<string | null> {
    const known = this.known(dir)
    if (known) return known
    const [found] = await this.keysOf([dir])
    if (found) this.otherFolders.set(dir, found)
    return found
  }

  async refresh(wsPaths: string[]): Promise<void> {
    const keptRemote = (p: string): string | null => (isRemoteKey(p) && this.keys.get(p)) || null
    const ask = wsPaths.filter((p) => !keptRemote(p))
    const found = await this.keysOf(ask)
    const asked = new Map(ask.map((p, i) => [p, found[i]]))
    this.keys = new Map(wsPaths.map((p) => [p, keptRemote(p) ?? asked.get(p) ?? null]))
  }

  set(wsPath: string, repoKey: string): void {
    this.keys.set(wsPath, repoKey)
  }

  workspacesOf(repoKey: string): string[] {
    return [...this.keys].filter(([, key]) => key === repoKey).map(([wsPath]) => wsPath)
  }
}
