import { describe, expect, it } from 'vitest'
import { answered } from '../../src/core/command'
import { Commands } from '../../src/core/commands'
import { knowPluginStates } from '../../src/core/switches'
import { PLUGINS } from '../../src/plugins/list'
import { testManifest } from './helpers/testCommands'

describe('koloft commands', () => {
  it('no two plugins list the same koloft command, so each command has one owner', () => {
    const verbs = PLUGINS.flatMap((p) => (p.commands ?? []).map((c) => c.verb))
    expect(new Set(verbs).size).toBe(verbs.length)
  })

  it('only a command some plugin lists may be registered, and none twice', () => {
    const commands = new Commands([testManifest('a', ['one'])])
    const run = (): ReturnType<typeof answered> => answered('')
    expect(() => commands.register({ two: run })).toThrow()
    commands.register({ one: run })
    expect(() => commands.register({ one: run })).toThrow()
  })

  it('a command of a plugin that is off is refused with one sentence naming why, and runs again once it is on', async () => {
    const hub = { ...testManifest('hub', ['hub']), name: 'Hub', mandatory: false }
    const list = { ...testManifest('list', ['list']), name: 'List', mandatory: false }
    const commands = new Commands([hub, list])
    commands.register({ hub: () => answered('hub ran'), list: () => answered('list ran') })
    const caller = {} as Parameters<Commands['dispatch']>[2]
    try {
      knowPluginStates({ list: { on: false } })
      expect(await commands.dispatch('list', [], caller)).toMatchObject({
        exit: 1,
        text: 'koloft: List is turned off in Settings ▸ Plugins.'
      })
      knowPluginStates({ hub: { on: false }, list: { on: false, offBecause: hub } })
      expect(await commands.dispatch('list', [], caller)).toMatchObject({
        text: 'koloft: List is off because Hub is turned off in Settings ▸ Plugins.'
      })
      knowPluginStates({})
      expect(await commands.dispatch('list', [], caller)).toMatchObject({ text: 'list ran' })
    } finally {
      knowPluginStates({})
    }
  })
})
