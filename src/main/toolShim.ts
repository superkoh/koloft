import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import type { BackendId } from '@shared/types'
import { writeAgentShim } from './agentShim'
import {
  CODEX_TMP_DIR,
  OPEN_REQUEST_FOLDER,
  OPEN_SHIM_FOLDER,
  ownedByThisRun,
  removeFoldersLeftByEndedRuns
} from './leftovers'
import { oncePerName, watchAndSweepJsonDrops, type DropHandlerFor } from './jsonDrops'
import { openDropHandler } from './openDrop'
import { removeOpenShim, writeOpenShim, type OpenShim } from './openShimScript'

export interface ToolShimDeps {
  openShimRoot: string
  playwrightBin: string
  gitBin?: string
  ghWrapper: string
}

export interface ToolShim {
  shim: OpenShim
  release(): void
}

// CODEX§12 MUSE§8
export function startToolShim(
  deps: ToolShimDeps,
  opts: {
    backend: BackendId
    userZdotdir?: string
    open: (target: string) => void
    agent?: (dir: string, name: string, raw: unknown) => void
    drop?: DropHandlerFor
  }
): ToolShim {
  removeFoldersLeftByEndedRuns(deps.openShimRoot, OPEN_SHIM_FOLDER)
  removeFoldersLeftByEndedRuns(CODEX_TMP_DIR, OPEN_REQUEST_FOLDER)
  const shim = writeOpenShim(deps.openShimRoot, ownedByThisRun(randomUUID()), opts.userZdotdir)
  try {
    fs.symlinkSync(
      path.join(deps.playwrightBin, 'playwright-cli'),
      path.join(shim.shimDir, 'playwright-cli')
    )
    // PLATFORM§2
    if (deps.gitBin) fs.symlinkSync(path.join(deps.gitBin, 'git'), path.join(shim.shimDir, 'git'))
    fs.symlinkSync(deps.ghWrapper, path.join(shim.shimDir, 'gh'))
    const { agent } = opts
    if (agent) writeAgentShim(shim.shimDir, shim.requestDir, opts.backend)
    const opens = oncePerName(() => openDropHandler(opts.open))
    const dropped = opts.drop && oncePerName(opts.drop)
    const isOpenDrop = (name: string): boolean =>
      !name.startsWith('req-') && !name.startsWith('res-') && !opts.drop?.(name)
    const requests = oncePerName((name) =>
      agent ? (obj): void => agent(shim.requestDir, name, obj) : null
    )
    const handlerFor: DropHandlerFor = (name) => {
      if (name.startsWith('req-')) return requests(name)
      if (name.startsWith('res-')) return null
      return dropped?.(name) ?? opens(name)
    }
    const drops = watchAndSweepJsonDrops(shim.requestDir, handlerFor, undefined, isOpenDrop)
    return {
      shim,
      release: () => {
        drops?.close()
        removeOpenShim(shim)
      }
    }
  } catch (error) {
    removeOpenShim(shim)
    throw error
  }
}
