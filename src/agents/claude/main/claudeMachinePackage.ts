import type { AgentMachinePackage } from '@core/agent/agentsMain'
import { agent } from '../agent'
import { utilTerminalGuard } from '../../../main/utilTerminalGuard'
import { MACHINE_PLAYWRIGHT_CLI } from '../../../main/remote/playwrightCli'
import { SESSION_BIN_DIR, STATUS_LINE_DIR, UTIL_BIN_DIR } from '../../../main/remote/paths'
import { remoteWrapperScript } from '../../../main/statusline'
import { HOOK_SCRIPT } from './claudeHooks'
import { MACHINE_CLAUDE } from './advisorOnFable'
import { CLAUDE_UTIL_TERMINAL_REFUSAL } from './claudeShim'
import { ENSURE_CLAUDE_MINIMUM_FN } from './claudeMinimum'
import { CLAUDE_BIN_DIR } from './claudeLaunch'

export const claudeMachinePackage: AgentMachinePackage = {
  filesForTheMachinePackage: () => ({
    'hook.sh': HOOK_SCRIPT,
    [`${UTIL_BIN_DIR}${agent.command}`]: utilTerminalGuard(
      agent.command,
      CLAUDE_UTIL_TERMINAL_REFUSAL
    ),
    [`${CLAUDE_BIN_DIR}playwright-cli`]: MACHINE_PLAYWRIGHT_CLI,
    [`${SESSION_BIN_DIR}${agent.command}`]: MACHINE_CLAUDE,
    [`${STATUS_LINE_DIR}run.sh`]: remoteWrapperScript()
  }),
  ensureOnTheMachine: {
    word: undefined,
    functions: ENSURE_CLAUDE_MINIMUM_FN,
    install: `  have claude || official_install claude https://claude.ai/install.sh
  ensure_claude_minimum claude || exit 4`,
    whichNodeWillDo: ''
  }
}
