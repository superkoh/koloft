// ADR-0051
import type { Commands } from './commands'
import type { MainIpc } from './ipc'
import type { Moments } from './moment'
import type { PluginManifest } from './plugin'

export interface PluginCore {
  commands: Commands
  moments: Moments
  ipc: MainIpc
}

export type PluginStart<D, R = void> = (core: PluginCore, deps: D) => R

type Starts = Readonly<Record<string, PluginStart<never, unknown>>>

export type StartDeps<S extends Starts> = { [K in keyof S]: Parameters<S[K]>[1] }

export type Started<S extends Starts> = { [K in keyof S]: ReturnType<S[K]> }

export function startPlugins<S extends Starts>(
  plugins: readonly PluginManifest[],
  starts: S,
  core: PluginCore,
  deps: StartDeps<S>
): Started<S> {
  const started: Record<string, unknown> = {}
  for (const { id } of plugins)
    if (Object.hasOwn(starts, id))
      started[id] = (starts[id] as PluginStart<unknown, unknown>)(core, deps[id])
  return started as Started<S>
}
