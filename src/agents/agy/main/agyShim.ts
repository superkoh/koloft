import { keychainServiceSuffix } from '@shared/types'
import type { AgentTools } from '@core/agent/agentsMain'
import { agent } from '../agent'
import {
  utilTerminalAccountPick,
  utilTerminalRefusesInteractive,
  type ToolTerminalAccount
} from '@agents/kit/main/toolTerminalShim'
import { utilTerminalGuard } from '../../../main/utilTerminalGuard'
import { agyAccountEnv } from './agyAccounts'

// AGY§1
const AGY_FLAGS_FOLLOWED_BY_A_VALUE = [
  '--add-dir',
  '--agent',
  '--conversation',
  '--effort',
  '-i',
  '--prompt-interactive',
  '--input-format',
  '--json-schema',
  '--log-file',
  '--mode',
  '--model',
  '--output-format',
  '--print-timeout',
  '--project'
].join('|')

// AGY§1
const AGY_SUBCOMMANDS_WITHOUT_A_TUI = [
  'agent',
  'agents',
  'changelog',
  'help',
  'install',
  'mcp',
  'mic-serve',
  'models',
  'plugin',
  'plugins',
  'remote-control',
  'update'
].join('|')

const exportsOf = (env: Record<string, string>): string =>
  `export ${Object.entries(env)
    .map(([k, v]) => `${k}="${v}"`)
    .join(' ')}`

const AGY_PRINT_OUTSIDE_A_SUBCOMMAND = `valflag=0
  for a in "$@"; do
    if [ "$valflag" = "1" ]; then valflag=0; continue; fi
    case "$a" in
      -p|--print|--prompt) pick=1 ;;
      ${AGY_FLAGS_FOLLOWED_BY_A_VALUE}) valflag=1 ;;
    esac
  done
  case "$sub" in ${AGY_SUBCOMMANDS_WITHOUT_A_TUI}) pick=0 ;; esac`

export const AGY_UTIL_TERMINAL_REFUSAL = utilTerminalRefusesInteractive(
  'Antigravity',
  AGY_FLAGS_FOLLOWED_BY_A_VALUE,
  AGY_SUBCOMMANDS_WITHOUT_A_TUI,
  'agy -p · --help · mcp',
  '-h|--help|--version|-p|--print|--prompt'
)

// AGY§6 AGY§7
const AGY_UTIL_TERMINAL_ACCOUNT: ToolTerminalAccount = {
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

export const agyTools: AgentTools = {
  shimScript: () =>
    utilTerminalGuard(
      agent.command,
      AGY_UTIL_TERMINAL_REFUSAL,
      utilTerminalAccountPick('agy', AGY_UTIL_TERMINAL_ACCOUNT)
    )
}
