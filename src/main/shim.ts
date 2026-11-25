import { app } from 'electron'
import fs from 'fs'
import path from 'path'
import { keychainNamespace, keychainServiceSuffix } from '@shared/types'
import { agyAccountEnv } from '@agents/agy/main/agyAccounts'
import { NEWID_FN, OPEN_SHIM_HEAD, OPEN_SHIM_TARGET } from './openShimScript'
import { CLAUDE_AGENT_SHIM } from './agentShim'
import {
  SUDO_FILES_WHERE_ANY_TERMINAL_IS_THE_OWNERS,
  writeSudoShims
} from '@plugins/passwords/main/sudoShim'
import { ghWrapperScript, gitCredentialHelperScript } from './gitCredentialScripts'
import { NO_USABLE_ACCOUNT } from '@shared/accountUsage'
import {
  SHIM_SCRIPT,
  UTIL_TERMINAL_REFUSES_INTERACTIVE_CLAUDE
} from '@agents/claude/main/claudeShim'
import {
  CODEX_FLAGS_FOLLOWED_BY_A_VALUE,
  CODEX_SUBCOMMANDS_WITHOUT_A_TUI
} from '@agents/codex/main/codexShim'
import {
  AGY_FLAGS_FOLLOWED_BY_A_VALUE,
  AGY_PRINT_OUTSIDE_A_SUBCOMMAND,
  AGY_SUBCOMMANDS_WITHOUT_A_TUI,
  exportsOf
} from '@agents/agy/main/agyShim'
import {
  HELP_OR_VERSION,
  PICK_ACCOUNT_FNS,
  utilTerminalRefusesInteractive
} from '@agents/kit/main/toolTerminalShim'

export interface ShimPaths {
  shimDir: string
  regDir: string
  openDir: string
  pickDir: string
  agentDir: string
  gitHelper: string
  ghWrapper: string
}

const UTIL_TERMINAL_REFUSAL = {
  claude: UTIL_TERMINAL_REFUSES_INTERACTIVE_CLAUDE,
  codex: utilTerminalRefusesInteractive(
    'Codex',
    CODEX_FLAGS_FOLLOWED_BY_A_VALUE,
    CODEX_SUBCOMMANDS_WITHOUT_A_TUI,
    'codex exec · --help · login · mcp'
  ),
  agy: utilTerminalRefusesInteractive(
    'Antigravity',
    AGY_FLAGS_FOLLOWED_BY_A_VALUE,
    AGY_SUBCOMMANDS_WITHOUT_A_TUI,
    'agy -p · --help · mcp',
    '-h|--help|--version|-p|--print|--prompt'
  )
}

type GuardedTool = Exclude<keyof typeof UTIL_TERMINAL_REFUSAL, 'claude'>

const GUARDED_OUTSIDE_THE_CLAUDE_SHIM = (
  Object.keys(UTIL_TERMINAL_REFUSAL) as (keyof typeof UTIL_TERMINAL_REFUSAL)[]
).filter((tool): tool is GuardedTool => tool !== 'claude')

const GUARD_MARK_LINE = ': koloft util guard'
const LINE_2_OF_A_GUARD_WITHOUT_THE_MARK = 'if [ "$KOLOFT_UTIL" = "1" ]; then'

export function utilTerminalGuard(
  bin: keyof typeof UTIL_TERMINAL_REFUSAL,
  accountPick = ''
): string {
  return `#!/bin/sh
${GUARD_MARK_LINE}
${UTIL_TERMINAL_REFUSAL[bin]}
${accountPick}self=$(cd "$(dirname "$0")" && pwd)
IFS=:
set -f
for d in $PATH; do
  [ "$d" = "$self" ] && continue
  [ -x "$d/${bin}" ] || continue
  if head -n 2 "$d/${bin}" 2>/dev/null | grep -q -F -x -e '${GUARD_MARK_LINE}' -e '${LINE_2_OF_A_GUARD_WITHOUT_THE_MARK}'; then continue; fi
  exec "$d/${bin}" "$@"
done
echo "${bin}: not found" >&2
exit 127
`
}

const UTIL_TERMINAL_ACCOUNT: Record<GuardedTool, { reachesTheModel: string; useIt: string }> = {
  // CODEX§15
  codex: {
    reachesTheModel: 'case "$sub" in exec|e|review|apply|a|app-server|mcp-server) pick=1 ;; esac',
    useIt: `unset CODEX_API_KEY OPENAI_API_KEY
    export CODEX_HOME="$phome"`
  },
  // AGY§6 AGY§7
  agy: {
    reachesTheModel: AGY_PRINT_OUTSIDE_A_SUBCOMMAND,
    useIt: `unset GEMINI_API_KEY
    ${exportsOf(agyAccountEnv())}
    if [ "$(pick_field kind)" = "apikey" ]; then
      read_keychain "__KOLOFT_KEYCHAIN_NS__${keychainServiceSuffix('agy-home')}" "$pacct"
      [ -n "$ptok" ] ||
        refuse "could not read the key of $pacct from the Keychain. Try again, or add it again in Settings ▸ Accounts."
      export GEMINI_API_KEY="$ptok"
      ptok=""
    fi
    set -- "--gemini_dir=$phome" "$@"`
  }
}

function utilTerminalAccountPick(bin: GuardedTool): string {
  const { reachesTheModel, useIt } = UTIL_TERMINAL_ACCOUNT[bin]
  return `if [ "$KOLOFT_UTIL" = "1" ]; then
  pick=0
  ${reachesTheModel}
  for a in "$@"; do case "$a" in ${HELP_OR_VERSION}) pick=0 ;; esac; done
  if [ "$pick" = "1" ]; then
${NEWID_FN}
${PICK_ACCOUNT_FNS}
    pick_account ${bin} "${NO_USABLE_ACCOUNT[bin]}"
    phome="$(pick_field home)"
    ${useIt}
    pbanner="$(pick_field banner)"
    pwarn="$(pick_field warning)"
    [ -n "$pbanner" ] && printf '%s\\n' "$pbanner" >&2
    [ -n "$pwarn" ] && printf '%s\\n' "$pwarn" >&2
  fi
fi
`
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

export function setupShim(gitAuthDir: string, koloftGhFolder: string): ShimPaths {
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

  const shimPath = path.join(shimDir, 'claude')
  fs.writeFileSync(shimPath, SHIM_SCRIPT.replaceAll('__KOLOFT_KEYCHAIN_NS__', ns), { mode: 0o755 })
  fs.chmodSync(shimPath, 0o755)

  const openShimPath = path.join(shimDir, 'open')
  fs.writeFileSync(openShimPath, OPEN_SHIM_SCRIPT, { mode: 0o755 })
  fs.chmodSync(openShimPath, 0o755)

  for (const tool of GUARDED_OUTSIDE_THE_CLAUDE_SHIM) {
    const guardPath = path.join(shimDir, tool)
    fs.writeFileSync(
      guardPath,
      utilTerminalGuard(tool, utilTerminalAccountPick(tool)).replaceAll(
        '__KOLOFT_KEYCHAIN_NS__',
        ns
      ),
      { mode: 0o755 }
    )
    fs.chmodSync(guardPath, 0o755)
  }
  fs.rmSync(path.join(shimDir, 'muse'), { force: true })

  const agentShimPath = path.join(shimDir, 'koloft')
  fs.writeFileSync(agentShimPath, CLAUDE_AGENT_SHIM, { mode: 0o755 })
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
