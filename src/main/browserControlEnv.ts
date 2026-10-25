import { tmpdir } from 'os'
import { join } from 'path'
import { PLAYWRIGHT_OUTPUT_FOLDER, playwrightCliSession } from '@shared/browserTabEnv'

export const playwrightMcpEnv = (endpoint: string): Record<string, string> => ({
  PLAYWRIGHT_MCP_CDP_ENDPOINT: endpoint,
  PLAYWRIGHT_MCP_ALLOW_UNRESTRICTED_FILE_ACCESS: '1'
})

// PLATFORM§17
export const browserControlEnv = (tabId: string, endpoint: string): Record<string, string> => ({
  PLAYWRIGHT_CLI_SESSION: playwrightCliSession(tabId),
  PLAYWRIGHT_MCP_OUTPUT_DIR: join(tmpdir(), PLAYWRIGHT_OUTPUT_FOLDER, tabId),
  ...(endpoint && { ...playwrightMcpEnv(endpoint), KOLOFT_BROWSER_CDP: endpoint })
})
