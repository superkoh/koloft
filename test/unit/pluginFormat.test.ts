import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import type {
  AttentionEvent,
  ArtifactView,
  BackendId,
  CronEffort,
  SessionInfo
} from '@shared/types'
import type { SessionStatus, TerminalExit } from '@shared/types'
import type { AskPayload } from '@shared/sessionEvent'
import type { Turn } from '@shared/turns'
import type { IpcMainEvent } from 'electron'
import type { ComponentType } from 'react'
import { PLUGIN_FORMAT_VERSION, type PluginManifest } from '@core/plugin'
import type { Commands } from '@core/commands'
import type { answered, refused } from '@core/command'
import type { MainIpc, PreloadIpc } from '@core/ipc'
import type { SettingKey, setting } from '@core/settings'
import type { PluginUi, Slot, fill, slot } from '@core/ui'
import type { PromptContext, composePrompt, fillSlots } from '@core/prompt'
import * as moments from '@core/moment'
import type {
  FileOpened,
  Hears,
  Moment,
  Moments,
  QuestionAsked,
  SessionBound,
  SessionStarted,
  SessionStarting,
  StateChanged,
  TabEnded,
  TabStopping,
  ToolDone,
  TurnEnded,
  TurnOver
} from '@core/moment'
import { PLUGINS } from '@plugins/list'
import { PLUGIN_UIS } from '@plugins/uis'
import * as windowSlots from '@renderer/slots'

type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false

const same = <A, B>(holds: Same<A, B>): Same<A, B> => holds

interface Probe {
  probe: true
}

type V1UiPlace =
  | 'sidebar-head'
  | 'sidebar-row'
  | 'sidebar-foot'
  | 'centre-page'
  | 'below-terminal'
  | 'dialog'
  | 'palette-item'
  | 'settings-page'

interface V1TextBlock {
  slot: string
  text: string
  byAgent?: Partial<Record<BackendId, string>>
  byModel?: Readonly<Record<string, string>>
  when?: string
  whenOff?: string
}

interface V1Manifest {
  formatVersion: 1
  id: string
  name: string
  does: string
  mandatory: boolean
  needs: readonly string[]
  offUntilSetUp?: string
  text?: readonly V1TextBlock[]
  skills?: readonly string[]
  commands?: readonly { verb: string }[]
  channels?: readonly string[]
  moments?: { announces?: readonly string[]; listens?: readonly string[] }
  settings?: { page?: { label: string; words: readonly string[] }; keys: readonly string[] }
  ui?: readonly (
    | { place: Exclude<V1UiPlace, 'palette-item'>; id: string }
    | {
        place: 'palette-item'
        id: string
        label: string
        words: readonly string[]
        actsOnCurrent?: true
      }
  )[]
  hints?: readonly string[]
  assistJobs?: readonly {
    id: string
    name: string
    does: string
    defaults: Record<BackendId, { model?: string; effort?: CronEffort }>
  }[]
  mcpServers?: readonly { name: string; command: string; args: readonly string[] }[]
}

interface V1Reply {
  text: string
  exit: number
}

interface V1Caller {
  tabId: string
  cwd: string
  session: SessionInfo
  stillWaiting?(): boolean
}

type V1Verb = (args: string[], caller: V1Caller) => V1Reply | Promise<V1Reply>

interface V1MainIpc {
  handle<A extends unknown[]>(channel: string, handler: (...args: A) => unknown): void
  on<A extends unknown[]>(channel: string, listener: (...args: A) => void): void
  onEvent<A extends unknown[]>(
    channel: string,
    listener: (event: IpcMainEvent, ...args: A) => void
  ): void
  push(channel: string, ...args: unknown[]): boolean
}

interface V1PreloadIpc {
  invoke<T>(channel: string, ...args: unknown[]): Promise<T>
  send(channel: string, ...args: unknown[]): void
  sendSync<T>(channel: string, ...args: unknown[]): T
  listen<A extends unknown[]>(channel: string, listener: (...args: A) => void): () => void
}

type V1HandOver = (raw: unknown) => readonly unknown[]

interface V1SettingKey<T> {
  default: T
  clean: (raw: unknown, handed: readonly unknown[]) => T
  keptOnReset?: true
  writtenByMainOnly?: true
  retires?: Readonly<Record<string, V1HandOver>>
  handsTo?: Readonly<Record<string, V1HandOver>>
}

interface V1Slot<T> {
  name: string
  filledWith?: T
}

interface V1SlotFill {
  slot: V1Slot<unknown>
  value: unknown
}

interface V1PluginUi {
  parts?: Readonly<Record<string, ComponentType>>
  fills?: readonly V1SlotFill[]
}

interface V1Moment<T> {
  readonly name: string
  readonly carries?: T
  readonly heardWhileOff?: true
}

interface V1PromptContext {
  agent?: BackendId
  facts?: readonly string[]
  values?: Readonly<Record<string, string>>
}

interface V1TabEnded extends Pick<TerminalExit, 'exitCode' | 'signal' | 'unexpected'> {
  tabId: string
  asleep: boolean
  crashed: boolean
  sessionGoesOn: boolean
  left?: { treeRoot?: string; sessionId?: string }
}

interface PinnedFormats {
  1: {
    manifest: V1Manifest
    register: (handlers: Readonly<Record<string, V1Verb>>) => void
    answered: (text: string) => V1Reply
    refused: (text: string, exit?: number) => V1Reply
    mainIpc: V1MainIpc
    preloadIpc: V1PreloadIpc
    settingKey: V1SettingKey<Probe>
    setting: <T>(key: V1SettingKey<T>) => V1SettingKey<T>
    pluginUi: V1PluginUi
    slot: <T>(name: string) => V1Slot<T>
    fill: <T>(into: V1Slot<T>, value: T) => V1SlotFill
    moment: V1Moment<Probe>
    hears: (moment: Probe) => unknown
    listen: <T>(
      pluginId: string,
      moment: V1Moment<T>,
      hear: (moment: T) => unknown,
      afterPlugins?: readonly string[]
    ) => () => void
    announce: <T>(moment: V1Moment<T>, m: T) => Promise<string[]>
    promptContext: V1PromptContext
    composePrompt: (slot: string, context?: V1PromptContext) => string
    fillSlots: (text: string, context?: V1PromptContext) => string
    fileOpened: { tabId: string; target: string; view?: ArtifactView }
    sessionStarting: { helper: boolean }
    sessionStarted: { by: string; tabId: string; workspace: string; name?: string }
    tabEnded: V1TabEnded
    turnEnded: { tabId: string; turn: Turn }
    questionAsked: { tabId: string; ask: AskPayload }
    sessionBound: { tabId: string; key: string; idleCompaction: boolean }
    stateChanged: { tabId: string; prev: SessionStatus | undefined; next: SessionStatus }
    toolDone: {
      tabId: string
      call: { name: string; input: Record<string, unknown> }
      endsTheAsk: boolean
    }
    turnOver: { tabId: string; over: boolean }
    tabStopping: { tabId: string; restarting: boolean }
    attentionChanged: readonly AttentionEvent[]
  }
}

type Pinned = PinnedFormats[typeof PLUGIN_FORMAT_VERSION]

const HEARD_WHILE_OFF = true

const PINNED_MOMENTS: Record<keyof PinnedFormats, Readonly<Record<string, boolean>>> = {
  1: {
    'file-opened': false,
    'session-starting': false,
    'session-started': false,
    'tab-exited': HEARD_WHILE_OFF,
    'tab-torn-down': HEARD_WHILE_OFF,
    'tab-forgotten': HEARD_WHILE_OFF,
    'turn-started': false,
    'turn-ended': false,
    'question-asked': false,
    'session-bound': false,
    'state-changed': false,
    'tool-done': false,
    'turn-over': false,
    'attention-changed': false,
    'tab-stopping': false,
    'dialog-closed': false
  }
}

type Carried<M> = M extends Moment<infer T> ? T : never

const isNamed = (m: unknown): m is { name: string; heardWhileOff?: true } =>
  typeof m === 'object' && m !== null && 'name' in m && typeof m.name === 'string'

describe('the plugin format', () => {
  it('a manifest and every registry keep the shape pinned for their format version, so a change fails the typecheck until it is pinned or the version goes up', () => {
    const typedOnly = (): void => {
      same<PluginManifest, Pinned['manifest']>(true)
      same<Commands['register'], Pinned['register']>(true)
      same<typeof answered, Pinned['answered']>(true)
      same<typeof refused, Pinned['refused']>(true)
      same<MainIpc, Pinned['mainIpc']>(true)
      same<PreloadIpc, Pinned['preloadIpc']>(true)
      same<SettingKey<Probe>, Pinned['settingKey']>(true)
      same<typeof setting, Pinned['setting']>(true)
      same<PluginUi, Pinned['pluginUi']>(true)
      same<typeof slot, Pinned['slot']>(true)
      same<typeof fill, Pinned['fill']>(true)
      same<Slot<Probe>, V1Slot<Probe>>(true)
      same<Moment<Probe>, Pinned['moment']>(true)
      same<Hears<Probe>, Pinned['hears']>(true)
      same<Moments['listen'], Pinned['listen']>(true)
      same<Moments['announce'], Pinned['announce']>(true)
      same<PromptContext, Pinned['promptContext']>(true)
      same<typeof composePrompt, Pinned['composePrompt']>(true)
      same<typeof fillSlots, Pinned['fillSlots']>(true)
      same<FileOpened, Pinned['fileOpened']>(true)
      same<SessionStarting, Pinned['sessionStarting']>(true)
      same<SessionStarted, Pinned['sessionStarted']>(true)
      same<TabEnded, Pinned['tabEnded']>(true)
      same<TurnEnded, Pinned['turnEnded']>(true)
      same<QuestionAsked, Pinned['questionAsked']>(true)
      same<SessionBound, Pinned['sessionBound']>(true)
      same<StateChanged, Pinned['stateChanged']>(true)
      same<ToolDone, Pinned['toolDone']>(true)
      same<TurnOver, Pinned['turnOver']>(true)
      same<TabStopping, Pinned['tabStopping']>(true)
      same<Carried<typeof moments.FILE_OPENED>, FileOpened>(true)
      same<Carried<typeof moments.SESSION_STARTING>, SessionStarting>(true)
      same<Carried<typeof moments.SESSION_STARTED>, SessionStarted>(true)
      same<Carried<typeof moments.TAB_EXITED>, TabEnded>(true)
      same<Carried<typeof moments.TAB_TORN_DOWN>, TabEnded>(true)
      same<Carried<typeof moments.TAB_FORGOTTEN>, string>(true)
      same<Carried<typeof moments.TURN_STARTED>, string>(true)
      same<Carried<typeof moments.TURN_ENDED>, TurnEnded>(true)
      same<Carried<typeof moments.QUESTION_ASKED>, QuestionAsked>(true)
      same<Carried<typeof moments.SESSION_BOUND>, SessionBound>(true)
      same<Carried<typeof moments.STATE_CHANGED>, StateChanged>(true)
      same<Carried<typeof moments.TOOL_DONE>, ToolDone>(true)
      same<Carried<typeof moments.TURN_OVER>, TurnOver>(true)
      same<Carried<typeof moments.ATTENTION_CHANGED>, Pinned['attentionChanged']>(true)
      same<Carried<typeof moments.TAB_STOPPING>, TabStopping>(true)
      same<Carried<typeof moments.DIALOG_CLOSED>, string>(true)
    }
    void typedOnly
  })

  it('the moments keep the names and the heard-while-off marks pinned for their format version', () => {
    const now = Object.values(moments as Record<string, unknown>).filter(isNamed)
    expect(Object.fromEntries(now.map((m) => [m.name, m.heardWhileOff ?? false]).sort())).toEqual(
      PINNED_MOMENTS[PLUGIN_FORMAT_VERSION]
    )
  })
})

const REFERENCE = fs.readFileSync(
  path.join(__dirname, '..', '..', 'docs', 'plugin-format.md'),
  'utf8'
)
const NAMED = [...REFERENCE.matchAll(/`([^`\n]+)`/g)].map((m) => m[1])
const ELLIPSIS = '…'
const unnamed = (names: Iterable<string>): string[] =>
  [...new Set(names)].filter(
    (name) =>
      !NAMED.includes(name) &&
      !NAMED.some((n) => n.endsWith(ELLIPSIS) && name.startsWith(n.slice(0, -1)))
  )

describe('the plugin format reference names every registration a built-in plugin uses', () => {
  it('every manifest field a built-in plugin fills', () => {
    expect(unnamed(PLUGINS.flatMap((p) => Object.keys(p)))).toEqual([])
  })

  it('every plugin, command, setting key, Assist job and hint', () => {
    expect(
      unnamed(
        PLUGINS.flatMap((p) => [
          p.id,
          ...(p.commands ?? []).map((c) => c.verb),
          ...(p.settings?.keys ?? []),
          ...(p.assistJobs ?? []).map((j) => j.id),
          ...(p.hints ?? [])
        ])
      )
    ).toEqual([])
  })

  it('every UI entry and the place it is drawn', () => {
    expect(unnamed(PLUGINS.flatMap((p) => (p.ui ?? []).flatMap((e) => [e.id, e.place])))).toEqual(
      []
    )
  })

  it('every moment a plugin announces or listens to', () => {
    expect(
      unnamed(
        PLUGINS.flatMap((p) => [...(p.moments?.announces ?? []), ...(p.moments?.listens ?? [])])
      )
    ).toEqual([])
  })

  it('every text slot a plugin fills, and every fact a block waits on', () => {
    expect(
      unnamed(
        PLUGINS.flatMap((p) => (p.text ?? []).flatMap((b) => [b.slot, ...(b.when ? [b.when] : [])]))
      )
    ).toEqual([])
  })

  it('every window slot core offers and every slot a plugin fills', () => {
    const offered = Object.values(windowSlots as Record<string, unknown>).filter(isNamed)
    const filled = Object.values(PLUGIN_UIS).flatMap((ui) => (ui.fills ?? []).map((f) => f.slot))
    expect(unnamed([...offered, ...filled].map((s) => s.name))).toEqual([])
  })
})
