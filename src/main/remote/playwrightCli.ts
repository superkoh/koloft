import { PLAYWRIGHT_CLI_SESSION_PREFIX } from '@shared/browserTabEnv'
import { dependencies } from '../../../package.json'
import { REMOTE_HOME, remoteBrowserAddressFile } from './paths'

export const PLAYWRIGHT_CLI_VERSION = dependencies['@playwright/cli']

export const PLAYWRIGHT_CLI_UNDER_KOLOFT_HOME = `playwright-cli-${PLAYWRIGHT_CLI_VERSION}`
export const PLAYWRIGHT_CLI_JS_UNDER_ITS_FOLDER =
  'lib/node_modules/@playwright/cli/playwright-cli.js'

const CLI_DIR = `${REMOTE_HOME}/${PLAYWRIGHT_CLI_UNDER_KOLOFT_HOME}`
const CLI_JS = `${CLI_DIR}/${PLAYWRIGHT_CLI_JS_UNDER_ITS_FOLDER}`
const NPM_GIVES_UP_ON_A_REGISTRY_IT_CANNOT_REACH_MS = 20_000
const LISTENING = '0A'
const LOOPBACK_IN_PROC_NET_TCP = '0100007F'

// PLATFORM§17 PLATFORM§33
export const MACHINE_PLAYWRIGHT_CLI = `#!/bin/sh
if [ ! -f "${CLI_JS}" ] && command -v npm >/dev/null 2>&1; then
  printf '[Koloft] %s\\n' "installing playwright-cli ${PLAYWRIGHT_CLI_VERSION}, which drives the Workbench browser (about 20 MB, once)" >&2
  pw_dir="${CLI_DIR}.$$"
  if npm install -g --prefix "$pw_dir" --no-audit --no-fund --update-notifier=false --loglevel=error --fetch-retries=0 --fetch-timeout=${NPM_GIVES_UP_ON_A_REGISTRY_IT_CANNOT_REACH_MS} "@playwright/cli@${PLAYWRIGHT_CLI_VERSION}" </dev/null >&2; then
    ln -s "$pw_dir" "${CLI_DIR}" 2>/dev/null || rm -rf "$pw_dir"
  else
    rm -rf "$pw_dir"
  fi
fi
[ -f "${CLI_JS}" ] || { echo "koloft: playwright-cli could not be installed on this machine (it needs npm and the npm registry)" >&2; exit 1; }
NO_UPDATE_NOTIFIER=1; export NO_UPDATE_NOTIFIER
PLAYWRIGHT_CLI_SESSION="${PLAYWRIGHT_CLI_SESSION_PREFIX}$KOLOFT_TAB_ID"; export PLAYWRIGHT_CLI_SESSION
a="$(cat "${remoteBrowserAddressFile('$KOLOFT_TAB_ID')}" 2>/dev/null)"
tcp="\${KOLOFT_TEST_PROC_NET_TCP:-/proc/net/tcp}"
if [ -n "$a" ] && [ -r "$tcp" ]; then
  p="\${a#ws://127.0.0.1:}"; p="\${p%%/*}"
  awk -v l="${LOOPBACK_IN_PROC_NET_TCP}:$(printf '%04X' "$p")" -v u="$(id -u)" '$2 == l && $4 == "${LISTENING}" && $8 == u { f = 1 } END { exit !f }' "$tcp" || {
    echo "koloft: the Workbench browser's port on this machine is not held by Koloft's ssh connection right now (it dropped); try again once Koloft is connected" >&2
    a=""; told=1
  }
fi
if [ -n "$a" ]; then
  PLAYWRIGHT_MCP_CDP_ENDPOINT="$a"; PLAYWRIGHT_MCP_ALLOW_UNRESTRICTED_FILE_ACCESS=1
  export PLAYWRIGHT_MCP_CDP_ENDPOINT PLAYWRIGHT_MCP_ALLOW_UNRESTRICTED_FILE_ACCESS
elif [ -z "$told" ]; then
  echo "koloft: this session has no way to the Workbench browser right now: browser control is off in Koloft, Koloft is not connected to this machine, or this machine's sshd refuses port forwarding (AllowTcpForwarding)" >&2
fi
exec node "${CLI_JS}" "$@"
`
