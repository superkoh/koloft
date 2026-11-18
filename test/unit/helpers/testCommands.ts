import { PLUGIN_FORMAT_VERSION, type PluginManifest } from '../../../src/core/plugin'
import { Commands, type CommandHandlers } from '../../../src/core/commands'

export const testManifest = (id: string, verbs: string[]): PluginManifest => ({
  formatVersion: PLUGIN_FORMAT_VERSION,
  id,
  name: id,
  mandatory: true,
  needs: [],
  commands: verbs.map((verb) => ({ verb }))
})

export function testCommands(handlers: CommandHandlers): Commands {
  const commands = new Commands([testManifest('test', Object.keys(handlers))])
  commands.register(handlers)
  return commands
}
