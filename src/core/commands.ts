// ADR-0051
import type { PluginManifest } from './plugin'
import { EXIT_USAGE, refused, type AgentCaller, type AgentReply, type AgentVerb } from './command'
import { errorText } from './errorText'

export type CommandHandlers = Readonly<Record<string, AgentVerb>>

export class Commands {
  private handlers = new Map<string, AgentVerb>()

  constructor(private plugins: readonly PluginManifest[]) {}

  register(handlers: CommandHandlers): void {
    for (const [verb, run] of Object.entries(handlers)) {
      if (!this.plugins.some((p) => p.commands?.some((c) => c.verb === verb)))
        throw new Error(`"${verb}" is registered, but no plugin's manifest lists it`)
      if (this.handlers.has(verb)) throw new Error(`"${verb}" is registered twice`)
      this.handlers.set(verb, run)
    }
  }

  async dispatch(verb: string, args: string[], caller: AgentCaller): Promise<AgentReply> {
    const run = this.handlers.get(verb)
    if (!run)
      return refused(
        `koloft: there is no "${verb}" command. Run "koloft help" to see the commands.`,
        EXIT_USAGE
      )
    try {
      return await run(args, caller)
    } catch (error) {
      return refused(`koloft: ${errorText(error)}`)
    }
  }
}
