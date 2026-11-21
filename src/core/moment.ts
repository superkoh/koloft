// ADR-0051
import type { ArtifactView, AttentionEvent, SessionStatus, TerminalExit } from '@shared/types'
import type { AskPayload } from '@shared/sessionEvent'
import type { Turn } from '@shared/turns'
import type { PluginManifest } from './plugin'
import { errorText } from './errorText'
import { pluginStateOf } from './switches'

export interface FileOpened {
  tabId: string
  target: string
  view?: ArtifactView
}

export interface SessionStarting {
  helper: boolean
}

export interface SessionStarted {
  by: string
  tabId: string
  workspace: string
  name?: string
}

export interface LeftTab {
  treeRoot?: string
  sessionId?: string
}

export type AgentExit = Pick<TerminalExit, 'exitCode' | 'signal' | 'unexpected'>

export interface TabEnded extends AgentExit {
  tabId: string
  asleep: boolean
  crashed: boolean
  sessionGoesOn: boolean
  left?: LeftTab
}

export type { Turn }

export interface TurnEnded {
  tabId: string
  turn: Turn
}

export interface QuestionAsked {
  tabId: string
  ask: AskPayload
}

export interface SessionBound {
  tabId: string
  key: string
  idleCompaction: boolean
}

export interface StateChanged {
  tabId: string
  prev: SessionStatus | undefined
  next: SessionStatus
}

export interface ToolDone {
  tabId: string
  call: { name: string; input: Record<string, unknown> }
  endsTheAsk: boolean
}

export interface TurnOver {
  tabId: string
  over: boolean
}

export interface TabStopping {
  tabId: string
  restarting: boolean
}

export interface Moment<T> {
  readonly name: string
  readonly carries?: T
  readonly heardWhileOff?: true
}

const named = <T>(name: string): Moment<T> => ({ name })

const aTabsEnd = <T>(name: string): Moment<T> => ({ name, heardWhileOff: true })

export const FILE_OPENED = named<FileOpened>('file-opened')
export const SESSION_STARTING = named<SessionStarting>('session-starting')
export const SESSION_STARTED = named<SessionStarted>('session-started')
export const TAB_EXITED = aTabsEnd<TabEnded>('tab-exited')
export const TAB_TORN_DOWN = aTabsEnd<TabEnded>('tab-torn-down')
export const TAB_FORGOTTEN = aTabsEnd<string>('tab-forgotten')
export const TURN_STARTED = named<string>('turn-started')
export const TURN_ENDED = named<TurnEnded>('turn-ended')
export const QUESTION_ASKED = named<QuestionAsked>('question-asked')
export const SESSION_BOUND = named<SessionBound>('session-bound')
export const STATE_CHANGED = named<StateChanged>('state-changed')
export const TOOL_DONE = named<ToolDone>('tool-done')
export const TURN_OVER = named<TurnOver>('turn-over')
export const ATTENTION_CHANGED = named<readonly AttentionEvent[]>('attention-changed')
export const TAB_STOPPING = named<TabStopping>('tab-stopping')
export const DIALOG_CLOSED = named<string>('dialog-closed')

export type Hears<T> = (moment: T) => unknown

export type MadeLater<T> = () => T | null

interface Listener {
  at: number
  plugin: string
  hear: Hears<never>
  heardWhileOff: boolean
}

export class Moments {
  private listeners = new Map<string, readonly Listener[]>()
  private announcedNames: ReadonlySet<string>

  constructor(private plugins: readonly PluginManifest[]) {
    this.announcedNames = new Set(plugins.flatMap((p) => p.moments?.announces ?? []))
  }

  listen<T>(
    pluginId: string,
    moment: Moment<T>,
    hear: Hears<T>,
    afterPlugins: readonly string[] = [],
    heardWhileOff = false
  ): () => void {
    const own = this.plugins.findIndex((p) => p.id === pluginId)
    if (own < 0) throw new Error(`"${pluginId}" is not on the list of plugins`)
    if (!this.plugins[own].moments?.listens?.includes(moment.name))
      throw new Error(
        `plugin ${pluginId} listens to "${moment.name}", which its manifest does not list`
      )
    if (!this.announcedNames.has(moment.name)) throw this.unannounced(moment)
    const at = Math.max(
      own,
      ...afterPlugins.map((id) => {
        const before = this.plugins.findIndex((p) => p.id === id)
        if (before < 0)
          throw new Error(`"${id}", which ${pluginId} hears after, is not on the list of plugins`)
        return before + 0.5
      })
    )
    const listener: Listener = { at, plugin: pluginId, hear, heardWhileOff }
    const all = [...(this.listeners.get(moment.name) ?? []), listener]
    this.listeners.set(
      moment.name,
      all.sort((a, b) => a.at - b.at)
    )
    return () =>
      this.listeners.set(
        moment.name,
        (this.listeners.get(moment.name) ?? []).filter((l) => l !== listener)
      )
  }

  announce<T>(moment: Moment<T>, m: T): Promise<string[]> {
    if (!this.announcedNames.has(moment.name)) return Promise.reject(this.unannounced(moment))
    const failures: unknown[] = []
    const on = (this.listeners.get(moment.name) ?? []).filter(
      (l) => moment.heardWhileOff || l.heardWhileOff || pluginStateOf(l.plugin).on
    )
    const said = on.map(({ hear }) => {
      try {
        return Promise.resolve((hear as Hears<T>)(m)).catch((error) => void failures.push(error))
      } catch (error) {
        failures.push(error)
        return undefined
      }
    })
    return Promise.all(said).then((all) => {
      if (failures.length === 1) throw failures[0]
      if (failures.length)
        throw new AggregateError(
          failures,
          `${failures.length} listeners to "${moment.name}" failed: ${failures.map(errorText).join('; ')}`
        )
      return all.filter((s): s is string => typeof s === 'string' && !!s)
    })
  }

  private unannounced(moment: Moment<unknown>): Error {
    return new Error(`"${moment.name}" is announced by no plugin's manifest`)
  }
}
