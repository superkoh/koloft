import { describe, expect, it } from 'vitest'
import { answered } from '../../src/core/command'
import { Commands } from '../../src/core/commands'
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
})
