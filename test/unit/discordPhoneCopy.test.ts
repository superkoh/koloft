import { describe, expect, it } from 'vitest'
import {
  couldNotSendInRoom,
  DIAGRAM_IN_WORDS,
  diagramsInWords,
  DIFF_LOOK,
  DIFF_ROWS_THAT_FILL_THE_PICTURES,
  REST_IN_THE_FILE,
  sendPhoneCopy,
  shownOf,
  stillSending,
  type FileDiff,
  type PhoneCopyDeps
} from '../../src/main/discord/phoneCopy'
import { BYTES_PER_FILE, type DiscordFile } from '../../src/main/discord/link'
import { DISCORD_MESSAGE_LIMIT } from '../../src/main/discord/split'
import type { PageLook, PagePictures } from '../../src/main/discord/pageShot'
import { formatRemoteKey } from '../../src/shared/remoteKey'
import { machinePageUrl } from '../../src/shared/browserRoute'

const WHERE = 'the room'
const page = { width: 1280, height: 900 }

type Sent = { files: DiscordFile[]; parts: string[] }

function deps(
  over: Partial<PhoneCopyDeps> & { bytes?: Buffer; diff?: string; truncated?: boolean } = {}
): PhoneCopyDeps & { sent: Sent[]; read: string[] } {
  const sent: Sent[] = []
  const read: string[] = []
  return {
    sent,
    read,
    shoot: async () => ({
      files: [{ name: 'page.png', data: Buffer.from('png') }],
      shown: page,
      page
    }),
    shootHtml: async () => ({ files: [], shown: page, page }),
    size: async () => undefined,
    readBytes: async (file) => {
      read.push(file)
      return over.bytes ?? Buffer.from('bytes')
    },
    fileDiff: async (): Promise<FileDiff> => ({
      text: over.diff ?? '',
      truncated: over.truncated ?? false
    }),
    send: async (files, parts) => {
      sent.push({ files, parts })
    },
    cardsWaitFor: () => undefined,
    ...over
  }
}

function diffShooter(tall: number): {
  pictured: { html: string; look: PageLook }[]
  shootHtml: PhoneCopyDeps['shootHtml']
} {
  const pictured: { html: string; look: PageLook }[] = []
  return {
    pictured,
    shootHtml: async (html, look): Promise<PagePictures> => {
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
  }
}

const rowsOf = (n: number): string =>
  `@@ -1,0 +1,${n} @@\n${Array.from({ length: n }, (_, i) => `+line ${i}`).join('\n')}\n`

describe('what koloft open shows is sent to the phone as', () => {
  it('a picture for an HTML file, a file:// address or a web address, the file itself for Markdown or anything else, a diff for koloft diff', () => {
    expect(shownOf('/w/plan.html', undefined)).toEqual({ page: 'file:///w/plan.html' })
    expect(shownOf('http://localhost:5173', undefined)).toEqual({ page: 'http://localhost:5173' })
    expect(shownOf('/w/plan.md', undefined)).toEqual({ markdown: '/w/plan.md' })
    expect(shownOf('file:///w/plan.md', undefined)).toEqual({ markdown: '/w/plan.md' })
    expect(shownOf('file:///w/plan.html#part-2', undefined)).toEqual({
      page: 'file:///w/plan.html#part-2'
    })
    expect(shownOf('file://server/share/plan.md', undefined)).toBeUndefined()
    expect(shownOf('/w/shot.png', undefined)).toEqual({ file: '/w/shot.png' })
    expect(shownOf('/w/app.ts', undefined, 'diff')).toEqual({ diff: '/w/app.ts' })
  })

  it('in a session on another machine: its files are read there, and every page, its own HTML files and localhost included, is pictured as that session’s Workbench shows it', () => {
    const on = (p: string): string => formatRemoteKey('box', p)
    expect(shownOf('/w/plan.md', 'box')).toEqual({ markdown: on('/w/plan.md') })
    expect(shownOf('/w/app.ts', 'box', 'diff')).toEqual({ diff: on('/w/app.ts') })
    expect(shownOf('/w/plan.html', 'box')).toEqual({
      page: machinePageUrl('box', '/w/plan.html'),
      machine: 'box'
    })
    expect(shownOf('http://localhost:3000', 'box')).toEqual({
      page: 'http://localhost:3000',
      machine: 'box'
    })
    expect(shownOf('https://example.com/docs', 'box')).toEqual({
      page: 'https://example.com/docs',
      machine: 'box'
    })
  })
})

describe('a diagram in a Markdown file sent as text', () => {
  it('becomes one line saying to look on the Mac, whatever its fence; code blocks stay, even one quoting a diagram', () => {
    expect(diagramsInWords('a\n~~~mermaid\ngraph TD\n~~~\nb')).toBe(`a\n${DIAGRAM_IN_WORDS}\nb`)
    expect(diagramsInWords('````md\n```mermaid\ngraph TD\n```\n````\nb')).toBe(
      '````md\n```mermaid\ngraph TD\n```\n````\nb'
    )
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

  it('a page on another machine is pictured as that machine shows it, and a failure names the file by its path there', async () => {
    const asked: [string, string | undefined][] = []
    const d = deps({
      shoot: async (url, machine) => {
        asked.push([url, machine])
        return { files: [{ name: 'page.png', data: Buffer.from('png') }], shown: page, page }
      }
    })
    const there = machinePageUrl('box', '/w/plan.html')
    expect(await sendPhoneCopy(d, { page: there, machine: 'box' }, WHERE)).toBe(
      'Sent a picture of the page to the room.'
    )
    expect(asked).toEqual([[there, 'box']])

    let fail!: (e: Error) => void
    const failing = deps({ shoot: () => new Promise((_, reject) => (fail = reject)) })
    expect(await sendPhoneCopy(failing, { page: there, machine: 'box' }, WHERE, 0)).toBe(
      stillSending(WHERE)
    )
    fail(new Error('it did not load in time.'))
    await expect
      .poll(() => failing.sent)
      .toEqual([
        {
          files: [],
          parts: [
            couldNotSendInRoom(formatRemoteKey('box', '/w/plan.html'), 'it did not load in time.')
          ]
        }
      ])
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
    expect(d.sent).toEqual([])
  })

  it('a copy slower than the reply can wait for: cards wait for it from its start, the reply says it is still on its way, and a failure later is told in the room before the cards go on', async () => {
    let fail!: (e: Error) => void
    const waitedFor: Promise<void>[] = []
    const d = deps({
      shoot: () => new Promise((_, reject) => (fail = reject)),
      cardsWaitFor: (copy) => void waitedFor.push(copy)
    })
    const reply = sendPhoneCopy(d, { page: 'http://localhost:1' }, WHERE, 0)
    expect(waitedFor).toHaveLength(1)
    expect(await reply).toBe(stillSending(WHERE))
    fail(new Error('it did not load in time.'))
    await Promise.all(waitedFor)
    expect(d.sent).toEqual([
      {
        files: [],
        parts: [couldNotSendInRoom('http://localhost:1', 'it did not load in time.')]
      }
    ])
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
    expect(parts).toHaveLength(10)
    expect(parts.at(-1)).toBe(REST_IN_THE_FILE)
  })

  it('any other file goes as itself; one over 20 MB is not read, or not sent when its size shows only once read, and the session is told why', async () => {
    const d = deps()
    expect(await sendPhoneCopy(d, { file: '/w/shot.png' }, WHERE)).toBe(
      'Sent the file to the room.'
    )
    expect(d.sent[0].files.map((f) => f.name)).toEqual(['shot.png'])

    const big = deps({ size: async () => BYTES_PER_FILE + 1 })
    expect(await sendPhoneCopy(big, { file: '/w/film.mov' }, WHERE)).toMatch(
      /could not also send it.*the limit is 20 MB/
    )
    expect(big.read).toEqual([])

    const bigThere = deps({ bytes: Buffer.alloc(BYTES_PER_FILE + 1) })
    expect(await sendPhoneCopy(bigThere, { file: 'ssh://box/w/film.mov' }, WHERE)).toMatch(
      /the limit is 20 MB/
    )
    expect(bigThere.sent).toEqual([])
  })

  it('a diff goes as a phone-wide picture of its changed lines, a gap between its parts, since a diff code block shows no colours on the phone', async () => {
    const { pictured, shootHtml } = diffShooter(100)
    const d = deps({
      diff: 'diff --git a/app.ts b/app.ts\n@@ -1 +1 @@\n-old\n+<new>\n@@ -9 +9 @@\n-x\n+y\n',
      shootHtml
    })
    expect(await sendPhoneCopy(d, { diff: '/w/app.ts' }, WHERE)).toBe(
      'Sent a picture of its changes to the room.'
    )
    expect(d.sent).toEqual([
      { files: [expect.objectContaining({ name: 'app.ts-changes.png' })], parts: [] }
    ])
    expect(pictured[0].look).toBe(DIFF_LOOK)
    expect(pictured[0].html).toContain(
      '<h1>app.ts</h1><div class="del">-old</div><div class="add">+&lt;new&gt;</div><div class="gap">⋯</div><div class="del">-x</div>'
    )
  })

  it('a diff longer than the pictures goes as pictures of its start with the whole diff as a file; a diff git cut short, or too large for a file, goes without it', async () => {
    const long = rowsOf(DIFF_ROWS_THAT_FILL_THE_PICTURES + 1)
    const tall = diffShooter(100_000)
    const d = deps({ diff: long, shootHtml: tall.shootHtml })
    expect(await sendPhoneCopy(d, { diff: '/w/app.ts' }, WHERE)).toBe(
      'Sent a picture of the start of its changes to the room, with the whole diff as a file.'
    )
    expect(tall.pictured[0].html).not.toContain(`+line ${DIFF_ROWS_THAT_FILL_THE_PICTURES}<`)
    expect(d.sent[0].files.at(-1)).toEqual({ name: 'app.ts.diff', data: Buffer.from(long) })

    const cut = deps({ diff: rowsOf(3), truncated: true, shootHtml: diffShooter(100).shootHtml })
    expect(await sendPhoneCopy(cut, { diff: '/w/app.ts' }, WHERE)).toMatch(
      /start of its changes.*too long to send/
    )
    expect(cut.sent[0].files.map((f) => f.name)).toEqual(['app.ts-changes.png'])
  })

  it('a file with no git changes sends nothing; a change with no lines to draw sends nothing and the session is told to say it in words', async () => {
    const d = deps({ diff: '' })
    expect(await sendPhoneCopy(d, { diff: '/w/app.ts' }, WHERE)).toMatch(/no git changes/)
    const binary = deps({ diff: 'diff --git a/logo.png b/logo.png\nBinary files differ\n' })
    expect(await sendPhoneCopy(binary, { diff: '/w/logo.png' }, WHERE)).toMatch(
      /no lines to draw.*say what changed/
    )
    expect([...d.sent, ...binary.sent]).toEqual([])
  })
})
