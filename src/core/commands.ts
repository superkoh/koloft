// ADR-0051
import type { PluginManifest } from './plugin'
import { EXIT_USAGE, refused, type AgentCaller, type AgentReply, type AgentVerb } from './command'
import { errorText } from './errorText'
import { turnedOffLine } from './switches'

export type CommandHandlers = Readonly<Record<string, AgentVerb>>

export class Commands {
  private handlers = new Map<string, { run: AgentVerb; plugin: PluginManifest }>()

  constructor(private plugins: readonly PluginManifest[]) {}

  register(handlers: CommandHandlers): void {
    for (const [verb, run] of Object.entries(handlers)) {
      const plugin = this.plugins.find((p) => p.commands?.some((c) => c.verb === verb))
      if (!plugin) throw new Error(`"${verb}" is registered, but no plugin's manifest lists it`)
      if (this.handlers.has(verb)) throw new Error(`"${verb}" is registered twice`)
      this.handlers.set(verb, { run, plugin })
    }
  }

  async dispatch(verb: string, args: string[], caller: AgentCaller): Promise<AgentReply> {
    const handler = this.handlers.get(verb)
    if (!handler)
      return refused(
        `koloft: there is no "${verb}" command. Run "koloft help" to see the commands.`,
        EXIT_USAGE
      )
    const off = turnedOffLine(handler.plugin)
    if (off) return refused(`koloft: ${off}`)
    try {
      return await handler.run(args, caller)
    } catch (error) {
      return refused(`koloft: ${errorText(error)}`)
    }
  }
}
