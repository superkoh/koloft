import type { AgentUsage } from '../../../src/core/agent/usage'
import type { AgentSearch } from '../../../src/core/agent/search'

export const NO_USAGE: AgentUsage = {
  filesIn: async () => [],
  placesNow: () => ({ workspaceOf: () => undefined, titleOf: () => undefined }),
  recordsOf: () => new Map()
}

export const NO_SEARCH: AgentSearch = {
  rows: () => [],
  snippets: () => ({ streamed: Promise.resolve(), said: Promise.resolve([]) })
}

export const NOTHING_TO_READ_OR_SEARCH = { usage: NO_USAGE, search: NO_SEARCH }
