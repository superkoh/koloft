import os from 'os'
import path from 'path'
import type { DocVerdict, SessionInfo } from '@shared/types'
import type { Turn } from '@shared/turns'
import { formatRemoteKey, parseRemoteKey } from '@shared/remoteKey'
import { isReaderDocPath, writtenForTheAgent } from '@shared/preview'
import type { Assist } from './assist'
import { PrivateRecordFile } from './privateFile'
import { localFile } from './realFiles'

const SAID_CHARS_SENT = 1500
const REPLY_CHARS_SENT = 8000
const BETWEEN_PATHS_IN_PROSE = /[\s`'"()<>[\]（）「」『』，。、；：]+/

const SYSTEM = 'You decide which files a person should open and read.'

const INSTRUCTIONS = [
  'A coding agent just finished replying to a person. Decide which documents the person is meant to open and read now:',
  'a report, plan, design, write-up, summary, guide or web page the agent made or pointed to FOR THE PERSON.',
  'Leave out: files written for the agent itself or for other agents (instructions, memory, notes-to-self, prompts, skill files, briefs, scratch logs),',
  'drafts of text the agent posts somewhere else (pull request bodies, issue bodies, comments, commit messages, messages to other sessions) — the person reads those where they were posted,',
  'ledgers or logs the agent only appended a line to, code and config, test fixtures, files only mentioned in passing, and files the reply says were deleted.',
  'When unsure, leave the file out.',
  'A file may be one the agent wrote, or one the reply points the person to without writing it.',
  'Only markdown (.md) and HTML (.html) files count.',
  'Reply with the absolute paths alone, one per line, nothing else; resolve relative paths against the working directory. If there are none, reply NONE.'
].join('\n')

export interface ReaderDocsDeps {
  file(): string
  assist: Assist
  session(tabId: string): SessionInfo | undefined
  remoteFileExists(host: string, keyed: string): Promise<boolean>
  changed(): void
}

function promptFor(turn: Turn, cwd: string, written: string[]): string {
  const said = turn.said.map((l) => l.text).join('\n\n')
  return [
    INSTRUCTIONS,
    '',
    `Working directory: ${cwd}`,
    '',
    'Person asked:',
    said.slice(0, SAID_CHARS_SENT),
    '',
    'Agent replied:',
    turn.reply.slice(-REPLY_CHARS_SENT),
    '',
    'Files the agent wrote this turn:',
    ...(written.length ? written : ['(none)'])
  ].join('\n')
}

function docIn(text: string, cwd: string, host: string | undefined): string | null {
  const p = text
    .trim()
    .replace(/^(?:[-*]|\d+[.)])\s+/, '')
    .replace(/^[`'"]+|[`'".,;:!?]+$/g, '')
  if (!p || !isReaderDocPath(p)) return null
  const abs = path.posix.resolve(cwd, p)
  const src = host ? formatRemoteKey(host, abs) : abs
  return writtenForTheAgent(src) ? null : src
}

export class ReaderDocs {
  private readonly store: PrivateRecordFile<Record<string, DocVerdict>>
  private lastTurnEnd = new Map<string, number>()
  private archived = new Set<string>()

  constructor(private readonly deps: ReaderDocsDeps) {
    this.store = new PrivateRecordFile(deps.file)
  }

  of(sessionId: string): Record<string, DocVerdict> | undefined {
    return this.store.get()[sessionId]
  }

  forget(sessionId: string): void {
    this.archived.add(sessionId)
    this.store.forget(sessionId)
  }

  async turnEnded(tabId: string, turn: Turn): Promise<void> {
    const s = this.deps.session(tabId)
    if (!s?.sessionId) return
    const since = turn.said[0]?.at ?? this.lastTurnEnd.get(tabId) ?? 0
    this.lastTurnEnd.set(tabId, turn.at)
    const host = s.remote?.host
    const files = s.files ?? []
    const wrote = files.filter((f) => f.access === 'wrote')
    const written = wrote
      .filter(
        (f) => (f.wroteAt ?? 0) >= since && isReaderDocPath(f.src) && !writtenForTheAgent(f.src)
      )
      .map((f) => f.src)
    const known = new Set([...wrote.map((f) => f.src), ...Object.keys(this.of(s.sessionId) ?? {})])
    const namesANewDoc = turn.reply.split(BETWEEN_PATHS_IN_PROSE).some((word) => {
      const src = docIn(word, s.cwd, host)
      return src !== null && !known.has(src)
    })
    if (!written.length && !namesANewDoc) return
    const reply = await this.deps.assist({
      system: SYSTEM,
      prompt: promptFor(
        turn,
        s.cwd,
        written.map((src) => parseRemoteKey(src)?.path ?? src)
      )
    })
    if (reply === null) return
    const found = await Promise.all(
      reply.split('\n').map(async (line) => {
        const src = docIn(line, s.cwd, host)
        if (!src || written.includes(src)) return src
        if (host)
          return (await this.deps.remoteFileExists(host, src).catch(() => false)) ? src : null
        const real = await localFile(src)
        return real && !writtenForTheAgent(real) ? real : null
      })
    )
    const home = `${os.homedir()}/`
    const replyGivesFullPath = (src: string): boolean => {
      const p = parseRemoteKey(src)?.path ?? src
      return turn.reply.includes(p) || (!host && turn.reply.includes(p.replace(home, '~/')))
    }
    if (this.archived.has(s.sessionId)) return
    const at = Date.now()
    const verdicts = { ...this.of(s.sessionId) }
    for (const src of written) verdicts[src] = { show: replyGivesFullPath(src), at }
    for (const src of found) if (src) verdicts[src] = { show: true, at }
    this.store.get()[s.sessionId] = verdicts
    this.store.save()
    this.deps.changed()
  }
}
