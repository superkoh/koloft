import type { AgentUsage } from '../../../src/core/agent/usage'
import type { AgentSearch } from '../../../src/core/agent/search'
import type { AgentMachinePackage } from '../../../src/core/agent/agentsMain'

export const NO_USAGE: AgentUsage = {
  filesIn: async () => [],
  placesNow: () => ({ workspaceOf: () => undefined, titleOf: () => undefined }),
  recordsOf: () => new Map()
}

export const NO_SEARCH: AgentSearch = {
  rows: () => [],
  snippets: () => ({ streamed: Promise.resolve(), said: Promise.resolve([]) })
}

export const NOTHING_FOR_THE_MACHINE: AgentMachinePackage = {
  filesForTheMachinePackage: () => ({}),
  ensureOnTheMachine: null
}

export const PARTS_THE_TEST_DOES_NOT_USE = {
  usage: NO_USAGE,
  search: NO_SEARCH,
  machinePackage: NOTHING_FOR_THE_MACHINE
}
