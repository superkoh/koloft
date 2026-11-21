import { describe, it, expect } from 'vitest'
import { PLUGIN_FORMAT_VERSION, type PluginManifest } from '@core/plugin'
import { startPlugins, type PluginCore } from '@core/pluginStart'

const manifest = (id: string): PluginManifest => ({
  formatVersion: PLUGIN_FORMAT_VERSION,
  id,
  name: id,
  does: id,
  mandatory: true,
  needs: []
})

const core = {} as PluginCore

describe('starting the plugins', () => {
  it('calls each start once in the order of the list, with its own deps, and gives back what each start returned', () => {
    const calls: string[] = []
    const started = startPlugins(
      [manifest('a'), manifest('b'), manifest('c')],
      {
        c: (_core: PluginCore, d: string) => {
          calls.push(`c ${d}`)
          return d.length
        },
        a: (_core: PluginCore, d: string) => {
          calls.push(`a ${d}`)
        }
      },
      core,
      { a: 'one', c: 'three' }
    )
    expect(calls).toEqual(['a one', 'c three'])
    expect(started).toEqual({ a: undefined, c: 5 })
  })

  it('a start given for an id not on the list throws, and starts nothing', () => {
    let ran = false
    expect(() =>
      startPlugins(
        [manifest('a')],
        {
          a: () => {
            ran = true
          },
          'a-typo': () => {}
        },
        core,
        { a: undefined, 'a-typo': undefined }
      )
    ).toThrow('a start is given for "a-typo", which is not on the list of plugins')
    expect(ran).toBe(false)
  })
})
