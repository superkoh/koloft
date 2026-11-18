import { describe, expect, it } from 'vitest'
import { PLUGIN_FORMAT_VERSION, type PluginManifest } from '../../src/core/plugin'
import { answered } from '../../src/core/command'
import { Commands } from '../../src/core/commands'
import { PLUGINS } from '../../src/plugins/list'

const manifest = (id: string, verbs: string[]): PluginManifest => ({
  formatVersion: PLUGIN_FORMAT_VERSION,
  id,
  name: id,
  mandatory: true,
  needs: [],
  commands: verbs.map((verb) => ({ verb }))
})

describe('koloft commands', () => {
  it('no two plugins list the same koloft command, so each command has one owner', () => {
    const verbs = PLUGINS.flatMap((p) => (p.commands ?? []).map((c) => c.verb))
    expect(new Set(verbs).size).toBe(verbs.length)
  })

  it('only a command some plugin lists may be registered, and none twice', () => {
    const commands = new Commands([manifest('a', ['one'])])
    const run = (): ReturnType<typeof answered> => answered('')
    expect(() => commands.register({ two: run })).toThrow()
    commands.register({ one: run })
    expect(() => commands.register({ one: run })).toThrow()
  })
})
