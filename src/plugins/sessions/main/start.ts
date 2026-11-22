import type { MadeLater } from '@core/moment'
import type { BuildLater, PluginStart } from '@core/pluginStart'
import { AttentionTracker, type SavedMark } from './attention'
import { registerChannels } from './channels'
import { HandOver, type HandOverDeps } from './handOver'
import { InstructionAsks, type InstructionAskDeps } from './instructionAsks'
import { SessionAsks, type SessionAskDeps } from './sessionAsks'
import { followEachState, followEachTurn, forgetAsksOfEndedTabs } from './sessionHooks'
import { registerSessionCommands } from './sessionVerbs'
import { WorkspaceManager, type WorkspaceManagerDeps } from './workspaces'

type ChannelDeps = Parameters<typeof registerChannels>[1]

type AttentionDeps = Pick<
  AttentionTracker,
  'asleep' | 'watching' | 'turnDone' | 'outlivesKoloft' | 'waitsOnAnother'
> & {
  onChange: ConstructorParameters<typeof AttentionTracker>[0]
  lastRun: SavedMark[]
}

export interface SessionsStartDeps {
  attention: AttentionDeps
  eachTurn: Omit<Parameters<typeof followEachTurn>[1], 'asks'>
  commands: Parameters<typeof registerSessionCommands>[1]
  endedTabs: Omit<Parameters<typeof forgetAsksOfEndedTabs>[1], 'asks' | 'instructionAsks'>
  eachState: Omit<Parameters<typeof followEachState>[1], 'asks'>
  channels: Omit<ChannelDeps, 'instructionAsks'>
}

export const start: PluginStart<
  SessionsStartDeps,
  ReturnType<typeof followEachTurn> & {
    attention: AttentionTracker
    buildAsks: BuildLater<SessionAskDeps, SessionAsks>
    buildInstructionAsks: BuildLater<InstructionAskDeps, InstructionAsks>
    buildHandOver: BuildLater<HandOverDeps, HandOver>
    buildWorkspaces: BuildLater<WorkspaceManagerDeps, WorkspaceManager>
  }
> = ({ commands, moments, ipc }, d) => {
  const { onChange, lastRun, ...attentionHooks } = d.attention
  const attention = Object.assign(new AttentionTracker(onChange, lastRun), attentionHooks)
  let asks: SessionAsks | null = null
  let instructionAsks: InstructionAsks | null = null
  const asksBuilt: MadeLater<SessionAsks> = () => asks
  const instructionAsksBuilt: MadeLater<InstructionAsks> = () => instructionAsks
  const instructionAsksOrNone: ChannelDeps['instructionAsks'] = () =>
    instructionAsks ?? { views: () => [], answer: () => undefined }
  const turnsTaken = followEachTurn(moments, { ...d.eachTurn, asks: asksBuilt })
  registerSessionCommands(commands, d.commands)
  forgetAsksOfEndedTabs(moments, {
    ...d.endedTabs,
    asks: asksBuilt,
    instructionAsks: instructionAsksBuilt
  })
  followEachState(moments, { ...d.eachState, asks: asksBuilt })
  registerChannels(ipc, { ...d.channels, instructionAsks: instructionAsksOrNone })
  return {
    ...turnsTaken,
    attention,
    buildAsks: (deps) => (asks = new SessionAsks(deps)),
    buildInstructionAsks: (deps) => (instructionAsks = new InstructionAsks(deps)),
    buildHandOver: (deps) => new HandOver(deps),
    buildWorkspaces: (deps) => new WorkspaceManager(deps)
  }
}
