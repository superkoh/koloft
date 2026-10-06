import type { ConductorBinding } from '@shared/types'
import { didNotRun, MYSELF, slashCommandProblem } from '@shared/slashCommands'
import { errorText } from '../agentRequests'
import {
  AUTOCOMPLETE_INTERACTION,
  COMMAND_INTERACTION,
  COMPONENT_INTERACTION,
  NO_MENTIONS,
  type DiscordInteraction,
  type SlashCommandSpec
} from './link'

const STRING_OPTION = 3
const REPLY = 4
const CHOICES = 8
const ONLY_THE_SENDER_SEES_IT = 64
const MAX_CHOICES = 25
const MAX_CHOICE_CHARS = 100

const SESSION_OPTION = {
  type: STRING_OPTION,
  name: 'session',
  description: 'Which session; left out: the conductor, or in a session’s thread that session',
  autocomplete: true
}

// PLATFORM§39
export const SLASH_COMMANDS: SlashCommandSpec[] = [
  {
    name: 'run',
    description: 'Type a slash command into a session, or into this channel’s conductor',
    options: [
      {
        type: STRING_OPTION,
        name: 'command',
        description: 'The command, like /context or /model haiku',
        required: true
      },
      SESSION_OPTION
    ]
  },
  {
    name: 'clear',
    description: 'Start a new conversation in a session (/clear)',
    options: [SESSION_OPTION]
  },
  {
    name: 'compact',
    description: 'Compact a session’s conversation (/compact)',
    options: [
      SESSION_OPTION,
      { type: STRING_OPTION, name: 'focus', description: 'What the summary should keep' }
    ]
  }
]

export const ONLY_THE_OWNER = 'Only the owner Koloft is paired with can run commands here.'

function commandTextOf(i: DiscordInteraction): string {
  if (i.command === 'clear') return '/clear'
  if (i.command === 'compact') {
    const focus = (i.options.focus ?? '').trim()
    return focus ? `/compact ${focus}` : '/compact'
  }
  return (i.options.command ?? '').trim()
}

export interface SessionChoice {
  name: string
  value: string
}

export interface ChannelRoute {
  binding: ConductorBinding
  sessionKey?: string
}

export interface InteractionDeps {
  owner(): string | undefined
  routeOf(channelId: string): ChannelRoute | undefined
  choices(b: ConductorBinding): SessionChoice[]
  run(b: ConductorBinding, session: string, text: string): Promise<string>
  press(i: DiscordInteraction): Promise<void>
  respond(i: DiscordInteraction, body: unknown): Promise<unknown>
}

export class Interactions {
  constructor(private d: InteractionDeps) {}

  async handle(i: DiscordInteraction): Promise<void> {
    const route = this.d.routeOf(i.channelId)
    if (!route) return
    if (i.type === COMPONENT_INTERACTION) return this.d.press(i).catch(() => undefined)
    const b = route.binding
    const owner = i.userId === this.d.owner()
    if (i.type === AUTOCOMPLETE_INTERACTION) {
      const typed = (i.options[i.focused ?? ''] ?? '').toLowerCase()
      const choices = (owner ? this.d.choices(b) : [])
        .filter((c) => c.name.toLowerCase().includes(typed))
        .slice(0, MAX_CHOICES)
        .map((c) => ({ name: c.name.slice(0, MAX_CHOICE_CHARS), value: c.value }))
      await this.reply(i, { type: CHOICES, data: { choices } })
      return
    }
    if (i.type !== COMMAND_INTERACTION) return
    if (!owner) return this.reply(i, privately(ONLY_THE_OWNER))
    const text = commandTextOf(i)
    const problem = slashCommandProblem(text)
    if (problem) return this.reply(i, privately(didNotRun(problem)))
    let content: string
    try {
      const session = i.options.session?.trim() || route.sessionKey || MYSELF
      content = await this.d.run(b, session, text)
    } catch (error) {
      content = `⚠ ${errorText(error)}`
    }
    await this.reply(i, { type: REPLY, data: { content, allowed_mentions: NO_MENTIONS } })
  }

  private async reply(i: DiscordInteraction, body: unknown): Promise<void> {
    await this.d.respond(i, body).catch(() => undefined)
  }
}

function privately(content: string): unknown {
  return { type: REPLY, data: { content, flags: ONLY_THE_SENDER_SEES_IT } }
}
