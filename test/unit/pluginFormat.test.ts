import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import type { SessionInfo } from '@shared/types'
import type { IpcMainEvent } from 'electron'
import type { ComponentType } from 'react'
import { PLUGIN_FORMAT_VERSION, type PluginManifest, type eachAgent } from '@core/plugin'
import type { Commands } from '@core/commands'
import type { answered, refused } from '@core/command'
import type { MainIpc, PreloadIpc } from '@core/ipc'
import type { SettingKey, SettingKeys, setting } from '@core/settings'
import type { PluginUi, fill, slot } from '@core/ui'
import type { PromptContext, composePrompt, fillSlots, fillsGained } from '@core/prompt'
import type { pluginStateOf } from '@core/switches'
import * as moments from '@core/moment'
import type { Hears, Moment, Moments } from '@core/moment'
import { PLUGINS } from '@plugins/list'
import { PLUGIN_UIS } from '@plugins/uis'
import * as windowSlots from '@renderer/slots'

type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false

const same = <A, B>(holds: Same<A, B>): Same<A, B> => holds

interface Probe {
  probe: true
}

type V1Agent = 'claude' | 'codex' | 'muse' | 'agy'

type V1Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

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
  byAgent?: Partial<Record<V1Agent, string>>
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
    defaults: Record<V1Agent, { model?: string; effort?: V1Effort }>
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

interface V1Moment<T> {
  readonly name: string
  readonly carries?: T
  readonly heardWhileOff?: true
}

interface V1PromptContext {
  agent?: V1Agent
  facts?: readonly string[]
  values?: Readonly<Record<string, string>>
}

interface V1PromptState {
  on: Readonly<Record<string, boolean>>
  facts: readonly string[]
}

interface V1TabEnded {
  exitCode: number
  signal?: number
  unexpected?: true
  tabId: string
  asleep: boolean
  crashed: boolean
  sessionGoesOn: boolean
  left?: { treeRoot?: string; sessionId?: string }
}

type V1RunState = 'working' | 'waiting' | 'approval' | 'idle'

interface PinnedFormats {
  1: {
    manifest: V1Manifest
    eachAgent: (slot: string, textOf: (agent: V1Agent) => string) => V1TextBlock
    register: (handlers: Readonly<Record<string, V1Verb>>) => void
    answered: (text: string) => V1Reply
    refused: (text: string, exit?: number) => V1Reply
    mainIpc: V1MainIpc
    preloadIpc: V1PreloadIpc
    settingKey: V1SettingKey<Probe>
    settingKeys: Readonly<Record<string, V1SettingKey<unknown>>>
    setting: <T>(key: V1SettingKey<T>) => V1SettingKey<T>
    pluginUi: {
      parts?: Readonly<Record<string, ComponentType>>
      fills?: readonly V1SlotFill[]
    }
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
    fillsGained: (slots: readonly string[], was: V1PromptState, now: V1PromptState) => string[]
    pluginStateOf: (id: string) => { on: boolean; offBecause?: V1Manifest }
    carries: {
      FILE_OPENED: { tabId: string; target: string; view?: 'render' | 'diff' | 'source' }
      SESSION_STARTING: { helper: boolean }
      SESSION_STARTED: { by: string; tabId: string; workspace: string; name?: string }
      TAB_EXITED: V1TabEnded
      TAB_TORN_DOWN: V1TabEnded
      TAB_FORGOTTEN: string
      TURN_STARTED: string
      TURN_ENDED: {
        tabId: string
        turn: {
          said: { who: 'owner' | 'peer' | 'assistant'; text: string; at: number }[]
          reply: string
          at: number
        }
      }
      QUESTION_ASKED: {
        tabId: string
        ask: { tool_name?: string; tool_input?: Record<string, unknown> }
      }
      SESSION_BOUND: { tabId: string; key: string; idleCompaction: boolean }
      STATE_CHANGED: { tabId: string; prev: V1RunState | undefined; next: V1RunState }
      TOOL_DONE: {
        tabId: string
        call: { name: string; input: Record<string, unknown> }
        endsTheAsk: boolean
      }
      TURN_OVER: { tabId: string; over: boolean }
      ATTENTION_CHANGED: readonly {
        title?: string
        sessionId?: string
        tabId: string
        kind: 'turn-done' | 'approval' | 'exited'
        at: number
        fyi?: boolean
        wasAsking?: boolean
        stoppedByRestart?: boolean
      }[]
      TAB_STOPPING: { tabId: string; restarting: boolean }
      DIALOG_CLOSED: string
    }
    heardWhileOff: Readonly<Record<string, boolean>>
  }
}

type Pinned = PinnedFormats[typeof PLUGIN_FORMAT_VERSION]

type Flat<T> = {
  [K in keyof T]: T[K] extends (...args: never[]) => unknown
    ? T[K]
    : T[K] extends object
      ? Flat<T[K]>
      : T[K]
}

type MomentsByExportName = typeof moments

type WhatEachMomentCarries = {
  -readonly [
    K in keyof MomentsByExportName as K extends Uppercase<K & string> ? K : never
  ]: MomentsByExportName[K] extends Moment<infer T> ? Flat<T> : never
}

const HEARD_WHILE_OFF = true

const PINNED_MOMENT_NAMES: Record<keyof PinnedFormats, Pinned['heardWhileOff']> = {
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

const isNamed = (m: unknown): m is { name: string; heardWhileOff?: true } =>
  typeof m === 'object' && m !== null && 'name' in m && typeof m.name === 'string'

describe('the plugin format', () => {
  it('a manifest and every registry keep the shape pinned for their format version, so a change fails the typecheck until it is pinned or the version goes up', () => {
    const typedOnly = (): void => {
      same<PluginManifest, Pinned['manifest']>(true)
      same<typeof eachAgent, Pinned['eachAgent']>(true)
      same<Commands['register'], Pinned['register']>(true)
      same<typeof answered, Pinned['answered']>(true)
      same<typeof refused, Pinned['refused']>(true)
      same<MainIpc, Pinned['mainIpc']>(true)
      same<PreloadIpc, Pinned['preloadIpc']>(true)
      same<SettingKey<Probe>, Pinned['settingKey']>(true)
      same<SettingKeys, Pinned['settingKeys']>(true)
      same<typeof setting, Pinned['setting']>(true)
      same<PluginUi, Pinned['pluginUi']>(true)
      same<typeof slot, Pinned['slot']>(true)
      same<typeof fill, Pinned['fill']>(true)
      same<Moment<Probe>, Pinned['moment']>(true)
      same<Hears<Probe>, Pinned['hears']>(true)
      same<Moments['listen'], Pinned['listen']>(true)
      same<Moments['announce'], Pinned['announce']>(true)
      same<PromptContext, Pinned['promptContext']>(true)
      same<typeof composePrompt, Pinned['composePrompt']>(true)
      same<typeof fillSlots, Pinned['fillSlots']>(true)
      same<typeof fillsGained, Pinned['fillsGained']>(true)
      same<typeof pluginStateOf, Pinned['pluginStateOf']>(true)
      same<WhatEachMomentCarries, Flat<Pinned['carries']>>(true)
    }
    void typedOnly
  })

  it('the moments keep the names and the heard-while-off marks pinned for their format version', () => {
    const now = Object.values(moments as Record<string, unknown>).filter(isNamed)
    expect(Object.fromEntries(now.map((m) => [m.name, m.heardWhileOff ?? false]))).toEqual(
      PINNED_MOMENT_NAMES[PLUGIN_FORMAT_VERSION]
    )
  })
})

const REFERENCE = fs
  .readFileSync(path.join(__dirname, '..', '..', 'docs', 'plugin-format.md'), 'utf8')
  .replace(/^[ \t]*```[\s\S]*?^[ \t]*```[ \t]*$/gm, '')

const SECTIONS = new Map<string, string>()
for (const section of REFERENCE.split(/^#{2,3} /m)) {
  const [title, ...body] = section.split('\n')
  if (SECTIONS.has(title.trim()))
    throw new Error(`docs/plugin-format.md has two sections "${title.trim()}"`)
  SECTIONS.set(title.trim(), body.join('\n'))
}

const ANY_NAME_AFTER = /^[a-z]+(?:-[a-z]+)*-…$/

const unnamedIn = (titles: readonly string[], names: Iterable<string>): string[] => {
  const named = new Set(
    titles.flatMap((title) => {
      const body = SECTIONS.get(title)
      if (body === undefined) throw new Error(`docs/plugin-format.md has no section "${title}"`)
      return [...body.matchAll(/`([^`]+)`/g)].map((m) => m[1].replace(/\s+/g, ' '))
    })
  )
  const prefixes = [...named].filter((n) => ANY_NAME_AFTER.test(n)).map((n) => n.slice(0, -1))
  return [...new Set(names)].filter(
    (name) => !named.has(name) && !prefixes.some((p) => name.startsWith(p))
  )
}

describe('the plugin format reference names every registration a built-in plugin uses, in the section about it', () => {
  it('every manifest field a built-in plugin fills', () => {
    expect(
      unnamedIn(
        ['Required fields', 'Optional fields'],
        PLUGINS.flatMap((p) => Object.keys(p))
      )
    ).toEqual([])
  })

  it('every plugin, with its commands and setting keys', () => {
    expect(
      unnamedIn(
        ['The plugins'],
        PLUGINS.flatMap((p) => [
          p.id,
          ...(p.commands ?? []).map((c) => c.verb),
          ...(p.settings?.keys ?? [])
        ])
      )
    ).toEqual([])
  })

  it('every Assist job', () => {
    expect(
      unnamedIn(
        ['Assist jobs'],
        PLUGINS.flatMap((p) => (p.assistJobs ?? []).map((j) => j.id))
      )
    ).toEqual([])
  })

  it('every tip', () => {
    expect(
      unnamedIn(
        ['Tips'],
        PLUGINS.flatMap((p) => p.hints ?? [])
      )
    ).toEqual([])
  })

  it('every UI entry and the place it is drawn', () => {
    expect(
      unnamedIn(
        ['UI entries and slots'],
        PLUGINS.flatMap((p) => (p.ui ?? []).flatMap((e) => [e.id, e.place]))
      )
    ).toEqual([])
  })

  it('every moment a plugin announces or listens to', () => {
    expect(
      unnamedIn(
        ['Moments'],
        PLUGINS.flatMap((p) => [...(p.moments?.announces ?? []), ...(p.moments?.listens ?? [])])
      )
    ).toEqual([])
  })

  it('every text slot a plugin fills, and every fact a block waits on', () => {
    expect(
      unnamedIn(
        ['Text blocks'],
        PLUGINS.flatMap((p) => (p.text ?? []).flatMap((b) => [b.slot, ...(b.when ? [b.when] : [])]))
      )
    ).toEqual([])
  })

  it('every window slot core offers and every slot a plugin fills', () => {
    const offered = Object.values(windowSlots as Record<string, unknown>).filter(isNamed)
    const filled = Object.values(PLUGIN_UIS).flatMap((ui) => (ui.fills ?? []).map((f) => f.slot))
    expect(
      unnamedIn(
        ['UI entries and slots'],
        [...offered, ...filled].map((s) => s.name)
      )
    ).toEqual([])
  })
})
