import { describe, expect, it } from 'vitest'
import { Moments, type Moment } from '../../src/core/moment'
import { PLUGIN_FORMAT_VERSION, type PluginManifest } from '../../src/core/plugin'
import { PLUGINS } from '../../src/plugins/list'

const OPENED: Moment<string> = { name: 'opened' }

const manifest = (
  id: string,
  moments: PluginManifest['moments'] = { listens: [OPENED.name] }
): PluginManifest => ({
  formatVersion: PLUGIN_FORMAT_VERSION,
  id,
  name: id,
  mandatory: true,
  needs: [],
  moments
})

const ANNOUNCER = manifest('core', { announces: [OPENED.name] })

function registry(ids: string[]): { moments: Moments; failed: unknown[] } {
  const failed: unknown[] = []
  const moments = new Moments(
    [ANNOUNCER, ...ids.map((id) => manifest(id))],
    (error) => void failed.push(error)
  )
  return { moments, failed }
}

describe('session moments', () => {
  it('every moment a plugin listens to is announced by some plugin, so no listener waits for nothing', () => {
    const announced = new Set(PLUGINS.flatMap((p) => p.moments?.announces ?? []))
    const heard = PLUGINS.flatMap((p) => p.moments?.listens ?? [])
    expect(heard.filter((name) => !announced.has(name))).toEqual([])
  })

  it('a plugin may listen only to a moment its manifest lists and some plugin announces', () => {
    const { moments } = registry(['a'])
    expect(() => moments.listen('nobody', OPENED, () => {})).toThrow()
    expect(() => moments.listen('core', OPENED, () => {})).toThrow()
    expect(() => moments.listen('a', { name: 'closed' }, () => {})).toThrow()
    expect(() => moments.announce({ name: 'closed' }, 'x')).toThrow()
    moments.listen('a', OPENED, () => {})
  })

  it('plugins hear a moment in the order of the plugin list, whatever order they listened in, and one plugin in the order it listened', async () => {
    const heard: string[] = []
    const { moments } = registry(['first', 'second'])
    moments.listen('second', OPENED, () => void heard.push('second'))
    moments.listen('first', OPENED, () => void heard.push('first 1'))
    moments.listen('first', OPENED, () => void heard.push('first 2'))
    await moments.announce(OPENED, 'plan.md')
    expect(heard).toEqual(['first 1', 'first 2', 'second'])
  })

  it('every listener has heard the moment by the time announce returns, before anything is awaited', () => {
    const heard: string[] = []
    const { moments } = registry(['a', 'b'])
    moments.listen('a', OPENED, async (m) => void heard.push(`a ${m}`))
    moments.listen('b', OPENED, (m) => void heard.push(`b ${m}`))
    void moments.announce(OPENED, 'plan.md')
    expect(heard).toEqual(['a plan.md', 'b plan.md'])
  })

  it('announcing returns what listeners said, in plugin order, leaving out who said nothing', async () => {
    const { moments } = registry(['a', 'b', 'c', 'd'])
    moments.listen('d', OPENED, async () => 'last')
    moments.listen('c', OPENED, async () => '')
    moments.listen('b', OPENED, async () => undefined)
    moments.listen('a', OPENED, async () => 'first')
    expect(await moments.announce(OPENED, 'plan.md')).toEqual(['first', 'last'])
  })

  it('a listener that throws or fails is reported, and the others still hear the moment and speak', async () => {
    const { moments, failed } = registry(['a', 'b', 'c'])
    moments.listen('a', OPENED, () => {
      throw new Error('a broke')
    })
    moments.listen('b', OPENED, async () => {
      throw new Error('b broke')
    })
    moments.listen('c', OPENED, async () => 'c said')
    expect(await moments.announce(OPENED, 'plan.md')).toEqual(['c said'])
    expect(failed.map(String)).toEqual(['Error: a broke', 'Error: b broke'])
  })

  it('a listener that stops listening hears no later moment', async () => {
    const heard: string[] = []
    const { moments } = registry(['a'])
    const stop = moments.listen('a', OPENED, (m) => void heard.push(m))
    await moments.announce(OPENED, 'one')
    stop()
    await moments.announce(OPENED, 'two')
    expect(heard).toEqual(['one'])
  })
})
