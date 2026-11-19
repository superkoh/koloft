import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { app, session, type DownloadItem, type WebContents } from 'electron'
import { BROWSER_PARTITION, type BrowserDownload } from '@shared/types'
import { safeDownloadName, suggestedDownloadName, uniqueDownloadName } from '@shared/downloadName'

import { CHANNELS } from '../shared/ipc'

export interface PageDownloadsDeps {
  push(channel: string, ...args: unknown[]): boolean
}

export class PageDownloads {
  private live = new Map<string, DownloadItem>()
  private pages = new Map<string, number>()
  private sources = new Map<string, string>()
  private retryTargets = new Map<string, string>()

  constructor(private d: PageDownloadsDeps) {}

  pagesDownloading(): number[] {
    return [...this.pages.values()]
  }

  started(item: DownloadItem, contents: WebContents | undefined): void {
    const dir = process.env.KOLOFT_DOWNLOAD_DIR || app.getPath('downloads')
    try {
      fs.mkdirSync(dir, { recursive: true })
    } catch {
      return
    }
    const name = uniqueDownloadName(
      safeDownloadName(suggestedDownloadName(item.getContentDisposition(), item.getFilename())),
      (candidate) => fs.existsSync(path.join(dir, candidate))
    )
    const savePath = path.join(dir, name)
    item.setSavePath(savePath)

    const url = item.getURL()
    const retryId = this.retryTargets.get(url)
    this.retryTargets.delete(url)
    const id = retryId ?? crypto.randomUUID()
    if (retryId) this.sources.delete(retryId)
    this.live.set(id, item)
    if (contents) this.pages.set(id, contents.id)
    this.d.push(CHANNELS.downloadEvent, {
      id,
      kind: 'started',
      name,
      total: item.getTotalBytes()
    })
    item.on('updated', (_ev, state) => {
      if (state !== 'progressing') return
      this.d.push(CHANNELS.downloadEvent, {
        id,
        kind: 'progress',
        received: item.getReceivedBytes()
      })
    })
    item.once('done', (_ev, state) => {
      this.live.delete(id)
      this.pages.delete(id)
      if (state === 'completed') this.sources.set(id, url)
      this.d.push(CHANNELS.downloadEvent, {
        id,
        kind: 'done',
        state,
        path: state === 'completed' ? savePath : undefined
      })
      if (state !== 'completed') {
        this.sources.set(id, url)
        return
      }
      const payload: BrowserDownload = { name, path: savePath }
      this.d.push(CHANNELS.download, payload)
    })
  }

  cancel(id: unknown): void {
    if (typeof id !== 'string') return
    this.live.get(id)?.cancel()
  }

  retry(id: unknown): void {
    if (typeof id !== 'string') return
    const url = this.sources.get(id)
    if (!url) return
    this.retryTargets.set(url, id)
    this.d.push(CHANNELS.downloadEvent, { id, kind: 'retrying' })
    session.fromPartition(BROWSER_PARTITION).downloadURL(url)
  }
}
