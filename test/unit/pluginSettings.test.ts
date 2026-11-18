import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { PLUGIN_FORMAT_VERSION, type PluginManifest, type SettingsPage } from '@core/plugin'
import { registerSettings, setting, settingsPages, type SettingKeys } from '@core/settings'
import { PLUGINS } from '@plugins/list'
import { PLUGIN_SETTINGS } from '@plugins/settings'
import { APP_DEFAULT_SETTINGS } from '@shared/types'

const manifest = (id: string, keys: string[], needs: string[] = []): PluginManifest => ({
  formatVersion: PLUGIN_FORMAT_VERSION,
  id,
  name: id,
  mandatory: true,
  needs,
  settings: { keys }
})

const text = setting<string>({
  default: '',
  clean: (raw) => (typeof raw === 'string' ? raw.trim() : '')
})

const PLUGIN_FOLDERS = path.join(__dirname, '..', '..', 'src', 'plugins')

describe('setting keys a plugin registers', () => {
  it('a plugin registers exactly the keys its manifest lists, no key twice, and only for a plugin on the list', () => {
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
  })

  it('a key hands records only to a key some plugin registers, of its own plugin or of one its plugin needs', () => {
    const handing = (into: string): SettingKeys => ({
      one: { ...text, handsTo: { [into]: () => [] } }
    })
    expect(() => registerSettings([manifest('a', ['one'])], { a: handing('nobody') })).toThrow(
      'setting "one" hands records to "nobody", which no plugin registers'
    )
    const b = manifest('b', ['two'])
    expect(() =>
      registerSettings([b, manifest('a', ['one'])], { a: handing('two'), b: { two: text } })
    ).toThrow('setting "one" hands records to "two" of plugin b, which plugin a does not need')
    expect(() =>
      registerSettings([b, manifest('a', ['one'], ['b'])], { a: handing('two'), b: { two: text } })
    ).not.toThrow()
  })

  it('cleans each key from its saved value, or from its default when nothing was saved, and gives it first what its retired keys hand it, then what other keys hand it, in the order of the list of plugins', () => {
    const seen: unknown[] = []
    const keys = registerSettings(
      [manifest('c', ['three']), manifest('a', ['one'], ['c']), manifest('b', ['two'], ['c'])],
      {
        c: {
          three: setting<number>({
            default: 0,
            clean: (raw, handed) => {
              seen.push({ raw, handed })
              return handed.length
            },
            retires: { oldThree: (raw) => [`retired: ${String(raw)}`] }
          })
        },
        a: { one: { ...text, handsTo: { three: (raw) => [`from one: ${String(raw)}`] } } },
        b: { two: { ...text, default: 'b default', handsTo: { three: (raw) => [raw] } } }
      }
    )
    expect(keys.defaults).toEqual({ three: 0, one: '', two: 'b default' })
    expect(keys.clean({ one: ' x ', oldThree: 7 })).toEqual({
      three: 3,
      one: 'x',
      two: 'b default'
    })
    expect(seen).toEqual([{ raw: 0, handed: ['retired: 7', 'from one:  x ', 'b default'] }])
  })

  it('says which keys a reset leaves alone, which only the main process writes and which older keys go, each as its key says', () => {
    const keys = registerSettings([manifest('a', ['one', 'two'])], {
      a: {
        one: { ...text, keptOnReset: true, retires: { oldOne: () => [] } },
        two: { ...text, writtenByMainOnly: true }
      }
    })
    expect(keys.keptOnReset).toEqual(['one'])
    expect(keys.writtenByMainOnly).toEqual(['two'])
    expect(keys.retired).toEqual(['oldOne'])
  })

  it('the list of settings holds the shared/settings.ts of every plugin folder that has one, keyed by its id; the app registers them; no plugin key is one of the app’s own keys, and no key a plugin retires is still in use', () => {
    const withSettings = fs
      .readdirSync(PLUGIN_FOLDERS)
      .filter((id) => fs.existsSync(path.join(PLUGIN_FOLDERS, id, 'shared', 'settings.ts')))
    expect(Object.keys(PLUGIN_SETTINGS).sort()).toEqual(withSettings.sort())
    const keys = registerSettings(PLUGINS, PLUGIN_SETTINGS)
    const appKeys = Object.keys(APP_DEFAULT_SETTINGS)
    const pluginKeys = Object.keys(keys.defaults)
    expect(pluginKeys.filter((k) => appKeys.includes(k))).toEqual([])
    expect(keys.retired.filter((k) => [...appKeys, ...pluginKeys].includes(k))).toEqual([])
  })
})

describe('a settings page a plugin registers', () => {
  const withPage = (id: string, pageIds: string[], page?: SettingsPage): PluginManifest => ({
    ...manifest(id, []),
    settings: { keys: [], ...(page ? { page } : {}) },
    ui: pageIds.map((pageId) => ({ place: 'settings-page' as const, id: pageId }))
  })
  const PAGE = { label: 'Bot', words: ['机器人'] }

  it('takes its id from the ui entry and its label and words from settings.page, in the order of the list of plugins', () => {
    expect(settingsPages([withPage('a', ['a-page'], PAGE), withPage('b', [])])).toEqual([
      { id: 'a-page', label: 'Bot', words: ['机器人'] }
    ])
  })

  it('a plugin names its page in both places or neither, and has at most one', () => {
    expect(() => settingsPages([withPage('a', ['a-page'])])).toThrow(
      'plugin a must name its settings page in settings.page and list it in ui, or neither'
    )
    expect(() => settingsPages([withPage('a', [], PAGE)])).toThrow('or neither')
    expect(() => settingsPages([withPage('a', ['one', 'two'], PAGE)])).toThrow(
      'plugin a lists more than one settings page'
    )
    expect(() => settingsPages(PLUGINS)).not.toThrow()
  })
})
