import type { PreloadIpc } from '@core/ipc'
import type {
  GithubInfo,
  GithubOpenItems,
  GithubTarget,
  PrChecks,
  PrWorktreeResult
} from '@shared/types'
import { CHANNELS } from '../shared/channels'

export interface GithubBridge {
  github: {
    info(root: string, force?: boolean): Promise<GithubInfo | null>
    target(root: string, what: GithubTarget): Promise<string | null>
    onInfo(cb: (root: string, info: GithubInfo) => void): () => void
    checks(root: string, pr: number): Promise<PrChecks>
    failingChecksText(root: string, pr: number): Promise<string | null>
    openItems(root: string): Promise<GithubOpenItems>
    prWorktree(root: string, pr: number, branch: string): Promise<PrWorktreeResult>
  }
}

export const bridge = (ipc: PreloadIpc): GithubBridge => ({
  github: {
    info: (root, force) => ipc.invoke(CHANNELS.info, root, force),
    target: (root, what) => ipc.invoke(CHANNELS.target, root, what),
    onInfo: (cb) => ipc.listen(CHANNELS.info, cb),
    checks: (root, pr) => ipc.invoke(CHANNELS.checks, root, pr),
    failingChecksText: (root, pr) => ipc.invoke(CHANNELS.failingChecksText, root, pr),
    openItems: (root) => ipc.invoke(CHANNELS.openItems, root),
    prWorktree: (root, pr, branch) => ipc.invoke(CHANNELS.prWorktree, root, pr, branch)
  }
})
