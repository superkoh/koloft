import type { MainIpc } from '@core/ipc'
import type {
  GithubInfo,
  GithubOpenItems,
  GithubTarget,
  PrChecks,
  PrWorktreeResult
} from '@shared/types'
import { CHANNELS } from '../shared/channels'

export interface Lookup {
  info(
    root: string,
    opts: { force?: boolean }
  ): Promise<{ now: GithubInfo | null; settled: Promise<GithubInfo> | null }>
  target(root: string, what: GithubTarget): Promise<string | null>
  checks(root: string, pr: number): Promise<PrChecks>
  failingChecksText(root: string, pr: number): Promise<string | null>
  openItems(root: string): Promise<GithubOpenItems>
}

export interface ChannelDeps {
  lookup(root: string): Lookup
  prWorktree(root: string, pr: number, branch: string): Promise<PrWorktreeResult>
}

const BAD_REQUEST: PrWorktreeResult = { ok: false, reason: 'bad request' }

const TARGETS: readonly unknown[] = [
  'repo',
  'issues',
  'pulls',
  'pr',
  'compare'
] satisfies GithubTarget[]

export function registerChannels(ipc: MainIpc, deps: ChannelDeps): void {
  ipc.handle(CHANNELS.info, async (root: unknown, force: unknown) => {
    if (typeof root !== 'string' || !root) return null
    const { now, settled } = await deps.lookup(root).info(root, { force: force === true })
    if (settled)
      void settled.then(
        (info) => ipc.push(CHANNELS.info, root, info),
        () => {}
      )
    return now
  })
  ipc.handle(CHANNELS.target, (root: unknown, what: unknown) => {
    if (typeof root !== 'string' || !root) return null
    if (!TARGETS.includes(what)) return null
    return deps.lookup(root).target(root, what as GithubTarget)
  })
  ipc.handle(CHANNELS.checks, (root: unknown, pr: unknown): Promise<PrChecks> => {
    if (typeof root !== 'string' || !root || !Number.isInteger(pr)) {
      return Promise.resolve({ state: 'failed' })
    }
    return deps.lookup(root).checks(root, pr as number)
  })
  ipc.handle(CHANNELS.failingChecksText, (root: unknown, pr: unknown) => {
    if (typeof root !== 'string' || !root || !Number.isInteger(pr)) return null
    return deps.lookup(root).failingChecksText(root, pr as number)
  })
  ipc.handle(CHANNELS.openItems, (root: unknown) => {
    if (typeof root !== 'string' || !root) return { state: 'no-repo' }
    return deps.lookup(root).openItems(root)
  })
  ipc.handle(CHANNELS.prWorktree, async (root: unknown, pr: unknown, branch: unknown) => {
    if (typeof root !== 'string' || !root || !Number.isInteger(pr) || typeof branch !== 'string')
      return BAD_REQUEST
    return deps.prWorktree(root, pr as number, branch)
  })
}
