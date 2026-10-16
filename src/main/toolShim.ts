import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import { writeAgentShim } from './agentShim'
import { ownedByThisRun } from './leftovers'
import { oncePerName, watchJsonDrops, type DropHandlerFor } from './jsonDrops'
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
    userZdotdir?: string
    open: (target: string) => void
    agent?: (dir: string, name: string, raw: unknown) => void
    drop?: DropHandlerFor
  }
): ToolShim {
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
    if (agent) writeAgentShim(shim.shimDir, shim.requestDir)
    const opens = oncePerName(() => openDropHandler(opts.open))
    const drops = watchJsonDrops(shim.requestDir, (name) => {
      if (name.startsWith('req-'))
        return agent ? (obj): void => agent(shim.requestDir, name, obj) : null
      if (name.startsWith('res-')) return null
      return opts.drop?.(name) ?? opens(name)
    })
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
