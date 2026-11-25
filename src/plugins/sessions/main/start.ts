import type { MadeLater } from '@core/moment'
import type { BuildLater, PluginStart } from '@core/pluginStart'
import { AgySessions, type AgySessionDeps } from '@agents/agy/main/agySessions'
import * as appHelpers from './appHelpers'
import { AttentionTracker, type SavedMark } from './attention'
import { ClaudeBackend, type ClaudeBackendDeps } from '@agents/claude/main/backend'
import {
  ClaudeSessionStore,
  liveSessionsOf,
  type ClaudeSessionStoreDeps
} from '@agents/claude/main/claudeSessionStore'
import { pushes, registerChannels } from './channels'
import { CodexSessions, type CodexSessionDeps } from '@agents/codex/main/codexSessions'
import { HandOver, type HandOverDeps } from './handOver'
import { InstructionAsks, type InstructionAskDeps } from './instructionAsks'
import { SessionAsks, type SessionAskDeps } from './sessionAsks'
import { SessionBackends, type SessionLifecycle } from '@core/agent/sessionBackends'
import { SessionRuntime } from '@core/agent/sessionRuntime'
import { wireRunState } from './runState'
import { followEachState, followEachTurn, forgetAsksOfEndedTabs } from './sessionHooks'
import { SessionSync, type SessionSyncDeps } from './sessionSync'
import { SessionTracker } from '@agents/claude/main/sessionTracker'
import { registerSessionCommands, sessionVerb, type SessionVerbDeps } from './sessionVerbs'
import { SlashCommands, type SlashDeps } from './slashCommands'
import { SleepingTabs, type SleepingTabsDeps } from './sleepingTabs'
import { StartedSessions } from './startedSessions'
import { TabLifecycle, subscribeTabSubsystems, type TabSubsystems } from './tabLifecycle'
import { NewsJudge, type NewsJudgeDeps } from './turnNews'
import { WorkspaceManager, type WorkspaceManagerDeps } from './workspaces'

type ChannelDeps = Parameters<typeof registerChannels>[1]

type RuntimeDeps = Pick<SessionRuntime, 'activeTabId' | 'heldTabs' | 'needsUser'>

type TrackerDeps = Pick<
  SessionTracker,
  'pidOf' | 'leftBehind' | 'machineTmp' | 'realFilesOn' | 'dialogJustClosed'
>

type BackendHooks = Partial<
  Pick<
    SessionBackends,
    | 'isKoloftsOwnSession'
    | 'turnOver'
    | 'askingOf'
    | 'verdictsOnFilesOf'
    | 'noAccountMessage'
    | 'turnedOff'
    | 'storedRemoteByHand'
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
  runtime: RuntimeDeps
  tracker: TrackerDeps
  backendLifecycle: SessionLifecycle
  backendHooks: BackendHooks
  claude: Omit<ClaudeBackendDeps, 'tracker' | 'store'>
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
      runtime: SessionRuntime
      tracker: SessionTracker
      sessionBackends: SessionBackends
      claudeBackend: ClaudeBackend
      subscribeTabSubsystems: BuildLater<Omit<TabSubsystems, 'attention' | 'backends'>>
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
      buildClaudeStore: BuildLater<Omit<ClaudeSessionStoreDeps, 'liveSessions'>, ClaudeSessionStore>
      buildCodexSessions: BuildLater<CodexSessionDeps & { file: string }, CodexSessions>
      buildAgySessions: BuildLater<AgySessionDeps & { file: string }, AgySessions>
    }
> = ({ commands, moments, ipc }, d) => {
  const runtime = Object.assign(new SessionRuntime(), d.runtime)
  const tracker = new SessionTracker(runtime)
  const sessionBackends = Object.assign(new SessionBackends(d.backendLifecycle), d.backendHooks)
  wireRunState(runtime, sessionBackends, tracker)
  tracker.on('turn-ended', ({ tabId, turn }) =>
    sessionBackends.observe(tabId, { type: 'turn-ended', turn })
  )
  Object.assign(tracker, d.tracker)
  let claudeStore: ClaudeSessionStore | null = null
  const claudeBackend = new ClaudeBackend({ ...d.claude, tracker, store: () => claudeStore })
  sessionBackends.register(claudeBackend)
  sessionBackends.remoteByHand = {
    noticeRemoteExits: (host, sessionIds) => claudeBackend.noticeRemoteExits(host, sessionIds),
    tmuxOfTab: (tabId) => tracker.remoteOf(tabId)?.tmuxName
  }
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
    runtime,
    tracker,
    sessionBackends,
    claudeBackend,
    subscribeTabSubsystems: (deps) =>
      subscribeTabSubsystems(tabLifecycle, {
        ...deps,
        attention,
        backends: sessionBackends
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
    buildClaudeStore: (deps) =>
      (claudeStore = new ClaudeSessionStore({
        ...deps,
        liveSessions: () => liveSessionsOf(tracker)
      })),
    buildCodexSessions: ({ file, ...deps }) => new CodexSessions(file, deps),
    buildAgySessions: ({ file, ...deps }) => new AgySessions(file, deps)
  }
}
