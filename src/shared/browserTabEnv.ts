export const BROWSER_TAB_ENV = [
  'KOLOFT_BROWSER_CDP',
  'PLAYWRIGHT_MCP_CDP_ENDPOINT',
  'PLAYWRIGHT_CLI_SESSION',
  'PLAYWRIGHT_MCP_ALLOW_UNRESTRICTED_FILE_ACCESS',
  'PLAYWRIGHT_MCP_OUTPUT_DIR'
] as const

export const PLAYWRIGHT_CLI_SESSION_PREFIX = 'koloft-'

export const PLAYWRIGHT_OUTPUT_FOLDER = 'koloft-playwright'

export const playwrightCliSession = (tabId: string): string =>
  `${PLAYWRIGHT_CLI_SESSION_PREFIX}${tabId}`
