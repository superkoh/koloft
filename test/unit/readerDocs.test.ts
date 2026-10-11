import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { PreviewItem, SessionInfo } from '@shared/types'
import type { Turn } from '@shared/turns'
import type { AssistJob } from '../../src/main/assist'
import { ReaderDocs } from '../../src/main/readerDocs'

const TURN_START = 1_000

const wrote = (src: string, wroteAt: number): PreviewItem => ({
  src,
  label: path.basename(src),
  access: 'wrote',
  wroteAt
})

const turn = (reply: string): Turn => ({
  said: [{ who: 'owner', text: 'write the report', at: TURN_START }],
  reply,
  at: TURN_START + 500
})

let dir: string
beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reader-docs-')))
})

function setup(opts: {
  files: PreviewItem[]
  answer: string | null
  remote?: string
  cwd?: string
  remoteFiles?: string[]
}) {
  const jobs: AssistJob[] = []
  const asked: string[] = []
  let changed = 0
  const session = {
    tabId: 't1',
    sessionId: 's1',
    cwd: opts.cwd ?? dir,
    files: opts.files,
    ...(opts.remote ? { remote: { host: opts.remote } } : {})
  } as SessionInfo
  const make = (): ReaderDocs =>
    new ReaderDocs({
      file: () => path.join(dir, 'doc-verdicts.json'),
      assist: async (job) => {
        jobs.push(job)
        return opts.answer
      },
      session: (tabId) => (tabId === 't1' ? session : undefined),
      remoteFileExists: async (_host, keyed) => {
        asked.push(keyed)
        return (opts.remoteFiles ?? []).includes(keyed)
      },
      changed: () => changed++
    })
  return { make, session, jobs, asked, changed: () => changed }
}

describe('Assist picks the docs a session made for its reader', () => {
  it('asks nothing when the turn wrote no doc and its reply names no doc it does not already know', async () => {
    const t = setup({
      files: [
        wrote(path.join(dir, 'a.ts'), TURN_START + 1),
        wrote(path.join(dir, 'NOTES.md'), TURN_START - 1)
      ],
      answer: 'NONE'
    })
    await t.make().turnEnded('t1', turn('Fixed the bug, as CLAUDE.md asks; see NOTES.md.'))
    expect(t.jobs).toEqual([])
  })

  it('sends only the docs written this turn, keeps what Assist picked that exists and is not written for the agent, and remembers it across restarts', async () => {
    fs.mkdirSync(path.join(dir, 'docs'))
    fs.writeFileSync(path.join(dir, 'docs', 'report.md'), '# r')
    fs.writeFileSync(path.join(dir, 'pr-body.md'), 'body')
    fs.writeFileSync(path.join(dir, 'old.md'), 'old')
    fs.writeFileSync(path.join(dir, 'guide.md'), 'made by a shell command')
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'for the agent')
    const report = path.join(dir, 'docs', 'report.md')
    const prBody = path.join(dir, 'pr-body.md')
    const t = setup({
      files: [
        wrote(path.join(dir, 'old.md'), TURN_START - 1),
        wrote(report, TURN_START + 10),
        wrote(prBody, TURN_START + 20),
        wrote(path.join(dir, 'CLAUDE.md'), TURN_START + 30)
      ],
      answer: [
        `- ${report}`,
        '`guide.md`',
        path.join(dir, 'missing.md'),
        path.join(dir, 'x.ts'),
        path.join(dir, 'CLAUDE.md')
      ].join('\n')
    })
    await t.make().turnEnded('t1', turn('Done.'))

    expect(t.jobs).toHaveLength(1)
    const sent = t.jobs[0].prompt.split('Files the agent wrote this turn:\n')[1]
    expect(sent.split('\n')).toEqual([report, prBody])

    const verdicts = t.make().of('s1')
    expect(Object.keys(verdicts ?? {}).sort()).toEqual(
      [report, prBody, path.join(dir, 'guide.md')].sort()
    )
    expect(verdicts?.[report]?.show).toBe(true)
    expect(verdicts?.[prBody]?.show).toBe(false)
    expect(verdicts?.[path.join(dir, 'guide.md')]?.show).toBe(true)
    expect(t.changed()).toBe(1)
  })

  it('for a turn with no prompt of its own, sends only the docs written since the last turn ended', async () => {
    const first = path.join(dir, 'first.md')
    const second = path.join(dir, 'second.md')
    const t = setup({ files: [wrote(first, TURN_START + 10)], answer: 'NONE' })
    const docs = t.make()
    await docs.turnEnded('t1', turn('Wrote first.md'))
    t.jobs.length = 0
    t.session.files = [wrote(first, TURN_START + 10), wrote(second, TURN_START + 900)]
    await docs.turnEnded('t1', { said: [], reply: 'Wrote second.md', at: TURN_START + 950 })
    expect(t.jobs[0].prompt.split('Files the agent wrote this turn:\n')[1]).toBe(second)
  })

  it('records nothing when Assist is off or fails, so the docs fall back to the rule', async () => {
    const t = setup({ files: [wrote(path.join(dir, 'a.md'), TURN_START + 1)], answer: null })
    const docs = t.make()
    await docs.turnEnded('t1', turn('Wrote a.md'))
    expect(t.jobs).toHaveLength(1)
    expect(docs.of('s1')).toBeUndefined()
    expect(t.changed()).toBe(0)
  })

  it('matches a path Assist spells through a symlink to the written file, not a second entry', async () => {
    fs.mkdirSync(path.join(dir, 'real'))
    fs.writeFileSync(path.join(dir, 'real', 'plan.md'), '# p')
    fs.symlinkSync(path.join(dir, 'real'), path.join(dir, 'link'))
    const real = path.join(dir, 'real', 'plan.md')
    const t = setup({
      files: [wrote(real, TURN_START + 1)],
      answer: path.join(dir, 'link', 'plan.md')
    })
    const docs = t.make()
    await docs.turnEnded('t1', turn('Plan is ready.'))
    expect(docs.of('s1')).toEqual({ [real]: { show: true, at: expect.any(Number) } })
  })

  it('on an ssh session, sends plain paths and checks an unwritten one on that machine', async () => {
    const written = 'ssh://devbox/home/koh/repo/report.md'
    const t = setup({
      remote: 'devbox',
      cwd: '/home/koh/repo',
      files: [wrote(written, TURN_START + 1)],
      remoteFiles: ['ssh://devbox/home/koh/repo/notes/summary.md'],
      answer: ['/home/koh/repo/report.md', 'notes/summary.md', '/home/koh/repo/gone.md'].join('\n')
    })
    const docs = t.make()
    await docs.turnEnded('t1', turn('See notes/summary.md'))
    expect(t.jobs[0].prompt).toContain('\n/home/koh/repo/report.md')
    expect(t.jobs[0].prompt).not.toContain('ssh://')
    expect(t.asked).toEqual([
      'ssh://devbox/home/koh/repo/notes/summary.md',
      'ssh://devbox/home/koh/repo/gone.md'
    ])
    expect(docs.of('s1')).toEqual({
      [written]: { show: true, at: expect.any(Number) },
      'ssh://devbox/home/koh/repo/notes/summary.md': { show: true, at: expect.any(Number) }
    })
  })
})
