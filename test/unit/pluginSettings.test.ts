import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { PLUGIN_FORMAT_VERSION, type PluginManifest } from '@core/plugin'
import { registerSettings, setting, type SettingKeys } from '@core/settings'
import { PLUGINS } from '@plugins/list'
import { PLUGIN_SETTINGS } from '@plugins/settings'

const manifest = (id: string, keys: string[]): PluginManifest => ({
  formatVersion: PLUGIN_FORMAT_VERSION,
  id,
  name: id,
  mandatory: true,
  needs: [],
  settings: { keys }
})

const text = setting<string>({
  default: '',
  clean: (raw) => (typeof raw === 'string' ? raw.trim() : '')
})

const PLUGIN_FOLDERS = path.join(__dirname, '..', '..', 'src', 'plugins')

describe('setting keys a plugin registers', () => {
  it('a plugin registers exactly the keys its manifest lists, no key twice, only for a plugin on the list, and hands records only to a key some plugin registers', () => {
    const a = manifest('a', ['one'])
    expect(() => registerSettings([a], { a: { one: text, two: text } })).toThrow(
      'plugin a registers setting "two", which its manifest does not list'
    )
    expect(() => registerSettings([a], { a: {} })).toThrow(
      'plugin a lists setting "one" but registers none'
    )
    const b = manifest('b', ['one'])
    expect(() => registerSettings([a, b], { a: { one: text }, b: { one: text } })).toThrow(
      'setting "one" is listed twice'
    )
    expect(() => registerSettings([a], { a: { one: text }, c: {} })).toThrow(
      '"c", which is not on the list of plugins'
    )
    const handing: SettingKeys = { one: { ...text, handsTo: { nobody: () => [] } } }
    expect(() => registerSettings([a], { a: handing })).toThrow(
      'setting "one" hands records to "nobody", which no plugin registers'
    )
  })

  it('cleans each key from its saved value, or from its default when nothing was saved, and gives a key the records other keys hand it, in the order of the list of plugins', () => {
    const seen: unknown[] = []
    const keys = registerSettings(
      [manifest('a', ['one']), manifest('b', ['two']), manifest('c', ['three'])],
      {
        a: { one: { ...text, handsTo: { three: (raw) => [`from one: ${String(raw)}`] } } },
        b: { two: { ...text, default: 'b default', handsTo: { three: (raw) => [raw] } } },
        c: {
          three: setting<number>({
            default: 0,
            clean: (raw, saved, handed) => {
              seen.push({ raw, saved, handed })
              return handed.length
            }
          })
        }
      }
    )
    expect(keys.defaults).toEqual({ one: '', two: 'b default', three: 0 })
    expect(keys.clean({ one: ' x ', other: 1 })).toEqual({ one: 'x', two: 'b default', three: 2 })
    expect(seen).toEqual([
      { raw: 0, saved: { one: ' x ', other: 1 }, handed: ['from one:  x ', 'b default'] }
    ])
  })

  it('says which keys a reset leaves alone, which only the main process writes and which older keys go, each as its key says', () => {
    const keys = registerSettings([manifest('a', ['one', 'two'])], {
      a: {
        one: { ...text, keptOnReset: true, retires: ['oldOne'] },
        two: { ...text, writtenByMainOnly: true }
      }
    })
    expect(keys.keptOnReset).toEqual(['one'])
    expect(keys.writtenByMainOnly).toEqual(['two'])
    expect(keys.retired).toEqual(['oldOne'])
  })

  it('the list of settings holds the shared/settings.ts of every plugin folder that has one, keyed by its id, and the app registers them without a complaint', () => {
    const withSettings = fs
      .readdirSync(PLUGIN_FOLDERS)
      .filter((id) => fs.existsSync(path.join(PLUGIN_FOLDERS, id, 'shared', 'settings.ts')))
    expect(Object.keys(PLUGIN_SETTINGS).sort()).toEqual(withSettings.sort())
    expect(() => registerSettings(PLUGINS, PLUGIN_SETTINGS)).not.toThrow()
  })
})
