import fs from 'fs'
import path from 'path'
import type { ConductorSaveResult } from '@shared/types'
import {
  answered,
  EXIT_USAGE,
  refused,
  splitAtDashes,
  type AgentReply,
  type AgentVerb
} from './agentRequests'
import { BYTES_PER_FILE, type DiscordFile } from './discord/link'
import { DISCORD_SETUP_STEPS } from './discord/setupSteps'

export const DISCORD_USAGE =
  'koloft: usage: koloft discord send <file>... [-- "<text>"] | setup | status | token --from-page | reload | invite | bind --new-channel'
export const NOT_THE_BUTLER =
  'koloft: only the butler bound to a Discord channel can send to Discord.'

const MB = 1024 * 1024

export interface DiscordVerbDeps {
  channelOf(tabId: string): string | undefined
  send(channelId: string, files: DiscordFile[], text: string): Promise<void>
  status(): string
  tokenFromPage(tabId: string): Promise<string>
  reload(tabId: string): Promise<string>
  invite(): string | null
  bindNewChannel(): Promise<ConductorSaveResult>
}

async function send(
  d: DiscordVerbDeps,
  rest: string[],
  tabId: string,
  cwd: string
): Promise<AgentReply> {
  const channelId = d.channelOf(tabId)
  if (!channelId) return refused(NOT_THE_BUTLER)
  const { before: names, after: text } = splitAtDashes(rest)
  if (!names.length && !text) return refused(DISCORD_USAGE, EXIT_USAGE)
  const files: DiscordFile[] = []
  for (const name of names) {
    const full = path.resolve(cwd, name)
    let size: number
    try {
      const st = fs.statSync(full)
      if (!st.isFile()) return refused(`koloft: ${name} is not a file.`)
      size = st.size
    } catch {
      return refused(`koloft: cannot read ${name}.`)
    }
    if (size > BYTES_PER_FILE)
      return refused(`koloft: File too large (${(size / MB).toFixed(1)} MB); the limit is 20 MB.`)
    files.push({ name: path.basename(full), data: fs.readFileSync(full) })
  }
  await d.send(channelId, files, text)
  return answered('Sent to Discord.')
}

async function setup(
  d: DiscordVerbDeps,
  sub: string,
  rest: string[],
  tabId: string
): Promise<AgentReply> {
  if (sub === 'setup' && !rest.length) return answered(DISCORD_SETUP_STEPS)
  if (sub === 'status' && !rest.length) return answered(d.status())
  if (sub === 'token' && rest.length === 1 && rest[0] === '--from-page')
    return answered(await d.tokenFromPage(tabId))
  if (sub === 'reload' && !rest.length) return answered(await d.reload(tabId))
  if (sub === 'invite' && !rest.length) {
    const url = d.invite()
    return url ? answered(url) : refused('koloft: save the bot token first.')
  }
  if (sub === 'bind' && rest.length === 1 && rest[0] === '--new-channel') {
    const r = await d.bindNewChannel()
    return r.ok ? answered('Bound to a new channel.') : refused(`koloft: ${r.error}`)
  }
  return refused(DISCORD_USAGE, EXIT_USAGE)
}

// PLATFORM§39
export function discordVerb(d: DiscordVerbDeps): AgentVerb {
  return async (args, caller) => {
    const [sub, ...rest] = args
    if (sub === 'send') return send(d, rest, caller.tabId, caller.cwd)
    return setup(d, sub, rest, caller.tabId)
  }
}
