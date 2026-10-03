import fs from 'fs'
import path from 'path'
import { answered, EXIT_USAGE, refused, type AgentVerb } from './agentRequests'
import { BYTES_PER_FILE, type DiscordFile } from './discord/link'

export const DISCORD_USAGE = 'koloft: usage: koloft discord send <file>... [-- "<text>"]'
export const NOT_A_CONDUCTOR =
  'koloft: only a conductor (a session bound to a Discord channel) can send to Discord.'

const MB = 1024 * 1024

export interface DiscordVerbDeps {
  channelOf(tabId: string): string | undefined
  send(channelId: string, files: DiscordFile[], text: string): Promise<void>
}

// PLATFORM§39
export function discordVerb(d: DiscordVerbDeps): AgentVerb {
  return async (args, caller) => {
    const [sub, ...rest] = args
    if (sub !== 'send') return refused(DISCORD_USAGE, EXIT_USAGE)
    const channelId = d.channelOf(caller.tabId)
    if (!channelId) return refused(NOT_A_CONDUCTOR)
    const dashes = rest.indexOf('--')
    const names = dashes >= 0 ? rest.slice(0, dashes) : rest
    const text =
      dashes >= 0
        ? rest
            .slice(dashes + 1)
            .join(' ')
            .trim()
        : ''
    if (!names.length && !text) return refused(DISCORD_USAGE, EXIT_USAGE)
    const files: DiscordFile[] = []
    for (const name of names) {
      const full = path.resolve(caller.cwd, name)
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
}
