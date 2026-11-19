import { describe, it, expect } from 'vitest'
import { PLUGIN_FORMAT_VERSION, type PluginManifest } from '@core/plugin'
import type { SavedSettings } from '@core/settings'
import { cleanSwitches, pluginStates } from '@core/switches'
import { PLUGINS } from '@plugins/list'
import { DEFAULT_SETTINGS, sanitizeLoadedSettings } from '@shared/settingsOps'

const manifest = (id: string, more: Partial<PluginManifest> = {}): PluginManifest => ({
  formatVersion: PLUGIN_FORMAT_VERSION,
  id,
  name: id.toUpperCase(),
  does: id,
  mandatory: false,
  needs: [],
  ...more
})

const core = manifest('core', { mandatory: true })
const hub = manifest('hub', { needs: ['core'] })
const list = manifest('list', { needs: ['core', 'hub'] })
const bot = manifest('bot', { needs: ['core'], offUntilSetUp: 'bot' })
const LIST = [core, hub, list, bot]
const DEFAULTS: SavedSettings = { bot: {} }

const onOf = (switches: Record<string, boolean>, settings: SavedSettings = DEFAULTS) =>
  Object.fromEntries(
    Object.entries(pluginStates(LIST, { ...settings, pluginsOn: switches }, DEFAULTS)).map(
      ([id, s]) => [id, s.offBecause ? `off: ${s.offBecause.name} is off` : s.on]
    )
  )

const saved = (s: unknown): SavedSettings => s as SavedSettings

describe('which plugins are on', () => {
  it('a mandatory plugin is always on, and only an optional plugin’s choice is kept', () => {
    expect(cleanSwitches(LIST, { core: false, hub: false, bot: 'yes', gone: false })).toEqual({
      hub: false
    })
    expect(cleanSwitches(LIST, null)).toEqual({})
    expect(onOf({ core: false }).core).toBe(true)
  })

  it('an optional plugin nobody turned off is on, and one turned off is off', () => {
    expect(onOf({}, { bot: { token: 'x' } })).toEqual({
      core: true,
      hub: true,
      list: true,
      bot: true
    })
    expect(onOf({ list: false }).list).toBe(false)
  })

  it('a plugin whose need is off is off and names that need, and turning the need on again brings back its own choice', () => {
    expect(onOf({ hub: false }).list).toBe('off: HUB is off')
    expect(onOf({ hub: false, list: true }).list).toBe('off: HUB is off')
    expect(onOf({ hub: true, list: true }).list).toBe(true)
    expect(onOf({ hub: true, list: false }).list).toBe(false)
  })

  it('a plugin that starts off until set up is off while its setting is still empty, on once it holds something, and the owner’s choice wins either way', () => {
    expect(onOf({}).bot).toBe(false)
    expect(onOf({}, { bot: { channel: 'c' } }).bot).toBe(true)
    expect(onOf({ bot: true }).bot).toBe(true)
    expect(onOf({ bot: false }, { bot: { channel: 'c' } }).bot).toBe(false)
  })

  it('after an upgrade every optional plugin is on, except Discord for someone who never set it up', () => {
    const states = (doc: unknown) => {
      const s = saved(sanitizeLoadedSettings(doc))
      return Object.fromEntries(
        PLUGINS.filter((p) => !p.mandatory).map((p) => [
          p.id,
          pluginStates(PLUGINS, s, saved(DEFAULT_SETTINGS))[p.id].on
        ])
      )
    }
    const neverSetUp = { fontSize: 14 }
    const setUp = {
      fontSize: 14,
      discord: { userId: '123456789012345678', userName: 'owner' }
    }
    expect(states(neverSetUp)).toEqual({
      github: true,
      discord: false,
      todo: true,
      passwords: true,
      'docs-writing': true
    })
    expect(states(setUp).discord).toBe(true)
  })
})
