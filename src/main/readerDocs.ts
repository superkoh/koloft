import fs from 'fs'
import os from 'os'
import path from 'path'
import type { DocVerdict, SessionInfo } from '@shared/types'
import type { Turn } from '@shared/turns'
import { formatRemoteKey, parseRemoteKey } from '@shared/remoteKey'
import { isReaderDocPath, writtenForTheAgent } from '@shared/preview'
import type { Assist } from './assist'
import { writePrivateAtomically } from './privateFile'

type VerdictsBySession = Record<string, Record<string, DocVerdict>>

const SAID_CHARS_SENT = 1500
const REPLY_CHARS_SENT = 8000
const NAMES_A_DOC = /\.(md|markdown|html?)\b/i

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
  remoteFileExists(keyed: string): Promise<boolean>
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

function pathIn(line: string, cwd: string, remote: boolean): string | null {
  const p = line
    .trim()
    .replace(/^(?:[-*]|\d+[.)])\s+/, '')
    .replace(/^[`'"]+|[`'"]+$/g, '')
  if (!p || !isReaderDocPath(p)) return null
  if (p.startsWith('~/')) return remote ? null : path.join(os.homedir(), p.slice(2))
  return path.posix.resolve(cwd, p)
}

async function localFile(p: string): Promise<string | null> {
  try {
    const real = await fs.promises.realpath(p)
    return (await fs.promises.stat(real)).isFile() ? real : null
  } catch {
    return null
  }
}

export class ReaderDocs {
  private verdicts: VerdictsBySession | null = null
  private lastTurnEnd = new Map<string, number>()

  constructor(private readonly deps: ReaderDocsDeps) {}

  of(sessionId: string): Record<string, DocVerdict> | undefined {
    return this.all()[sessionId]
  }

  forget(sessionId: string): void {
    const all = this.all()
    if (!(sessionId in all)) return
    delete all[sessionId]
    this.save()
  }

  async turnEnded(tabId: string, turn: Turn): Promise<void> {
    const s = this.deps.session(tabId)
    if (!s?.sessionId) return
    const since = turn.said[0]?.at ?? this.lastTurnEnd.get(tabId) ?? 0
    this.lastTurnEnd.set(tabId, turn.at)
    const written = (s.files ?? [])
      .filter(
        (f) =>
          f.access === 'wrote' &&
          (f.wroteAt ?? 0) >= since &&
          isReaderDocPath(f.src) &&
          !writtenForTheAgent(f.src)
      )
      .map((f) => f.src)
    if (!written.length && !NAMES_A_DOC.test(turn.reply)) return
    const machine = s.remote?.host
    const reply = await this.deps.assist({
      system: SYSTEM,
      prompt: promptFor(
        turn,
        s.cwd,
        written.map((src) => parseRemoteKey(src)?.path ?? src)
      )
    })
    if (reply === null) return
    const picked = new Set<string>()
    for (const line of reply.split('\n')) {
      const p = pathIn(line, s.cwd, !!machine)
      if (!p) continue
      const src = machine ? formatRemoteKey(machine, p) : p
      const found = written.includes(src)
        ? src
        : machine
          ? (await this.deps.remoteFileExists(src))
            ? src
            : null
          : await localFile(p)
      if (found) picked.add(found)
    }
    const at = Date.now()
    const verdicts = { ...this.of(s.sessionId) }
    for (const src of written) verdicts[src] = { show: false, at }
    for (const src of picked) verdicts[src] = { show: true, at }
    this.all()[s.sessionId] = verdicts
    this.save()
    this.deps.changed()
  }

  private all(): VerdictsBySession {
    if (!this.verdicts) {
      try {
        const read: unknown = JSON.parse(fs.readFileSync(this.deps.file(), 'utf8'))
        this.verdicts =
          read && typeof read === 'object' && !Array.isArray(read)
            ? (read as VerdictsBySession)
            : {}
      } catch {
        this.verdicts = {}
      }
    }
    return this.verdicts
  }

  private save(): void {
    try {
      writePrivateAtomically(this.deps.file(), JSON.stringify(this.verdicts))
    } catch {}
  }
}
