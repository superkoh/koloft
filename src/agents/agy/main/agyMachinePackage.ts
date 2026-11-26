import type { AgentMachinePackage } from '@core/agent/agentsMain'
import { agent } from '../agent'
import { AGY_INSTALLER_URL } from '../shared/agyInstaller'
import { utilTerminalGuard } from '../../../main/utilTerminalGuard'
import { STATUS_LINE_DIR, UTIL_BIN_DIR } from '../../../main/remote/paths'
import { AGY_HOOK_SCRIPT, AGY_TITLE_SCRIPT } from './agyHooks'
import { AGY_LIST_JS } from './agyStore'
import { AGY_STATUSLINE_JS } from './agyStatusline'
import { AGY_UTIL_TERMINAL_REFUSAL } from './agyShim'
import { ENSURE_AGY_MINIMUM_FN } from './agyMinimum'
import {
  AGY_HOOK_FILE,
  AGY_LIST_FILE,
  AGY_STATUSLINE_FILE,
  AGY_TITLE_FILE,
  agyStatuslineScript
} from './agyTab'

export const agyMachinePackage: AgentMachinePackage = {
  filesForTheMachinePackage: () => ({
    [`${UTIL_BIN_DIR}${agent.command}`]: utilTerminalGuard(
      agent.command,
      AGY_UTIL_TERMINAL_REFUSAL
    ),
    [AGY_HOOK_FILE]: AGY_HOOK_SCRIPT,
    [AGY_TITLE_FILE]: AGY_TITLE_SCRIPT,
    [AGY_LIST_FILE]: AGY_LIST_JS,
    [`${STATUS_LINE_DIR}agy.cjs`]: AGY_STATUSLINE_JS,
    [AGY_STATUSLINE_FILE]: agyStatuslineScript()
  }),
  ensureOnTheMachine: {
    word: agent.command,
    functions: ENSURE_AGY_MINIMUM_FN,
    install: `  # AGY§3
  have agy || official_install agy ${AGY_INSTALLER_URL}
  ensure_agy_minimum agy || exit 4`,
    whichNodeWillDo: `  # AGY§8
  [ "$program" = ${agent.command} ] && { node_runs; return; }`
  }
}
