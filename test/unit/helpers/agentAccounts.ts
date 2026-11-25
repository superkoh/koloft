import type { AgentAccounts } from '../../../src/core/agent/agentsMain'

const asked = (): never => {
  throw new Error('these accounts are never asked')
}

export const accountsThatAreNeverAsked: AgentAccounts = {
  pickForThisStart: asked,
  probeAll: asked,
  addSecret: asked,
  forget: asked,
  folderSaysItRunsOnAKey: asked,
  signIn: asked,
  cancelSignIn: asked
}
