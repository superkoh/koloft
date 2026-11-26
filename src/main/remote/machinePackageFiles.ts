import fs from 'fs'
import path from 'path'
import { STATUS_RELAY_FILE, STATUS_RELAY_PY } from './statusRelay'
import { MACHINE_PLAYWRIGHT_CLI } from './playwrightCli'
import { ENSURE_SH, TMUX_CONF, UTIL_BASH_LOGIN, UTIL_BASH_LOGIN_FILE, UTIL_SH } from './install'
import { AGENT_PLUGIN_DIR, CLAUDE_BIN_DIR, DOCS_PLUGIN_DIR } from './launch'
import { SESSION_BIN_DIR, UTIL_BIN_DIR } from './paths'
import { utilTerminalGuard } from '../utilTerminalGuard'
import { machineGhWrapperScript } from '../gitCredentialScripts'
import { REMOTE_AGENT_SHIM } from '../agentShim'
import { REMOTE_OPEN_SHIM } from '../openShimScript'
import { bundlePath, DEFAULT_THEME, remoteWrapperScript } from '../statusline'
import { agentPluginFiles, docsPluginFiles } from '../agentPlugin'
import { HOOK_SCRIPT } from '@agents/claude/main/claudeHooks'
import { CODEX_REPLY_LANGUAGE_SCRIPT } from '@agents/codex/main/codexHooks'
import { AGY_STATUSLINE_JS } from '@agents/agy/main/agyStatusline'
import { passwordsOn } from '@plugins/passwords/api'
import { SUDO_SHIM_FILES } from '@plugins/passwords/main/sudoShim'
import { MACHINE_CLAUDE } from '@agents/claude/main/advisorOnFable'
import { CLAUDE_UTIL_TERMINAL_REFUSAL } from '@agents/claude/main/claudeShim'
import { CODEX_UTIL_TERMINAL_REFUSAL } from '@agents/codex/main/codexShim'
import { AGY_UTIL_TERMINAL_REFUSAL } from '@agents/agy/main/agyShim'
import {
  ENSURE_CODEX_FILE,
  ENSURE_CODEX_SH,
  replyLanguageFiles
} from '@agents/codex/main/codexMachine'
import { AGY_LIST_JS } from '@agents/agy/main/agyStore'
import { AGY_HOOK_SCRIPT, AGY_TITLE_SCRIPT } from '@agents/agy/main/agyHooks'
import {
  AGY_HOOK_FILE,
  AGY_LIST_FILE,
  AGY_STATUSLINE_FILE,
  AGY_TITLE_FILE,
  agyStatuslineScript
} from '@agents/agy/main/agyTab'

export function machinePackageFiles(): Record<string, string | Buffer> {
  const pkgFiles: Record<string, string | Buffer> = {
    'ensure.sh': ENSURE_SH,
    [ENSURE_CODEX_FILE]: ENSURE_CODEX_SH,
    ...replyLanguageFiles(CODEX_REPLY_LANGUAGE_SCRIPT),
    'hook.sh': HOOK_SCRIPT,
    'tmux.conf': TMUX_CONF,
    'util.sh': UTIL_SH,
    [UTIL_BASH_LOGIN_FILE]: UTIL_BASH_LOGIN,
    [`${UTIL_BIN_DIR}claude`]: utilTerminalGuard('claude', CLAUDE_UTIL_TERMINAL_REFUSAL),
    [`${UTIL_BIN_DIR}codex`]: utilTerminalGuard('codex', CODEX_UTIL_TERMINAL_REFUSAL),
    [`${UTIL_BIN_DIR}agy`]: utilTerminalGuard('agy', AGY_UTIL_TERMINAL_REFUSAL),
    [`${SESSION_BIN_DIR}koloft`]: REMOTE_AGENT_SHIM,
    [`${SESSION_BIN_DIR}open`]: REMOTE_OPEN_SHIM,
    [`${SESSION_BIN_DIR}gh`]: machineGhWrapperScript(),
    [`${CLAUDE_BIN_DIR}playwright-cli`]: MACHINE_PLAYWRIGHT_CLI,
    [`${SESSION_BIN_DIR}claude`]: MACHINE_CLAUDE,
    [`${UTIL_BIN_DIR}gh`]: machineGhWrapperScript(),
    [STATUS_RELAY_FILE]: STATUS_RELAY_PY,
    [AGY_HOOK_FILE]: AGY_HOOK_SCRIPT,
    [AGY_TITLE_FILE]: AGY_TITLE_SCRIPT,
    [AGY_LIST_FILE]: AGY_LIST_JS
  }
  if (passwordsOn())
    for (const [name, text] of Object.entries(SUDO_SHIM_FILES))
      pkgFiles[`${SESSION_BIN_DIR}${name}`] = text
  for (const [rel, text] of Object.entries(agentPluginFiles()))
    pkgFiles[`${AGENT_PLUGIN_DIR}${rel}`] = text
  for (const [rel, text] of Object.entries(docsPluginFiles()))
    pkgFiles[`${DOCS_PLUGIN_DIR}${rel}`] = text
  try {
    // PLATFORM§36
    const bundleDir = path.dirname(bundlePath())
    for (const name of fs.readdirSync(bundleDir))
      pkgFiles[`statusline/${name}`] = fs.readFileSync(path.join(bundleDir, name))
    pkgFiles['statusline/package.json'] = '{"type":"module"}\n'
    pkgFiles['statusline/theme.json'] = JSON.stringify(DEFAULT_THEME, null, 2)
    pkgFiles['statusline/run.sh'] = remoteWrapperScript()
    pkgFiles['statusline/agy.cjs'] = AGY_STATUSLINE_JS
    pkgFiles[AGY_STATUSLINE_FILE] = agyStatuslineScript()
  } catch (err) {
    console.error('[koloft] remote statusline bundle unreadable:', err)
  }
  return pkgFiles
}
