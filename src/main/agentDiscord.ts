import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import type { ConductorSaveResult } from '@shared/types'
import { routeFor, schemeOf } from '@shared/browserRoute'
import {
  answered,
  EXIT_USAGE,
  refused,
  splitAtDashes,
  type AgentReply,
  type AgentVerb
} from './agentRequests'
import { BYTES_PER_FILE, MB, type DiscordFile } from './discord/link'
import { DISCORD_SETUP_STEPS } from './discord/setupSteps'
import type { PagePictures } from './discord/pageShot'

export const DISCORD_USAGE =
  'koloft: usage: koloft discord send <file>... [-- "<text>"] | shot <file or web address> [-- "<text>"] | setup | status | token --from-page | reload | invite | bind --new-channel'
export const NOT_A_PAGE =
  'koloft: give one HTML file that is there, or one web address that starts with http:// or https:// (like http://localhost:5173).'
export const NOT_THE_BUTLER =
  'koloft: only the butler bound to a Discord channel can send to Discord.'

export interface DiscordVerbDeps {
  channelOf(tabId: string): string | undefined
  send(channelId: string, files: DiscordFile[], text: string): Promise<void>
  shoot(url: string): Promise<PagePictures>
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

function pageUrl(target: string, cwd: string): string | undefined {
  const route = routeFor(schemeOf(target) ? target : path.resolve(cwd, target), 'agent')
  if (route.dest !== 'browser') return undefined
  if (schemeOf(route.target) !== 'file:') return route.target
  return fs.statSync(fileURLToPath(route.target), { throwIfNoEntry: false })?.isFile()
    ? route.target
    : undefined
}

async function shot(
  d: DiscordVerbDeps,
  rest: string[],
  tabId: string,
  cwd: string
): Promise<AgentReply> {
  const channelId = d.channelOf(tabId)
  if (!channelId) return refused(NOT_THE_BUTLER)
  const { before, after: text } = splitAtDashes(rest)
  if (before.length !== 1) return refused(DISCORD_USAGE, EXIT_USAGE)
  const url = pageUrl(before[0], cwd)
  if (!url) return refused(NOT_A_PAGE)
  const { files, shown, page } = await d.shoot(url)
  await d.send(channelId, files, text)
  const sent =
    files.length === 1
      ? 'Sent a picture of the page to Discord.'
      : `Sent the page to Discord as ${files.length} pictures, top to bottom.`
  return answered(
    [
      sent,
      shown.height < page.height &&
        `The page is ${page.height} pixels tall; the pictures stop at ${shown.height}.`,
      shown.width < page.width &&
        `The page is ${page.width} pixels wide; the pictures show its left ${shown.width}.`
    ]
      .filter(Boolean)
      .join(' ')
  )
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
    if (sub === 'shot') return shot(d, rest, caller.tabId, caller.cwd)
    return setup(d, sub, rest, caller.tabId)
  }
}
