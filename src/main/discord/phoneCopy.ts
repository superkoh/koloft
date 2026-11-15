import { fileURLToPath } from 'url'
import { pagePathOf, routeFor, schemeOf } from '@shared/browserRoute'
import { escapeHtml } from '@shared/escapeHtml'
import { basename, previewKindForPath } from '@shared/preview'
import { formatRemoteKey } from '@shared/remoteKey'
import type { ArtifactView } from '@shared/types'
import { parseUnifiedDiff, type DiffRow } from '@shared/unifiedDiff'
import { errorText } from '../agentRequests'
import { AGENT_SHIM_WAITS_MS } from '../agentShim'
import { BYTES_PER_FILE, MB, type DiscordFile } from './link'
import { toDiscordMarkdown } from './markdown'
import type { PageLook, PagePictures } from './pageShot'
import { DISCORD_MESSAGE_LIMIT, splitForDiscord } from './split'

export type Shown =
  { page: string; machine?: string } | { markdown: string } | { file: string } | { diff: string }

export interface FileDiff {
  text: string
  truncated: boolean
}

export interface PhoneCopyDeps {
  shoot(url: string, machine?: string): Promise<PagePictures>
  shootHtml(html: string, look: PageLook, shownAs: string): Promise<PagePictures>
  size(file: string): Promise<number | undefined>
  readBytes(file: string): Promise<Buffer>
  fileDiff(file: string): Promise<FileDiff>
  send(files: DiscordFile[], parts: string[]): Promise<void>
  cardsWaitFor(copy: Promise<void>): void
}

const MOST_MESSAGES = 10
const MARKDOWN_CHARS_READ = MOST_MESSAGES * DISCORD_MESSAGE_LIMIT
const THE_REPLY_REACHES_THE_SHIM_WITHIN_MS = 2000
export const COPY_REPORTED_WITHIN_MS = AGENT_SHIM_WAITS_MS - THE_REPLY_REACHES_THE_SHIM_WITHIN_MS
export const DIAGRAM_IN_WORDS = '*(A diagram is here: see it on the Mac.)*'
export const REST_IN_THE_FILE = '-# The rest is in the attached file.'

export const tooLarge = (bytes?: number): string =>
  `File too large${bytes === undefined ? '' : ` (${(bytes / MB).toFixed(1)} MB)`}; the limit is ${BYTES_PER_FILE / MB} MB.`

function pathOfFileUrl(url: string): string | undefined {
  try {
    return fileURLToPath(url)
  } catch {
    return undefined
  }
}

export function shownOf(
  target: string,
  machine: string | undefined,
  view?: ArtifactView
): Shown | undefined {
  const scheme = schemeOf(target)
  const local = !scheme
    ? target
    : scheme === 'file:' && !machine
      ? pathOfFileUrl(target)
      : undefined
  const file = local && machine ? formatRemoteKey(machine, local) : local
  if (view === 'diff') return file ? { diff: file } : undefined
  const route = routeFor(scheme ? target : (file ?? target), 'agent')
  if (route.dest === 'browser') return { page: scheme ? target : route.target, machine }
  if (!file) return undefined
  return previewKindForPath(file) === 'markdown' ? { markdown: file } : { file }
}

function nameOf(shown: Shown): string {
  if ('page' in shown) return pagePathOf(shown.page) ?? shown.page
  if ('markdown' in shown) return basename(shown.markdown)
  return basename('file' in shown ? shown.file : shown.diff)
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

const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([^\s`]*)/

export function diagramsInWords(text: string): string {
  const out: string[] = []
  let open: { mark: string; diagram: boolean } | null = null
  for (const line of text.split('\n')) {
    const fence = FENCE.exec(line)
    if (open) {
      if (!open.diagram) out.push(line)
      const mark = fence?.[1] ?? ''
      if (mark[0] === open.mark[0] && mark.length >= open.mark.length && !fence?.[2]) open = null
      continue
    }
    if (fence) open = { mark: fence[1], diagram: fence[2].toLowerCase() === 'mermaid' }
    out.push(open?.diagram ? DIAGRAM_IN_WORDS : line)
  }
  return out.join('\n')
}

// PLATFORM§64
export function markdownParts(text: string): string[] {
  const read = text.slice(0, MARKDOWN_CHARS_READ)
  const parts = splitForDiscord(toDiscordMarkdown(diagramsInWords(read)))
  return parts.length > MOST_MESSAGES || read.length < text.length
    ? [...parts.slice(0, MOST_MESSAGES - 1), REST_IN_THE_FILE]
    : parts
}

const DIFF_STYLE = `body{margin:0;background:#fff;color:#1f2328;font:15px/1.5 ui-monospace,Menlo,monospace}
h1{margin:0;padding:10px 12px;background:#f6f8fa;border-bottom:1px solid #d0d7de;font:600 16px -apple-system,sans-serif}
div{padding:0 12px;white-space:pre-wrap;word-break:break-all}
.add{background:#dafbe1}.del{background:#ffebe9}.gap{background:#ddf4ff;color:#57606a}`

const SIGN: Record<DiffRow['kind'], string> = { add: '+', del: '-', ctx: ' ' }

export function diffPage(name: string, rows: DiffRow[]): string {
  let nextOld: number | undefined
  let nextNew: number | undefined
  const lines = rows.map((row) => {
    const skipped =
      (row.oldNo !== null && nextOld !== undefined && row.oldNo !== nextOld) ||
      (row.newNo !== null && nextNew !== undefined && row.newNo !== nextNew)
    if (row.oldNo !== null) nextOld = row.oldNo + 1
    if (row.newNo !== null) nextNew = row.newNo + 1
    const gap = skipped ? '<div class="gap">⋯</div>' : ''
    return `${gap}<div class="${row.kind}">${escapeHtml(SIGN[row.kind] + row.text)}</div>`
  })
  return `<!doctype html><meta charset="utf-8"><style>${DIFF_STYLE}</style><h1>${escapeHtml(name)}</h1>${lines.join('')}`
}

const PHONE_WIDTH_PX = 640
const NO_TALLER_THAN_A_SHORT_DIFF_PX = 40
const TWO_PHONE_SCREENS_PX = 1280
const MOST_PICTURES_BESIDE_THE_DIFF_FILE = 9
const DIFF_ROW_PX = 22.5
export const DIFF_LOOK: PageLook = {
  width: PHONE_WIDTH_PX,
  height: NO_TALLER_THAN_A_SHORT_DIFF_PX,
  pictureHeight: TWO_PHONE_SCREENS_PX,
  mostPictures: MOST_PICTURES_BESIDE_THE_DIFF_FILE
}
export const DIFF_ROWS_THAT_FILL_THE_PICTURES = Math.ceil(
  (TWO_PHONE_SCREENS_PX * MOST_PICTURES_BESIDE_THE_DIFF_FILE) / DIFF_ROW_PX
)

async function fileOf(d: PhoneCopyDeps, file: string): Promise<DiscordFile> {
  const size = await d.size(file)
  if (size !== undefined && size > BYTES_PER_FILE) throw new Error(tooLarge(size))
  const data = await d.readBytes(file)
  if (data.length > BYTES_PER_FILE) throw new Error(tooLarge(data.length))
  return { name: basename(file), data }
}

// PLATFORM§64
async function diffCopy(d: PhoneCopyDeps, file: string, where: string): Promise<string> {
  const diff = await d.fileDiff(file)
  if (!diff.text.trim()) return `It has no git changes, so nothing was sent to ${where}.`
  const { rows, hasChange } = parseUnifiedDiff(diff.text)
  if (!hasChange)
    return `Its change has no lines to draw (a binary file, a rename or a mode change), so nothing was sent to ${where}; say what changed in your reply.`
  const name = basename(file)
  const shown = rows.slice(0, DIFF_ROWS_THAT_FILL_THE_PICTURES)
  const shot = await d.shootHtml(diffPage(name, shown), DIFF_LOOK, `the changes of ${name}`)
  const pictures = {
    ...shot,
    files: shot.files.map((f) => ({ ...f, name: f.name.replace(/^page/, `${name}-changes`) }))
  }
  const many = pictures.files.length === 1 ? 'a picture' : `${pictures.files.length} pictures`
  const whole =
    !diff.truncated && shown.length === rows.length && pictures.shown.height >= pictures.page.height
  if (whole) {
    await d.send(pictures.files, [])
    return `Sent ${many} of its changes to ${where}.`
  }
  const data = Buffer.from(diff.text)
  const attached = !diff.truncated && data.length <= BYTES_PER_FILE
  await d.send(attached ? [...pictures.files, { name: `${name}.diff`, data }] : pictures.files, [])
  return attached
    ? `Sent ${many} of the start of its changes to ${where}, with the whole diff as a file.`
    : `Sent ${many} of the start of its changes to ${where}; the whole diff is too long to send.`
}

async function copy(d: PhoneCopyDeps, shown: Shown, where: string): Promise<string> {
  if ('page' in shown) {
    const pictures = await d.shoot(shown.page, shown.machine)
    await d.send(pictures.files, [])
    return picturesSent(pictures, where)
  }
  if ('diff' in shown) return diffCopy(d, shown.diff, where)
  if ('markdown' in shown) {
    const original = await fileOf(d, shown.markdown)
    await d.send([original], markdownParts(original.data.toString('utf8')))
    return `Sent it to ${where} as text, with the file.`
  }
  await d.send([await fileOf(d, shown.file)], [])
  return `Sent the file to ${where}.`
}

const couldNot = (where: string, error: string): string =>
  `Koloft could not also send it to ${where}: ${error} Say what it shows in your reply.`

export const stillSending = (where: string): string =>
  `Koloft is still sending a copy to ${where}; if it cannot, it says why there.`

export const couldNotSendInRoom = (name: string, error: string): string =>
  `⚠ Koloft could not send ${name} here: ${error}`

const sayCouldNotSend = (d: PhoneCopyDeps, shown: Shown, error: string): Promise<void> =>
  d.send([], [couldNotSendInRoom(nameOf(shown), error)]).catch(() => undefined)

export async function sendWholeCopy(d: PhoneCopyDeps, shown: Shown): Promise<void> {
  await copy(d, shown, 'Discord').catch((error: unknown) =>
    sayCouldNotSend(d, shown, errorText(error))
  )
}

export async function sendPhoneCopy(
  d: PhoneCopyDeps,
  shown: Shown,
  where: string,
  reportedWithinMs = COPY_REPORTED_WITHIN_MS
): Promise<string> {
  const sending = copy(d, shown, where).then(
    (said) => ({ said }),
    (error: unknown) => ({ error: errorText(error) })
  )
  let toldStillSending = false
  d.cardsWaitFor(
    sending.then((r) =>
      toldStillSending && 'error' in r ? sayCouldNotSend(d, shown, r.error) : undefined
    )
  )
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<undefined>(
    (resolve) =>
      (timer = setTimeout(() => {
        toldStillSending = true
        resolve(undefined)
      }, reportedWithinMs))
  )
  const first = await Promise.race([sending, late])
  clearTimeout(timer)
  if (first) return 'said' in first ? first.said : couldNot(where, first.error)
  return stillSending(where)
}
