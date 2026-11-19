// ADR-0051
import type { ArtifactView, TerminalExit } from '@shared/types'
import type { PluginManifest } from './plugin'

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

export interface TabEnded extends Pick<TerminalExit, 'exitCode' | 'signal' | 'unexpected'> {
  tabId: string
  asleep: boolean
  crashed: boolean
  sessionGoesOn: boolean
  left?: { treeRoot?: string; sessionId?: string }
}

export interface Moment<T> {
  readonly name: string
  readonly carries?: T
}

const named = <T>(name: string): Moment<T> => ({ name })

export const FILE_OPENED = named<FileOpened>('file-opened')
export const SESSION_STARTING = named<SessionStarting>('session-starting')
export const SESSION_STARTED = named<SessionStarted>('session-started')
export const TAB_EXITED = named<TabEnded>('tab-exited')
export const TAB_TORN_DOWN = named<TabEnded>('tab-torn-down')
export const TAB_FORGOTTEN = named<string>('tab-forgotten')

export type Hears<T> = (moment: T) => unknown

interface Listener {
  at: number
  hear: Hears<never>
}

export class Moments {
  private listeners = new Map<string, readonly Listener[]>()

  constructor(
    private plugins: readonly PluginManifest[],
    private failed: (error: unknown) => void
  ) {}

  listen<T>(pluginId: string, moment: Moment<T>, hear: Hears<T>): () => void {
    const at = this.plugins.findIndex((p) => p.id === pluginId)
    if (at < 0) throw new Error(`"${pluginId}" is not on the list of plugins`)
    if (!this.plugins[at].moments?.listens?.includes(moment.name))
      throw new Error(
        `plugin ${pluginId} listens to "${moment.name}", which its manifest does not list`
      )
    this.mustBeAnnounced(moment)
    const listener: Listener = { at, hear }
    const after = [...(this.listeners.get(moment.name) ?? []), listener]
    this.listeners.set(
      moment.name,
      after.sort((a, b) => a.at - b.at)
    )
    return () =>
      this.listeners.set(
        moment.name,
        (this.listeners.get(moment.name) ?? []).filter((l) => l !== listener)
      )
  }

  announce<T>(moment: Moment<T>, m: T): Promise<string[]> {
    this.mustBeAnnounced(moment)
    const said = (this.listeners.get(moment.name) ?? []).map(({ hear }) => {
      try {
        return Promise.resolve((hear as Hears<T>)(m)).catch(this.failed)
      } catch (error) {
        this.failed(error)
        return undefined
      }
    })
    return Promise.all(said).then((all) =>
      all.filter((s): s is string => typeof s === 'string' && !!s)
    )
  }

  private mustBeAnnounced(moment: Moment<unknown>): void {
    if (!this.plugins.some((p) => p.moments?.announces?.includes(moment.name)))
      throw new Error(`"${moment.name}" is announced by no plugin's manifest`)
  }
}
