import { didNotRun, slashCommandProblem } from '@shared/slashCommands'
import { errorText } from '../agentRequests'
import {
  COMMAND_INTERACTION,
  COMPONENT_INTERACTION,
  FORM_SUBMIT_INTERACTION,
  NO_MENTIONS,
  privately,
  type DiscordInteraction,
  type SlashCommandSpec
} from './link'

const STRING_OPTION = 3
const REPLY = 4

// PLATFORM§39
export const SLASH_COMMANDS: SlashCommandSpec[] = [
  {
    name: 'run',
    description: 'Type a slash command into your butler',
    options: [
      {
        type: STRING_OPTION,
        name: 'command',
        description: 'The command, like /context or /model haiku',
        required: true
      }
    ]
  },
  {
    name: 'clear',
    description: 'Start a new conversation with your butler (/clear)'
  },
  {
    name: 'compact',
    description: 'Compact your butler’s conversation (/compact)',
    options: [{ type: STRING_OPTION, name: 'focus', description: 'What the summary should keep' }]
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

export interface InteractionDeps {
  owner(): string | undefined
  isButlerChannel(channelId: string): boolean
  run(text: string): Promise<string>
  press(i: DiscordInteraction): Promise<void>
  submit(i: DiscordInteraction): Promise<void>
  respond(i: DiscordInteraction, body: unknown): Promise<unknown>
}

export class Interactions {
  constructor(private d: InteractionDeps) {}

  async handle(i: DiscordInteraction): Promise<void> {
    if (!this.d.isButlerChannel(i.channelId)) return
    if (i.type === COMPONENT_INTERACTION) return this.d.press(i).catch(() => undefined)
    if (i.type === FORM_SUBMIT_INTERACTION) return this.d.submit(i).catch(() => undefined)
    if (i.type !== COMMAND_INTERACTION) return
    if (i.userId !== this.d.owner()) return this.reply(i, privately(ONLY_THE_OWNER))
    const text = commandTextOf(i)
    const problem = slashCommandProblem(text)
    if (problem) return this.reply(i, privately(didNotRun(problem)))
    let content: string
    try {
      content = await this.d.run(text)
    } catch (error) {
      content = `⚠ ${errorText(error)}`
    }
    await this.reply(i, { type: REPLY, data: { content, allowed_mentions: NO_MENTIONS } })
  }

  private async reply(i: DiscordInteraction, body: unknown): Promise<void> {
    await this.d.respond(i, body).catch(() => undefined)
  }
}
