import { PLAYWRIGHT_CLI_SESSION_PREFIX } from '@shared/browserTabEnv'
import PACKAGE from '../../../package.json'
import { REMOTE_HOME, remoteBrowserAddressFile } from './paths'

export const PLAYWRIGHT_CLI_VERSION = PACKAGE.dependencies['@playwright/cli']

export const PLAYWRIGHT_CLI_UNDER_KOLOFT_HOME = `playwright-cli-${PLAYWRIGHT_CLI_VERSION}`
export const PLAYWRIGHT_CLI_JS_UNDER_ITS_FOLDER =
  'lib/node_modules/@playwright/cli/playwright-cli.js'

const CLI_DIR = `${REMOTE_HOME}/${PLAYWRIGHT_CLI_UNDER_KOLOFT_HOME}`
const CLI_JS = `${CLI_DIR}/${PLAYWRIGHT_CLI_JS_UNDER_ITS_FOLDER}`
const NPM_GIVES_UP_ON_A_REGISTRY_IT_CANNOT_REACH_MS = 20_000

// PLATFORM§17
export const MACHINE_PLAYWRIGHT_CLI = `#!/bin/sh
if [ ! -f "${CLI_JS}" ] && command -v npm >/dev/null 2>&1; then
  printf '[Koloft] %s\\n' "installing playwright-cli ${PLAYWRIGHT_CLI_VERSION}, which drives the Workbench browser (about 20 MB, once)" >&2
  pw_tmp="${CLI_DIR}.tmp.$$"
  if npm install -g --prefix "$pw_tmp" --no-audit --no-fund --update-notifier=false --loglevel=error --fetch-retries=0 --fetch-timeout=${NPM_GIVES_UP_ON_A_REGISTRY_IT_CANNOT_REACH_MS} "@playwright/cli@${PLAYWRIGHT_CLI_VERSION}" </dev/null >&2; then
    [ -f "${CLI_JS}" ] || { rm -rf "${CLI_DIR}"; mv "$pw_tmp" "${CLI_DIR}"; }
  fi
  rm -rf "$pw_tmp"
fi
[ -f "${CLI_JS}" ] || { echo "koloft: playwright-cli could not be installed on this machine (it needs npm and the npm registry)" >&2; exit 1; }
NO_UPDATE_NOTIFIER=1; export NO_UPDATE_NOTIFIER
PLAYWRIGHT_CLI_SESSION="${PLAYWRIGHT_CLI_SESSION_PREFIX}$KOLOFT_TAB_ID"; export PLAYWRIGHT_CLI_SESSION
a="$(cat "${remoteBrowserAddressFile('$KOLOFT_TAB_ID')}" 2>/dev/null)"
if [ -n "$a" ]; then
  PLAYWRIGHT_MCP_CDP_ENDPOINT="$a"; PLAYWRIGHT_MCP_ALLOW_UNRESTRICTED_FILE_ACCESS=1
  export PLAYWRIGHT_MCP_CDP_ENDPOINT PLAYWRIGHT_MCP_ALLOW_UNRESTRICTED_FILE_ACCESS
else
  echo "koloft: this session has no way to the Workbench browser right now: browser control is off in Koloft, Koloft is not connected to this machine, or this machine's sshd refuses port forwarding (AllowTcpForwarding)" >&2
fi
exec node "${CLI_JS}" "$@"
`
