import { routeFor, schemeOf } from '@shared/browserRoute'
import { basename, previewKindForPath } from '@shared/preview'
import { formatRemoteKey } from '@shared/remoteKey'
import type { ArtifactView } from '@shared/types'
import { errorText } from '../agentRequests'
import { BYTES_PER_FILE, MB, type DiscordFile } from './link'
import { toDiscordMarkdown } from './markdown'
import type { PageLook, PagePictures } from './pageShot'
import { isFence, splitForDiscord } from './split'
import { escapeHtml } from '@shared/escapeHtml'

export type Shown =
  | { page: string }
  | { pageOnMachine: true }
  | { markdown: string }
  | { file: string }
  | { diff: string }

export interface PhoneCopyDeps {
  shoot(url: string): Promise<PagePictures>
  shootHtml(html: string, look: PageLook): Promise<PagePictures>
  readBytes(file: string): Promise<Buffer>
  fileDiff(file: string): Promise<string>
  send(files: DiscordFile[], parts: string[]): Promise<void>
}

const MOST_MESSAGES = 10
export const DIAGRAM_IN_WORDS = '*(A diagram is here: see it on the Mac.)*'
export const REST_IN_THE_FILE = '-# The rest is in the attached file.'

export const tooLarge = (bytes: number): string =>
  `File too large (${(bytes / MB).toFixed(1)} MB); the limit is ${BYTES_PER_FILE / MB} MB.`

export function shownOf(
  target: string,
  machine: string | undefined,
  view?: ArtifactView
): Shown | undefined {
  const file = schemeOf(target) ? undefined : machine ? formatRemoteKey(machine, target) : target
  if (view === 'diff') return file ? { diff: file } : undefined
  const route = routeFor(file ?? target, 'agent')
  if (route.dest === 'browser') return machine ? { pageOnMachine: true } : { page: route.target }
  if (!file) return undefined
  return previewKindForPath(file) === 'markdown' ? { markdown: file } : { file }
}

export function picturesSent(p: PagePictures, where: string): string {
  const sent =
    p.files.length === 1
      ? `Sent a picture of the page to ${where}.`
      : `Sent the page to ${where} as ${p.files.length} pictures, top to bottom.`
  return [
    sent,
    p.shown.height < p.page.height &&
      `The page is ${p.page.height} pixels tall; the pictures stop at ${p.shown.height}.`,
    p.shown.width < p.page.width &&
      `The page is ${p.page.width} pixels wide; the pictures show its left ${p.shown.width}.`
  ]
    .filter(Boolean)
    .join(' ')
}

export function diagramsInWords(text: string): string {
  const out: string[] = []
  let fence: 'diagram' | 'code' | null = null
  for (const line of text.split('\n')) {
    if (!isFence(line)) {
      if (fence !== 'diagram') out.push(line)
      continue
    }
    if (fence) {
      if (fence === 'code') out.push(line)
      fence = null
      continue
    }
    fence = /^\s*```+\s*mermaid\b/i.test(line) ? 'diagram' : 'code'
    out.push(fence === 'diagram' ? DIAGRAM_IN_WORDS : line)
  }
  return out.join('\n')
}

function atMost(parts: string[]): string[] {
  return parts.length > MOST_MESSAGES ? [...parts.slice(0, MOST_MESSAGES), REST_IN_THE_FILE] : parts
}

const DIFF_STYLE = `body{margin:0;background:#fff;color:#1f2328;font:15px/1.5 ui-monospace,Menlo,monospace}
h1{margin:0;padding:10px 12px;background:#f6f8fa;border-bottom:1px solid #d0d7de;font:600 16px -apple-system,sans-serif}
div{padding:0 12px;white-space:pre-wrap;word-break:break-all}
.add{background:#dafbe1}.del{background:#ffebe9}.hunk{background:#ddf4ff;color:#57606a}`

function lineClass(line: string): string {
  if (line.startsWith('@@')) return 'hunk'
  if (line.startsWith('+')) return 'add'
  return line.startsWith('-') ? 'del' : ''
}

export function diffPage(name: string, diff: string): string {
  const lines = diff.replace(/\n$/, '').split('\n')
  const hunks = lines.findIndex((l) => l.startsWith('@@'))
  const rows = lines
    .slice(Math.max(hunks, 0))
    .map((l) => `<div class="${lineClass(l)}">${escapeHtml(l) || '&nbsp;'}</div>`)
  return `<!doctype html><meta charset="utf-8"><style>${DIFF_STYLE}</style><h1>${escapeHtml(name)}</h1>${rows.join('')}`
}

const PHONE_WIDTH_PX = 640
const NO_TALLER_THAN_A_SHORT_DIFF_PX = 40
const TWO_PHONE_SCREENS_PX = 1280
const MOST_PICTURES_BESIDE_THE_DIFF_FILE = 9
export const DIFF_LOOK: PageLook = {
  width: PHONE_WIDTH_PX,
  height: NO_TALLER_THAN_A_SHORT_DIFF_PX,
  pictureHeight: TWO_PHONE_SCREENS_PX,
  mostPictures: MOST_PICTURES_BESIDE_THE_DIFF_FILE
}

async function fileOf(d: PhoneCopyDeps, file: string): Promise<DiscordFile> {
  const data = await d.readBytes(file)
  if (data.length > BYTES_PER_FILE) throw new Error(tooLarge(data.length))
  return { name: basename(file), data }
}

async function copy(d: PhoneCopyDeps, shown: Shown, where: string): Promise<string> {
  if ('pageOnMachine' in shown)
    return `Koloft takes no picture of a page on another machine, so nothing was sent to ${where}; say what it shows in your reply.`
  if ('page' in shown) {
    const pictures = await d.shoot(shown.page)
    await d.send(pictures.files, [])
    return picturesSent(pictures, where)
  }
  if ('diff' in shown) {
    const diff = await d.fileDiff(shown.diff)
    if (!diff.trim()) return `It has no git changes, so nothing was sent to ${where}.`
    const name = basename(shown.diff)
    const pictures = await d.shootHtml(diffPage(name, diff), DIFF_LOOK)
    const whole = pictures.shown.height >= pictures.page.height
    const file = { name: `${name}.diff`, data: Buffer.from(diff) }
    await d.send(whole ? pictures.files : [...pictures.files, file], [])
    return whole
      ? `Sent a picture of its changes to ${where}.`
      : `Sent pictures of the start of its changes to ${where}, with the whole diff as a file.`
  }
  if ('markdown' in shown) {
    const original = await fileOf(d, shown.markdown)
    const text = toDiscordMarkdown(diagramsInWords(original.data.toString('utf8')))
    await d.send([original], atMost(splitForDiscord(text)))
    return `Sent it to ${where} as text, with the file.`
  }
  await d.send([await fileOf(d, shown.file)], [])
  return `Sent the file to ${where}.`
}

export async function sendPhoneCopy(
  d: PhoneCopyDeps,
  shown: Shown,
  where: string
): Promise<string> {
  try {
    return await copy(d, shown, where)
  } catch (error) {
    return `Koloft could not also send it to ${where}: ${errorText(error)} Say what it shows in your reply.`
  }
}
