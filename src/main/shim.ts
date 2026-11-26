import { app } from 'electron'
import fs from 'fs'
import path from 'path'
import { keychainNamespace } from '@shared/types'
import type { AgentShimScript } from '@core/agent/agentsMain'
import { OPEN_SHIM_HEAD, OPEN_SHIM_TARGET } from './openShimScript'
import { SHARED_FOLDER_AGENT_SHIM } from './agentShim'
import {
  SUDO_FILES_WHERE_ANY_TERMINAL_IS_THE_OWNERS,
  writeSudoShims
} from '@plugins/passwords/main/sudoShim'
import { ghWrapperScript, gitCredentialHelperScript } from './gitCredentialScripts'

export interface ShimPaths {
  shimDir: string
  regDir: string
  openDir: string
  pickDir: string
  agentDir: string
  gitHelper: string
  ghWrapper: string
}

// CC§12
const OPEN_SHIM_SCRIPT = `${OPEN_SHIM_HEAD}
[ -n "$KOLOFT_TAB_ID" ] && [ -n "$KOLOFT_OPEN_DIR" ] || passthrough "$@"
[ -n "$KOLOFT_PID" ] && kill -0 "$KOLOFT_PID" 2>/dev/null || passthrough "$@"
${OPEN_SHIM_TARGET}
mkdir -p "$KOLOFT_OPEN_DIR" 2>/dev/null || passthrough "$@"
write_drop "$KOLOFT_OPEN_DIR" "$KOLOFT_TAB_ID" || passthrough "$@"
exit 0
`

const STALE_REGISTRATION_AGE_MS = 12 * 60 * 60 * 1000
const STALE_PICK_AGE_MS = 60 * 60 * 1000
const OPEN_REQUEST_STILL_WANTED_MS = 60_000

// ADR-0004
function pruneStale(dir: string, maxAgeMs = STALE_REGISTRATION_AGE_MS): void {
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return
  }
  const now = Date.now()
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const full = path.join(dir, name)
    try {
      if (now - fs.statSync(full).mtimeMs > maxAgeMs) fs.rmSync(full, { force: true })
    } catch {}
  }
}

export function setupShim(
  gitAuthDir: string,
  koloftGhFolder: string,
  agentShims: readonly AgentShimScript[]
): ShimPaths {
  const base = app.getPath('userData')
  const shimDir = path.join(base, 'shim')
  const regDir = path.join(base, 'sessions')
  const openDir = path.join(base, 'opens')
  const pickDir = path.join(base, 'picks')
  const agentDir = path.join(base, 'agent')

  fs.mkdirSync(shimDir, { recursive: true })
  fs.mkdirSync(regDir, { recursive: true })
  fs.mkdirSync(openDir, { recursive: true })
  fs.mkdirSync(pickDir, { recursive: true })
  fs.mkdirSync(agentDir, { recursive: true })
  pruneStale(regDir)
  pruneStale(openDir, OPEN_REQUEST_STILL_WANTED_MS)
  pruneStale(pickDir, STALE_PICK_AGE_MS)
  pruneStale(agentDir, STALE_PICK_AGE_MS)

  const ns = keychainNamespace(app.getName())
  if (!/^[a-z0-9-]+$/.test(ns)) throw new Error(`unsafe keychain namespace: ${ns}`)

  for (const { command, script } of agentShims) {
    const shimPath = path.join(shimDir, command)
    fs.writeFileSync(shimPath, script.replaceAll('__KOLOFT_KEYCHAIN_NS__', ns), { mode: 0o755 })
    fs.chmodSync(shimPath, 0o755)
  }

  const openShimPath = path.join(shimDir, 'open')
  fs.writeFileSync(openShimPath, OPEN_SHIM_SCRIPT, { mode: 0o755 })
  fs.chmodSync(openShimPath, 0o755)

  fs.rmSync(path.join(shimDir, 'muse'), { force: true })

  const agentShimPath = path.join(shimDir, 'koloft')
  fs.writeFileSync(agentShimPath, SHARED_FOLDER_AGENT_SHIM, { mode: 0o755 })
  fs.chmodSync(agentShimPath, 0o755)
  writeSudoShims(shimDir, SUDO_FILES_WHERE_ANY_TERMINAL_IS_THE_OWNERS)

  const gitHelper = path.join(shimDir, 'git-credential-koloft')
  fs.writeFileSync(gitHelper, gitCredentialHelperScript(gitAuthDir), { mode: 0o755 })
  fs.chmodSync(gitHelper, 0o755)

  const ghWrapper = path.join(shimDir, 'gh')
  fs.writeFileSync(ghWrapper, ghWrapperScript(gitAuthDir, koloftGhFolder), { mode: 0o755 })
  fs.chmodSync(ghWrapper, 0o755)

  return { shimDir, regDir, openDir, pickDir, agentDir, gitHelper, ghWrapper }
}
