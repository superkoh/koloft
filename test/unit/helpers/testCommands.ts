import { PLUGIN_FORMAT_VERSION } from '../../../src/core/plugin'
import { Commands, type CommandHandlers } from '../../../src/core/commands'

export function testCommands(handlers: CommandHandlers): Commands {
  const commands = new Commands([
    {
      formatVersion: PLUGIN_FORMAT_VERSION,
      id: 'test',
      name: 'Test',
      mandatory: true,
      needs: [],
      commands: Object.keys(handlers).map((verb) => ({ verb }))
    }
  ])
  commands.register(handlers)
  return commands
}
