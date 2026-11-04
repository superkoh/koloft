import { describe, expect, it } from 'vitest'
import {
  DIAGRAM_IN_WORDS,
  DIFF_LOOK,
  REST_IN_THE_FILE,
  sendPhoneCopy,
  shownOf,
  type PhoneCopyDeps
} from '../../src/main/discord/phoneCopy'
import { BYTES_PER_FILE, type DiscordFile } from '../../src/main/discord/link'
import { DISCORD_MESSAGE_LIMIT } from '../../src/main/discord/split'
import type { PageLook, PagePictures } from '../../src/main/discord/pageShot'
import { formatRemoteKey } from '../../src/shared/remoteKey'

const WHERE = 'the room'
const page = { width: 1280, height: 900 }

function deps(
  over: Partial<PhoneCopyDeps> & { bytes?: Buffer; diff?: string } = {}
): PhoneCopyDeps & {
  sent: { files: DiscordFile[]; parts: string[] }[]
} {
  const sent: { files: DiscordFile[]; parts: string[] }[] = []
  return {
    sent,
    shoot: async () => ({
      files: [{ name: 'page.png', data: Buffer.from('png') }],
      shown: page,
      page
    }),
    shootHtml: async () => ({ files: [], shown: page, page }),
    readBytes: async () => over.bytes ?? Buffer.from('bytes'),
    fileDiff: async () => over.diff ?? '',
    send: async (files, parts) => {
      sent.push({ files, parts })
    },
    ...over
  }
}

describe('what koloft open shows is sent to the phone as', () => {
  it('a picture for an HTML file or a web address, the file itself for Markdown or anything else, a diff for koloft diff', () => {
    expect(shownOf('/w/plan.html', undefined)).toEqual({ page: 'file:///w/plan.html' })
    expect(shownOf('http://localhost:5173', undefined)).toEqual({ page: 'http://localhost:5173' })
    expect(shownOf('/w/plan.md', undefined)).toEqual({ markdown: '/w/plan.md' })
    expect(shownOf('/w/shot.png', undefined)).toEqual({ file: '/w/shot.png' })
    expect(shownOf('/w/app.ts', undefined, 'diff')).toEqual({ diff: '/w/app.ts' })
  })

  it('in a session on another machine: its files are read there, and no page of it is pictured', () => {
    const on = (p: string): string => formatRemoteKey('box', p)
    expect(shownOf('/w/plan.md', 'box')).toEqual({ markdown: on('/w/plan.md') })
    expect(shownOf('/w/app.ts', 'box', 'diff')).toEqual({ diff: on('/w/app.ts') })
    expect(shownOf('/w/plan.html', 'box')).toEqual({ pageOnMachine: true })
    expect(shownOf('http://localhost:3000', 'box')).toEqual({ pageOnMachine: true })
  })
})

describe('sendPhoneCopy', () => {
  it('a page goes as its pictures, and the reply says so', async () => {
    const d = deps()
    expect(await sendPhoneCopy(d, { page: 'file:///w/plan.html' }, WHERE)).toBe(
      'Sent a picture of the page to the room.'
    )
    expect(d.sent).toEqual([{ files: [expect.objectContaining({ name: 'page.png' })], parts: [] }])
  })

  it('a page on another machine sends nothing and tells the session to say it in words', async () => {
    const d = deps()
    expect(await sendPhoneCopy(d, { pageOnMachine: true }, WHERE)).toMatch(
      /no picture of a page on another machine.*say what it shows/
    )
    expect(d.sent).toEqual([])
  })

  it('a page that cannot be pictured tells the session why, and to say it in words', async () => {
    const d = deps({
      shoot: async () => {
        throw new Error('it did not load in time.')
      }
    })
    expect(await sendPhoneCopy(d, { page: 'http://localhost:1' }, WHERE)).toBe(
      'Koloft could not also send it to the room: it did not load in time. Say what it shows in your reply.'
    )
  })

  it('Markdown goes as phone-readable text with the original file, a diagram as a line saying to look on the Mac', async () => {
    const text =
      '# Plan\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```mermaid\ngraph TD; A-->B\n```\n\n```ts\nconst x = 1\n```\n'
    const d = deps({ bytes: Buffer.from(text) })
    expect(await sendPhoneCopy(d, { markdown: '/w/plan.md' }, WHERE)).toBe(
      'Sent it to the room as text, with the file.'
    )
    const [{ files, parts }] = d.sent
    expect(files.map((f) => f.name)).toEqual(['plan.md'])
    const said = parts.join('\n')
    expect(said).toContain('**1**\n> b: 2')
    expect(said).toContain(DIAGRAM_IN_WORDS)
    expect(said).not.toContain('graph TD')
    expect(said).toContain('```ts\nconst x = 1\n```')
  })

  it('a long Markdown file goes as at most ten messages, the last saying the rest is in the file', async () => {
    const d = deps({
      bytes: Buffer.from('word '.repeat(DISCORD_MESSAGE_LIMIT * 4).replace(/ /g, '\n'))
    })
    await sendPhoneCopy(d, { markdown: '/w/long.md' }, WHERE)
    const { parts } = d.sent[0]
    expect(parts).toHaveLength(11)
    expect(parts.at(-1)).toBe(REST_IN_THE_FILE)
  })

  it('any other file goes as itself; one over 20 MB is not sent and the session is told why', async () => {
    const d = deps()
    expect(await sendPhoneCopy(d, { file: '/w/shot.png' }, WHERE)).toBe(
      'Sent the file to the room.'
    )
    expect(d.sent[0].files.map((f) => f.name)).toEqual(['shot.png'])
    const big = deps({ bytes: Buffer.alloc(BYTES_PER_FILE + 1) })
    expect(await sendPhoneCopy(big, { file: '/w/film.mov' }, WHERE)).toMatch(
      /could not also send it.*the limit is 20 MB/
    )
    expect(big.sent).toEqual([])
  })

  it('a diff goes as a phone-wide picture, since a diff code block shows no colours on the phone; one cut short also carries the whole diff as a file', async () => {
    const pictured: { html: string; look: PageLook }[] = []
    const shootHtml =
      (tall: number) =>
      async (html: string, look: PageLook): Promise<PagePictures> => {
        pictured.push({ html, look })
        return {
          files: [{ name: 'page.png', data: Buffer.from('png') }],
          shown: {
            width: look.width,
            height: Math.min(tall, look.pictureHeight * look.mostPictures)
          },
          page: { width: look.width, height: tall }
        }
      }
    const short = deps({
      diff: 'diff --git a/app.ts b/app.ts\n@@ -1 +1 @@\n-old\n+new\n',
      shootHtml: shootHtml(100)
    })
    expect(await sendPhoneCopy(short, { diff: '/w/app.ts' }, WHERE)).toBe(
      'Sent a picture of its changes to the room.'
    )
    expect(short.sent).toEqual([
      { files: [expect.objectContaining({ name: 'page.png' })], parts: [] }
    ])
    expect(pictured[0].look).toBe(DIFF_LOOK)
    expect(pictured[0].html).toContain(
      '<h1>app.ts</h1><div class="hunk">@@ -1 +1 @@</div><div class="del">-old</div><div class="add">+new</div>'
    )

    const diff = '@@ -1 +1 @@\n+<script>\n'
    const long = deps({ diff, shootHtml: shootHtml(100_000) })
    expect(await sendPhoneCopy(long, { diff: '/w/app.ts' }, WHERE)).toMatch(
      /start of its changes.*whole diff as a file/
    )
    expect(pictured[1].html).toContain('+&lt;script&gt;')
    expect(long.sent[0].files.at(-1)).toEqual({ name: 'app.ts.diff', data: Buffer.from(diff) })
  })

  it('a file with no git changes sends nothing', async () => {
    const d = deps({ diff: '' })
    expect(await sendPhoneCopy(d, { diff: '/w/app.ts' }, WHERE)).toMatch(/no git changes/)
    expect(d.sent).toEqual([])
  })
})
