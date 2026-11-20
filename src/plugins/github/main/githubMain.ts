import type { Commands } from '@core/commands'
import type { GhResult } from '@core/gh'
import { isUnderAnyRoot } from '@core/isUnderAnyRoot'
import { pluginStateOf } from '@core/switches'
import { formatRemoteKey, parseRemoteKey } from '@shared/remoteKey'
import { plugin } from '../plugin'
import { GithubCountsSweep, githubCountsData } from './countsSweep'
import { registerGithubCommand, repoFlagOf } from './ghVerb'
import { githubLookups, type GithubLookup, type RepoSource } from './lookup'

const NO_GITHUB_ACCOUNT_ON_THE_MACHINE =
  'Koloft has picked no GitHub account for this workspace on its machine; pick one in Settings ▸ Accounts ▸ Git, or run gh there yourself.'

const SWEEP_AT_ONCE_ON_TURNING_ON_MS = 0

export interface GithubMainDeps {
  commands: Commands
  repos(wsPath: string): RepoSource
  pinnedWorkspaces(): Promise<{ path: string; missing: boolean }[]>
  restampRows(): void
  browserCookies(domain: string): Promise<{ name: string; value: string }[]>
  accounts: {
    ready(): Promise<void>
    picked(root: string): string | undefined
    ghEnv(root: string): Promise<NodeJS.ProcessEnv | undefined>
    ghEnvForRepo(repo: string | undefined, pinned: string[]): Promise<NodeJS.ProcessEnv | undefined>
    machineGh(root: string, args: string[]): Promise<GhResult | null>
  }
  ghOnThisMac(
    args: string[],
    env: NodeJS.ProcessEnv | undefined,
    cwd: string
  ): Promise<{ ok: boolean; out: string }>
  butlerSide(tabId: string): boolean
  workspaceOfTab(tabId: string): string | undefined
  pinnedPaths(): string[]
}

export interface GithubMain {
  lookup(root: string): GithubLookup
  rowData(wsPath: string): Readonly<Record<string, unknown>> | undefined
  sweepNow(): void
  followSwitch(): void
}

// PLATFORM§32
async function signedInOnTheWorkbenchBrowser(d: GithubMainDeps): Promise<boolean> {
  try {
    const jar = await d.browserCookies('github.com')
    return jar.some(
      (c) => (c.name === 'logged_in' && c.value === 'yes') || c.name === 'user_session'
    )
  } catch {
    return false
  }
}

export function startGithubMain(d: GithubMainDeps): GithubMain {
  const lookups = githubLookups({
    // PLATFORM§1
    countedAs: (root) => d.accounts.picked(root),
    signedIn: () => signedInOnTheWorkbenchBrowser(d)
  })
  const lookup = (root: string): GithubLookup => lookups(d.repos(root))
  const counts = new GithubCountsSweep({
    workspaces: d.pinnedWorkspaces,
    openCounts: (wsPath) => lookup(wsPath).openCounts(wsPath),
    onChange: d.restampRows
  })

  registerGithubCommand(d.commands, {
    writesInEnglishOnly: d.butlerSide,
    // PLATFORM§1 ADR-0036
    run: async (args, tabId, cwd) => {
      await d.accounts.ready()
      const workspace = d.butlerSide(tabId) ? undefined : d.workspaceOfTab(tabId)
      if (!workspace) {
        const env = await d.accounts.ghEnvForRepo(repoFlagOf(args), d.pinnedPaths())
        return d.ghOnThisMac(args, env, cwd)
      }
      const remote = parseRemoteKey(workspace)
      if (!remote) return d.ghOnThisMac(args, await d.accounts.ghEnv(workspace), cwd)
      const inItsFolder = isUnderAnyRoot(cwd, [remote.path])
        ? formatRemoteKey(remote.host, cwd)
        : workspace
      const onMachine = await d.accounts.machineGh(inItsFolder, args)
      if (!onMachine) return { ok: false, out: NO_GITHUB_ACCOUNT_ON_THE_MACHINE }
      return onMachine.code === 0
        ? { ok: true, out: onMachine.stdout }
        : { ok: false, out: onMachine.stderr.trim() || onMachine.stdout }
    }
  })

  let running: boolean | undefined
  const followSwitch = (): void => {
    const on = pluginStateOf(plugin.id).on
    if (on === running) return
    const first = running === undefined
    running = on
    if (!on) counts.stop()
    else if (first) counts.start()
    else counts.start(SWEEP_AT_ONCE_ON_TURNING_ON_MS)
  }

  return {
    lookup,
    rowData: (wsPath) => githubCountsData(counts.get(wsPath)),
    sweepNow: () => void counts.sweep(),
    followSwitch
  }
}
