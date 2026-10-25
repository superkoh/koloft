import { PLAYWRIGHT_CLI_SESSION_PREFIX } from '@shared/browserTabEnv'
import PACKAGE from '../../../package.json'
import { REMOTE_HOME, remoteBrowserAddressFile } from './paths'

export const PLAYWRIGHT_CLI_VERSION = PACKAGE.dependencies['@playwright/cli']

const CLI_DIR = `${REMOTE_HOME}/playwright-cli-${PLAYWRIGHT_CLI_VERSION}`
const CLI_JS = `${CLI_DIR}/lib/node_modules/@playwright/cli/playwright-cli.js`

export const INSTALL_PLAYWRIGHT_CLI_FN = `install_playwright_cli() {
  [ -f "${CLI_JS}" ] && return 0
  command -v npm >/dev/null 2>&1 || return 1
  printf '[Koloft] %s\\n' "installing playwright-cli ${PLAYWRIGHT_CLI_VERSION}, which drives the Workbench browser (about 20 MB, once)" >&2
  pw_tmp="${CLI_DIR}.tmp.$$"
  rm -rf "$pw_tmp"
  if npm install -g --prefix "$pw_tmp" --no-audit --no-fund --update-notifier=false --loglevel=error "@playwright/cli@${PLAYWRIGHT_CLI_VERSION}" </dev/null >&2; then
    [ -f "${CLI_JS}" ] || { rm -rf "${CLI_DIR}"; mv "$pw_tmp" "${CLI_DIR}"; }
  fi
  rm -rf "$pw_tmp"
  [ -f "${CLI_JS}" ]
}`

// PLATFORM§17
export const MACHINE_PLAYWRIGHT_CLI = `#!/bin/sh
${INSTALL_PLAYWRIGHT_CLI_FN}
install_playwright_cli || { echo "koloft: playwright-cli could not be installed on this machine (it needs npm and the npm registry)" >&2; exit 1; }
NO_UPDATE_NOTIFIER=1; export NO_UPDATE_NOTIFIER
if [ -n "$KOLOFT_TAB_ID" ] && [ "$KOLOFT_UTIL" != 1 ]; then
  PLAYWRIGHT_CLI_SESSION="${PLAYWRIGHT_CLI_SESSION_PREFIX}$KOLOFT_TAB_ID"; export PLAYWRIGHT_CLI_SESSION
  a="$(cat "${remoteBrowserAddressFile('$KOLOFT_TAB_ID')}" 2>/dev/null)"
  if [ -n "$a" ]; then
    PLAYWRIGHT_MCP_CDP_ENDPOINT="$a"; KOLOFT_BROWSER_CDP="$a"; PLAYWRIGHT_MCP_ALLOW_UNRESTRICTED_FILE_ACCESS=1
    export PLAYWRIGHT_MCP_CDP_ENDPOINT KOLOFT_BROWSER_CDP PLAYWRIGHT_MCP_ALLOW_UNRESTRICTED_FILE_ACCESS
  else
    echo "koloft: this session has no way to the Workbench browser right now: browser control is off in Koloft, Koloft is not connected to this machine, or this machine's sshd refuses port forwarding (AllowTcpForwarding)" >&2
  fi
fi
exec node "${CLI_JS}" "$@"
`
