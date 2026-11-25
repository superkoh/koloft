import type { AgentTools } from '@core/agent/agentsMain'
import {
  utilTerminalAccountPick,
  utilTerminalRefusesInteractive,
  type ToolTerminalAccount
} from '@agents/kit/main/toolTerminalShim'
import { utilTerminalGuard } from '../../../main/utilTerminalGuard'

// CODEX§18
const CODEX_FLAGS_FOLLOWED_BY_A_VALUE = [
  '-c',
  '--config',
  '--enable',
  '--disable',
  '--remote',
  '--remote-auth-token-env',
  '-i',
  '--image',
  '-m',
  '--model',
  '--local-provider',
  '-p',
  '--profile',
  '-s',
  '--sandbox',
  '-C',
  '--cd',
  '--add-dir',
  '-a',
  '--ask-for-approval'
].join('|')

// CODEX§18
const CODEX_SUBCOMMANDS_WITHOUT_A_TUI = [
  'exec',
  'e',
  'review',
  'login',
  'logout',
  'mcp',
  'plugin',
  'mcp-server',
  'app-server',
  'remote-control',
  'app',
  'completion',
  'update',
  'doctor',
  'sandbox',
  'debug',
  'apply',
  'a',
  'queue',
  'archive',
  'delete',
  'migrate-rollouts',
  'migrate-nfs-db',
  'unarchive',
  'exec-server',
  'features',
  'help'
].join('|')

export const CODEX_SANDBOX_IS_READ_ONLY =
  'koloft: this sandbox is read-only, so koloft cannot run here.'

export const CODEX_UTIL_TERMINAL_REFUSAL = utilTerminalRefusesInteractive(
  'Codex',
  CODEX_FLAGS_FOLLOWED_BY_A_VALUE,
  CODEX_SUBCOMMANDS_WITHOUT_A_TUI,
  'codex exec · --help · login · mcp'
)

// CODEX§15
const CODEX_UTIL_TERMINAL_ACCOUNT: ToolTerminalAccount = {
  reachesTheModel: 'case "$sub" in exec|e|review|apply|a|app-server|mcp-server) pick=1 ;; esac',
  useIt: `unset CODEX_API_KEY OPENAI_API_KEY
    export CODEX_HOME="$phome"`
}

export const codexTools: AgentTools = {
  shimScript: () =>
    utilTerminalGuard(
      'codex',
      CODEX_UTIL_TERMINAL_REFUSAL,
      utilTerminalAccountPick('codex', CODEX_UTIL_TERMINAL_ACCOUNT)
    )
}
