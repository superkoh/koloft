import { session, WebContentsView, type WebContents } from 'electron'
import { BYTES_PER_FILE, type DiscordFile } from './link'

const SHOT_PARTITION = 'koloft-page-shot'
const VIEW_WIDTH = 1280
const VIEW_HEIGHT = 800
// PLATFORM§16
const LONGEST_SIDE_THAT_CAPTURED_PX = 16000
const PAGE_LOADS_WITHIN_MS = 30_000
const FONTS_LOAD_WITHIN_MS = 5000
// PLATFORM§16
const A_CAPTURE_ANSWERS_WITHIN_MS = 20_000
const MOST_PICTURES = 10
const SMALLER_PICTURE_QUALITY = 80

interface Size {
  width: number
  height: number
}

interface Shot {
  format: 'png' | 'jpeg'
  data: Buffer
}

function within<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(what)), ms)
  })
  return Promise.race([work, late]).finally(() => clearTimeout(timer))
}

let partitionReady = false

function shotSession(): Electron.Session {
  const ses = session.fromPartition(SHOT_PARTITION)
  if (partitionReady) return ses
  partitionReady = true
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
  ses.on('will-download', (event) => event.preventDefault())
  return ses
}

type Clip = Size & { y: number }

export function pictureClips(page: Size, devicePixelRatio: number): Clip[] {
  const side = Math.floor(LONGEST_SIDE_THAT_CAPTURED_PX / devicePixelRatio)
  const width = Math.min(page.width, side)
  const clips: Clip[] = []
  for (let y = 0; y < page.height && clips.length < MOST_PICTURES; y += side)
    clips.push({ y, width, height: Math.min(side, page.height - y) })
  return clips
}

async function capture(wc: WebContents, clip: Clip, quality?: number): Promise<Shot> {
  const format = quality ? 'jpeg' : 'png'
  const r = (await within(
    wc.debugger.sendCommand('Page.captureScreenshot', {
      format,
      ...(quality ? { quality } : {}),
      captureBeyondViewport: true,
      clip: { x: 0, y: clip.y, width: clip.width, height: clip.height, scale: 1 }
    }),
    A_CAPTURE_ANSWERS_WITHIN_MS,
    'The page did not let Koloft take its picture in time.'
  )) as { data: string }
  return { format, data: Buffer.from(r.data, 'base64') }
}

const PAGE_STUCK = 'The page stopped answering, so Koloft could not take its picture.'
// PLATFORM§16
async function load(wc: WebContents, url: string): Promise<void> {
  await wc.loadURL(url)
  if (wc.isLoading())
    await new Promise<void>((resolve) => wc.once('did-stop-loading', () => resolve()))
}

async function pageSize(wc: WebContents): Promise<{ size: Size; ratio: number }> {
  const [metrics, ratio] = await within(
    Promise.all([
      wc.debugger.sendCommand('Page.getLayoutMetrics') as Promise<{ cssContentSize: Size }>,
      wc.executeJavaScript('window.devicePixelRatio') as Promise<number>
    ]),
    A_CAPTURE_ANSWERS_WITHIN_MS,
    PAGE_STUCK
  )
  const { width, height } = metrics.cssContentSize
  return { size: { width: Math.ceil(width), height: Math.ceil(height) }, ratio: ratio || 1 }
}

export interface PagePictures {
  files: DiscordFile[]
  shownHeight: number
  pageHeight: number
}

// PLATFORM§16
export async function shootPage(url: string): Promise<PagePictures> {
  const view = new WebContentsView({
    webPreferences: { session: shotSession(), sandbox: true, contextIsolation: true }
  })
  const wc = view.webContents
  wc.setWindowOpenHandler(() => ({ action: 'deny' }))
  view.setBounds({ x: 0, y: 0, width: VIEW_WIDTH, height: VIEW_HEIGHT })
  try {
    await within(load(wc, url), PAGE_LOADS_WITHIN_MS, 'it did not finish loading in time.').catch(
      (error: unknown) => {
        throw new Error(`Koloft could not open ${url}: ${(error as Error).message}`)
      }
    )
    await within(
      wc.executeJavaScript('document.fonts.ready.then(() => true)'),
      FONTS_LOAD_WITHIN_MS,
      'fonts'
    ).catch(() => undefined)
    wc.debugger.attach('1.3')
    const { size, ratio } = await pageSize(wc)
    const clips = pictureClips(size, ratio)
    const last = clips.at(-1)
    if (!last) throw new Error(`${url} is an empty page: there is nothing to take a picture of.`)
    const files: DiscordFile[] = []
    for (const [i, clip] of clips.entries()) {
      let shot = await capture(wc, clip)
      if (shot.data.length > BYTES_PER_FILE) shot = await capture(wc, clip, SMALLER_PICTURE_QUALITY)
      const part = clips.length > 1 ? `-${i + 1}` : ''
      files.push({ name: `page${part}.${shot.format === 'png' ? 'png' : 'jpg'}`, data: shot.data })
    }
    return { files, shownHeight: last.y + last.height, pageHeight: size.height }
  } finally {
    wc.close()
  }
}
