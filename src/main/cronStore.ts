import path from 'path'
import { isValidSchedule } from '@shared/schedule'
import { hasWordChar, isValidModelName } from '@shared/cronNames'
import { isValidWorktreeName } from '@shared/worktreeName'
import { SESSION_BACKENDS } from '@shared/sessionBackend'
import { isCronEffort, type CronJob, type HistoryLine, type HistoryState } from '@shared/types'

export interface CronStoreFs {
  readFile(p: string): string
  writeFile(p: string, s: string): void
  rename(a: string, b: string): void
}

export function cronFilePath(userData: string): string {
  return path.join(userData, 'cron.json')
}

const BAD_MODEL_NOTE = 'The saved model was not valid and was ignored.'

const HISTORY_STATES = new Set<string>(['closed', 'failed', 'ended', 'skipped', 'missed'])
const MAX_HISTORY = 20

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x)
}

function cleanName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const name = raw.replace(/\p{Cc}/gu, '').trim()
  if (name === '' || name.length > 80 || !hasWordChar(name)) return null
  if (name.startsWith('-')) return null
  return name
}

function cleanTask(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const task = raw.replace(/\0/g, '').trim()
  if (task === '' || task.length > 4096 || task.startsWith('-')) return null
  return task
}

function cleanHistory(raw: unknown): HistoryLine[] {
  if (!Array.isArray(raw)) return []
  const lines: HistoryLine[] = []
  for (const item of raw) {
    if (!isObj(item)) continue
    const { dueAt, state } = item
    if (typeof dueAt !== 'number' || !Number.isFinite(dueAt)) continue
    if (typeof state !== 'string' || !HISTORY_STATES.has(state)) continue
    const line: HistoryLine = { dueAt, state: state as HistoryState }
    if (item.manual === true) line.manual = true
    if (state === 'skipped' || state === 'missed') {
      const count = item.count
      if (typeof count === 'number' && Number.isInteger(count) && count >= 1) {
        line.count = count
        if (typeof item.until === 'number' && Number.isFinite(item.until)) line.until = item.until
      } else if (state === 'skipped') {
        line.count = 1
      }
    }
    if (typeof item.worktree === 'string' && isValidWorktreeName(item.worktree)) {
      line.worktree = item.worktree
    }
    if (state === 'failed' && typeof item.note === 'string') line.note = item.note
    lines.push(line)
  }
  return lines
    .map((line, i) => ({ line, i }))
    .sort((a, b) => b.line.dueAt - a.line.dueAt || a.i - b.i)
    .map((x) => x.line)
    .slice(0, MAX_HISTORY)
}

export function sanitizeCron(
  raw: unknown,
  pinned: string[]
): { jobs: CronJob[]; notes: Record<string, string> } {
  const empty = { jobs: [] as CronJob[], notes: {} as Record<string, string> }
  if (!isCronFile(raw)) return empty

  const pinnedSet = new Set(pinned)
  const filterByPin = pinnedSet.size > 0
  const jobs: CronJob[] = []
  const notes: Record<string, string> = {}
  const seen = new Set<string>()

  for (const item of raw.jobs) {
    if (!isObj(item)) continue
    const { id, workspacePath, schedule, enabled, createdAt } = item
    if (typeof id !== 'string' || id === '') continue
    if (seen.has(id)) continue
    if (typeof workspacePath !== 'string' || !path.isAbsolute(workspacePath)) continue
    if (filterByPin && !pinnedSet.has(workspacePath)) continue
    const name = cleanName(item.name)
    if (name === null) continue
    const task = cleanTask(item.task)
    if (task === null) continue
    if (!isValidSchedule(schedule)) continue
    if (typeof enabled !== 'boolean') continue

    const permission =
      item.permission === 'acceptEdits' || item.permission === 'skipAll' ? item.permission : 'same'

    const job: CronJob = {
      id,
      workspacePath,
      name,
      task,
      schedule,
      permission,
      enabled,
      createdAt: typeof createdAt === 'number' && Number.isFinite(createdAt) ? createdAt : 0,
      history: cleanHistory(item.history)
    }
    if (item.model !== undefined) {
      if (typeof item.model === 'string' && isValidModelName(item.model)) job.model = item.model
      else notes[id] = BAD_MODEL_NOTE
    }
    if (isCronEffort(item.effort)) job.effort = item.effort
    const backend = SESSION_BACKENDS.find((b) => b === item.backend)
    if (backend) job.backend = backend
    seen.add(id)
    jobs.push(job)
  }
  return { jobs, notes }
}

function isCronFile(raw: unknown): raw is { version: 1; jobs: unknown[] } {
  return isObj(raw) && raw.version === 1 && Array.isArray(raw.jobs)
}

export function loadCron(
  fs: CronStoreFs,
  file: string,
  pinned: string[]
): { jobs: CronJob[]; notes: Record<string, string> } {
  let text: string
  try {
    text = fs.readFile(file)
  } catch (e) {
    if (!isMissingFile(e)) moveBrokenAside(fs, file)
    return { jobs: [], notes: {} }
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    keepBroken(fs, file, text)
    return { jobs: [], notes: {} }
  }
  if (!isCronFile(raw)) {
    keepBroken(fs, file, text)
    return { jobs: [], notes: {} }
  }
  return sanitizeCron(raw, pinned)
}

function isMissingFile(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: unknown }).code === 'ENOENT'
}

function moveBrokenAside(fs: CronStoreFs, file: string): void {
  try {
    fs.rename(file, `${file}.broken-${Date.now()}`)
  } catch {}
}

function keepBroken(fs: CronStoreFs, file: string, text: string): void {
  try {
    fs.writeFile(`${file}.broken-${Date.now()}`, text)
  } catch {}
}

export function saveCron(fs: CronStoreFs, file: string, jobs: CronJob[]): void {
  try {
    const tmp = `${file}.tmp`
    fs.writeFile(tmp, JSON.stringify({ version: 1, jobs }, null, 2))
    fs.rename(tmp, file)
  } catch {}
}
