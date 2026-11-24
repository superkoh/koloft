import type { MadeLater } from '@core/moment'
import type { BuildLater, PluginStart } from '@core/pluginStart'
import type { Turn } from '@shared/turns'
import { AgySessions, type AgySessionDeps } from './agySessions'
import * as appHelpers from './appHelpers'
import { AttentionTracker, type SavedMark } from './attention'
import { ClaudeBackend, type ClaudeBackendDeps } from '@agents/claude/main/backend'
import { pushes, registerChannels } from './channels'
import { CodexSessions, type CodexSessionDeps } from './codexSessions'
import { HandOver, type HandOverDeps } from './handOver'
import { InstructionAsks, type InstructionAskDeps } from './instructionAsks'
import { SessionAsks, type SessionAskDeps } from './sessionAsks'
import { SessionBackends, type SessionLifecycle } from './sessionBackends'
import { followEachState, followEachTurn, forgetAsksOfEndedTabs } from './sessionHooks'
import { SessionSync, type SessionSyncDeps } from './sessionSync'
import { SessionTracker } from './sessionTracker'
import { registerSessionCommands, sessionVerb, type SessionVerbDeps } from './sessionVerbs'
import { SlashCommands, type SlashDeps } from './slashCommands'
import { SleepingTabs, type SleepingTabsDeps } from './sleepingTabs'
import { StartedSessions } from './startedSessions'
import { TabLifecycle, subscribeTabSubsystems, type TabSubsystems } from './tabLifecycle'
import { NewsJudge, type NewsJudgeDeps } from './turnNews'
import { WorkspaceManager, type WorkspaceManagerDeps } from './workspaces'

type ChannelDeps = Parameters<typeof registerChannels>[1]

type TrackerDeps = Pick<
  SessionTracker,
  | 'pidOf'
  | 'activeTabId'
  | 'heldTabs'
  | 'needsUser'
  | 'leftBehind'
  | 'machineTmp'
  | 'realFilesOn'
  | 'dialogJustClosed'
>

type BackendHooks = Partial<
  Pick<
    SessionBackends,
    | 'isOverseerSession'
    | 'turnOver'
    | 'askingOf'
    | 'docVerdictsOf'
    | 'noAccountMessage'
    | 'turnedOff'
  >
>

type AttentionDeps = Pick<
  AttentionTracker,
  'asleep' | 'watching' | 'turnDone' | 'outlivesKoloft' | 'waitsOnAnother'
> & {
  onChange: ConstructorParameters<typeof AttentionTracker>[0]
  lastRun: SavedMark[]
}

export interface SessionsStartDeps {
  tracker: TrackerDeps
  backendLifecycle: SessionLifecycle
  backendHooks: BackendHooks
  claude: Omit<ClaudeBackendDeps, 'tracker'>
  startedSessionsFile: ConstructorParameters<typeof StartedSessions>[0]
  newsJudge: NewsJudgeDeps & { onVerdict: Parameters<NewsJudge['onVerdict']>[0] }
  slash: SlashDeps
  sleepers: SleepingTabsDeps
  sessionSync: SessionSyncDeps
  attention: AttentionDeps
  session: SessionVerbDeps
  eachTurn: Omit<Parameters<typeof followEachTurn>[1], 'asks' | 'judge' | 'slash' | 'replies'>
  commands: Omit<Parameters<typeof registerSessionCommands>[1], 'session'>
  eachState: Omit<Parameters<typeof followEachState>[1], 'asks' | 'slash'>
  channels: Omit<ChannelDeps, 'instructionAsks' | 'backends'>
}

export const start: PluginStart<
  SessionsStartDeps,
  ReturnType<typeof followEachTurn> &
    typeof appHelpers & {
      sessionCommand: ReturnType<typeof sessionVerb>
      pushToSessions: ReturnType<typeof pushes>
      tracker: SessionTracker
      sessionBackends: SessionBackends
      claudeBackend: ClaudeBackend
      subscribeTabSubsystems: BuildLater<Omit<TabSubsystems, 'attention' | 'claude' | 'tracker'>>
      startedSessions: StartedSessions
      newsJudge: NewsJudge
      slash: SlashCommands
      tabLifecycle: TabLifecycle
      sleepers: SleepingTabs
      sessionSync: SessionSync
      attention: AttentionTracker
      buildAsks: BuildLater<SessionAskDeps, SessionAsks>
      buildInstructionAsks: BuildLater<InstructionAskDeps, InstructionAsks>
      buildHandOver: BuildLater<HandOverDeps, HandOver>
      buildWorkspaces: BuildLater<WorkspaceManagerDeps, WorkspaceManager>
      buildCodexSessions: BuildLater<CodexSessionDeps & { file: string }, CodexSessions>
      buildAgySessions: BuildLater<AgySessionDeps & { file: string }, AgySessions>
    }
> = ({ commands, moments, ipc }, d) => {
  const tracker = new SessionTracker()
  const sessionBackends = Object.assign(new SessionBackends(d.backendLifecycle), d.backendHooks)
  tracker.on('turn-ended', ({ tabId, turn }: { tabId: string; turn: Turn }) =>
    sessionBackends.observe(tabId, { type: 'turn-ended', turn })
  )
  Object.assign(tracker, d.tracker)
  const claudeBackend = new ClaudeBackend({ ...d.claude, tracker })
  sessionBackends.register(claudeBackend)
  const startedSessions = new StartedSessions(d.startedSessionsFile)
  const { onVerdict, ...judgeDeps } = d.newsJudge
  const newsJudge = new NewsJudge(judgeDeps)
  newsJudge.onVerdict(onVerdict)
  const slash = new SlashCommands(d.slash)
  const tabLifecycle = new TabLifecycle()
  const sleepers = new SleepingTabs(d.sleepers)
  const sessionSync = new SessionSync(d.sessionSync)
  const { onChange, lastRun, ...attentionHooks } = d.attention
  const attention = Object.assign(new AttentionTracker(onChange, lastRun), attentionHooks)
  let asks: SessionAsks | null = null
  let instructionAsks: InstructionAsks | null = null
  const asksBuilt: MadeLater<SessionAsks> = () => asks
  const instructionAsksBuilt: MadeLater<InstructionAsks> = () => instructionAsks
  const instructionAsksOrNone: ChannelDeps['instructionAsks'] = () =>
    instructionAsks ?? { views: () => [], answer: () => undefined }
  const sessionCommand = sessionVerb(d.session)
  const turnsTaken = followEachTurn(moments, {
    ...d.eachTurn,
    replies: sessionCommand,
    judge: newsJudge,
    slash,
    asks: asksBuilt
  })
  registerSessionCommands(commands, { ...d.commands, session: sessionCommand.verb })
  forgetAsksOfEndedTabs(moments, {
    slash,
    asks: asksBuilt,
    instructionAsks: instructionAsksBuilt
  })
  followEachState(moments, { ...d.eachState, slash, asks: asksBuilt })
  registerChannels(ipc, {
    ...d.channels,
    backends: sessionBackends,
    instructionAsks: instructionAsksOrNone
  })
  return {
    ...turnsTaken,
    ...appHelpers,
    sessionCommand,
    pushToSessions: pushes(ipc),
    tracker,
    sessionBackends,
    claudeBackend,
    subscribeTabSubsystems: (deps) =>
      subscribeTabSubsystems(tabLifecycle, {
        ...deps,
        attention,
        claude: claudeBackend,
        tracker
      }),
    startedSessions,
    newsJudge,
    slash,
    tabLifecycle,
    sleepers,
    sessionSync,
    attention,
    buildAsks: (deps) => (asks = new SessionAsks(deps)),
    buildInstructionAsks: (deps) => (instructionAsks = new InstructionAsks(deps)),
    buildHandOver: (deps) => new HandOver(deps),
    buildWorkspaces: (deps) => new WorkspaceManager(deps),
    buildCodexSessions: ({ file, ...deps }) => new CodexSessions(file, deps),
    buildAgySessions: ({ file, ...deps }) => new AgySessions(file, deps)
  }
}
