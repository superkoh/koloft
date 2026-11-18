import { describe, expect, it } from 'vitest'
import { PLUGIN_FORMAT_VERSION, type PluginManifest } from '../../src/core/plugin'
import { answered } from '../../src/core/command'
import { Commands } from '../../src/core/commands'
import { PLUGINS } from '../../src/plugins/list'
import type { SessionInfo } from '../../src/shared/types'

const manifest = (id: string, verbs: string[]): PluginManifest => ({
  formatVersion: PLUGIN_FORMAT_VERSION,
  id,
  name: id,
  mandatory: true,
  needs: [],
  commands: verbs.map((verb) => ({ verb }))
})

const caller = {
  tabId: 'pty-1',
  cwd: '/w',
  session: { tabId: 'pty-1', backendId: 'claude', host: 'local', cwd: '/w' } as SessionInfo
}

describe('koloft commands', () => {
  it("the plugins together list today's thirteen koloft commands, each in one plugin only", () => {
    const owners = PLUGINS.flatMap((p) => (p.commands ?? []).map((c) => `${c.verb} ${p.id}`))
    expect(owners.sort()).toEqual([
      'cron scheduled-tasks',
      'diff workbench',
      'discord discord',
      'gh github',
      'help sessions',
      'inbox inbox',
      'note workbench',
      'open workbench',
      'page passwords',
      'secret passwords',
      'session sessions',
      'todo todo',
      'workspace sessions'
    ])
  })

  it('a plugin may register only the commands its own manifest lists, and no command twice', () => {
    const commands = new Commands([manifest('a', ['one']), manifest('b', ['two'])])
    const run = (): ReturnType<typeof answered> => answered('')
    expect(() => commands.register('a', { two: run })).toThrow()
    expect(() => commands.register('c', { one: run })).toThrow()
    commands.register('a', { one: run })
    expect(() => commands.register('a', { one: run })).toThrow()
  })
})
