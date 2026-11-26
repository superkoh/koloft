import fs from 'fs'
import path from 'path'
import type { AgentsMain } from '@core/agent/agentsMain'
import { STATUS_RELAY_FILE, STATUS_RELAY_PY } from './statusRelay'
import { ensureSh, TMUX_CONF, UTIL_BASH_LOGIN, UTIL_BASH_LOGIN_FILE, UTIL_SH } from './install'
import { AGENT_PLUGIN_DIR, DOCS_PLUGIN_DIR } from './launch'
import { SESSION_BIN_DIR, STATUS_LINE_DIR, UTIL_BIN_DIR } from './paths'
import { machineGhWrapperScript } from '../gitCredentialScripts'
import { REMOTE_AGENT_SHIM } from '../agentShim'
import { REMOTE_OPEN_SHIM } from '../openShimScript'
import { bundlePath, DEFAULT_THEME } from '../statusline'
import { agentPluginFiles, docsPluginFiles } from '../agentPlugin'
import { passwordsOn } from '@plugins/passwords/api'
import { SUDO_SHIM_FILES } from '@plugins/passwords/main/sudoShim'

export function machinePackageFiles(agents: AgentsMain): Record<string, string | Buffer> {
  const pkgFiles: Record<string, string | Buffer> = {
    'ensure.sh': ensureSh(agents.ensuresOnTheMachine()),
    'tmux.conf': TMUX_CONF,
    'util.sh': UTIL_SH,
    [UTIL_BASH_LOGIN_FILE]: UTIL_BASH_LOGIN,
    [`${SESSION_BIN_DIR}koloft`]: REMOTE_AGENT_SHIM,
    [`${SESSION_BIN_DIR}open`]: REMOTE_OPEN_SHIM,
    [`${SESSION_BIN_DIR}gh`]: machineGhWrapperScript(),
    [`${UTIL_BIN_DIR}gh`]: machineGhWrapperScript(),
    [STATUS_RELAY_FILE]: STATUS_RELAY_PY,
    ...agents.filesForTheMachinePackage()
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
      pkgFiles[`${STATUS_LINE_DIR}${name}`] = fs.readFileSync(path.join(bundleDir, name))
    pkgFiles[`${STATUS_LINE_DIR}package.json`] = '{"type":"module"}\n'
    pkgFiles[`${STATUS_LINE_DIR}theme.json`] = JSON.stringify(DEFAULT_THEME, null, 2)
  } catch (err) {
    console.error('[koloft] remote statusline bundle unreadable:', err)
    for (const rel of Object.keys(pkgFiles))
      if (rel.startsWith(STATUS_LINE_DIR)) delete pkgFiles[rel]
  }
  return pkgFiles
}
