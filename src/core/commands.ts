// ADR-0051
import type { PluginManifest } from './plugin'
import {
  EXIT_USAGE,
  refused,
  splitAtDashes,
  type AgentCaller,
  type AgentReply,
  type AgentVerb
} from './command'
import { errorText } from './errorText'

export type CommandHandlers = Readonly<Record<string, AgentVerb>>

interface Registered {
  plugin: string
  run: AgentVerb
}

const HELP = 'help'

function asksForHelp(argv: string[]): boolean {
  return splitAtDashes(argv).before.includes('--help')
}

export class Commands {
  private registered = new Map<string, Registered>()

  constructor(private plugins: readonly PluginManifest[]) {}

  register(pluginId: string, handlers: CommandHandlers): void {
    const declared = this.plugins.find((p) => p.id === pluginId)?.commands ?? []
    for (const [verb, run] of Object.entries(handlers)) {
      if (!declared.some((c) => c.verb === verb))
        throw new Error(`plugin ${pluginId} registers "${verb}", which its manifest does not list`)
      const taken = this.registered.get(verb)
      if (taken) throw new Error(`"${verb}" is already registered by plugin ${taken.plugin}`)
      this.registered.set(verb, { plugin: pluginId, run })
    }
  }

  async dispatch(argv: string[], caller: AgentCaller): Promise<AgentReply> {
    const [verb = HELP, ...rest] = asksForHelp(argv) ? [HELP] : argv
    const found = this.registered.get(verb)
    if (!found)
      return refused(
        `koloft: there is no "${verb}" command. Run "koloft help" to see the commands.`,
        EXIT_USAGE
      )
    try {
      return await found.run(rest, caller)
    } catch (error) {
      return refused(`koloft: ${errorText(error)}`)
    }
  }
}
