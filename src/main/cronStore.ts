import path from 'path'
import { isValidSchedule } from '@shared/schedule'
import { hasWordChar, isValidModelName } from '@shared/cronNames'
import { isValidWorktreeName } from '@shared/worktreeName'
import { isCronEffort, type CronJob, type HistoryLine, type HistoryState } from '@shared/types'

/** §3 — the saved jobs, in their OWN file (`<userData>/cron.json`), not in
 *  settings.json: settings is the account registry and is rewritten whole on every
 *  small change, so a job list living inside it would ride along on writes that have
 *  nothing to do with it.
 *
 *  A live run is never written here. What is on disk is the rule plus at most 20
 *  finished outcomes; everything about a run in flight lives in memory and dies with
 *  the app, which is why a crash can never leave a job looking busy forever.
 *
 *  A job whose workspace folder is MISSING on disk is kept: `pinned` is just the list
 *  of pinned paths, and this loader never asks the disk anything. A layout that failed
 *  to load, or a folder renamed for an afternoon, must not silently delete the job —
 *  the missing folder is reported at fire time instead (§4.5 step 3).
 *
 *  Two rules exist so that a bad moment can never cost a person their jobs, because
 *  the next save rewrites this file whole:
 *
 *  - **An EMPTY pinned list turns the pin filter off.** Removing a workspace already
 *    deletes its jobs, so a file with jobs in it and no pins at all is far more likely
 *    a layout that failed to load than a true state. Filtering then would drop every
 *    job, and the next save would make that permanent.
 *  - **A file that exists but cannot be used is put aside first**, as
 *    `cron.json.broken-<epoch ms>`, before the loader answers "no jobs". Whatever was
 *    in it — a hand edit gone wrong, a half write — is still on disk to go back to.
 *    Text Koloft could read but not understand is COPIED aside; a file the read itself
 *    failed on (no permission, a disk that answered with an error) is MOVED aside,
 *    since there is no text in hand to copy. Only "the file is not there" (ENOENT) is
 *    an ordinary first run and touches nothing. */

export interface CronStoreFs {
  /** throws when the file cannot be read. The loader reads that as "no file yet" ONLY
   *  when the error carries `code === 'ENOENT'`, the way Node's own `readFileSync`
   *  reports a missing file; any other failure means the file may still be there, full
   *  of jobs, so the loader moves it aside rather than letting the next save erase it */
  readFile(p: string): string
  writeFile(p: string, s: string): void
  rename(a: string, b: string): void
}

export function cronFilePath(userData: string): string {
  return path.join(userData, 'cron.json')
}

/** §7.3 — the one complaint the loader can leave on a card. */
const BAD_MODEL_NOTE = 'The saved model was not valid and was ignored.'

const HISTORY_STATES = new Set<string>(['closed', 'failed', 'ended', 'skipped', 'missed'])
const MAX_HISTORY = 20

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x)
}

/** control characters would land in a tab title and a folder name */
function cleanName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const name = raw.replace(/\p{Cc}/gu, '').trim()
  if (name === '' || name.length > 80 || !hasWordChar(name)) return null
  // it reaches the launch line as the value of `--name`: a dash-leading one would land
  // there as a flag where a value belongs
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
    // a field only belongs on the line it means something for: a `count` on a closed
    // line would print "Closed 3 times", which never happened. Skips fold (the run
    // stayed open) and so do misses (Koloft was asleep through a run of them).
    if (state === 'skipped' || state === 'missed') {
      const count = item.count
      if (typeof count === 'number' && Number.isInteger(count) && count >= 1) {
        line.count = count
        if (typeof item.until === 'number' && Number.isFinite(item.until)) line.until = item.until
      } else if (state === 'skipped') {
        // a skip is always written with a count; a miss only carries one when it folded
        line.count = 1
      }
    }
    // a folder name off disk reaches a `git` call and a path, so a bad one is dropped
    // while the line it sits on is kept — the outcome still happened
    if (typeof item.worktree === 'string' && isValidWorktreeName(item.worktree)) {
      line.worktree = item.worktree
    }
    if (state === 'failed' && typeof item.note === 'string') line.note = item.note
    lines.push(line)
  }
  // newest first; stable, so two lines in the same minute keep the order they were written
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
  // the same question loadCron asks before deciding to keep a copy aside; asked again
  // here because this function is also called on its own (tests, a future caller)
  if (!isCronFile(raw)) return empty

  const pinnedSet = new Set(pinned)
  // an empty list is almost certainly a layout that did not load — see the header
  const filterByPin = pinnedSet.size > 0
  const jobs: CronJob[] = []
  const notes: Record<string, string> = {}
  // the id is the key everything downstream is filed under — the launch lock, the
  // clock, the held dues, the start deadline, the dialog's rows. A copy-pasted job in a
  // hand-edited file would make two jobs share all of them: one would never fire, and
  // its outcomes would be written onto the other's history. Only the first one wins.
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
    // a model that is there but unusable is a REPAIR, not a reason to drop the job: the
    // run still makes sense on the default model, and the card says what was ignored
    if (item.model !== undefined) {
      if (typeof item.model === 'string' && isValidModelName(item.model)) job.model = item.model
      else notes[id] = BAD_MODEL_NOTE
    }
    if (isCronEffort(item.effort)) job.effort = item.effort
    seen.add(id)
    jobs.push(job)
  }
  return { jobs, notes }
}

/** the shape the file must have before the sanitizer is worth running */
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
    // "not there" is the ordinary first run. Anything else — no permission, a disk that
    // answered with an error — means the file may well still be there with every job in
    // it, and answering "no jobs" would let the next save rewrite it away for good. We
    // have no text to copy, so move the file itself out of harm's way.
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

/** Node reports a file that is not there with this code, and so must any stand-in. */
function isMissingFile(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: unknown }).code === 'ENOENT'
}

/** The read failed, so there is no text to copy — rename the file instead. Best effort:
 *  a move we cannot do must not stop the app from starting. */
function moveBrokenAside(fs: CronStoreFs, file: string): void {
  try {
    fs.rename(file, `${file}.broken-${Date.now()}`)
  } catch {
    /* nothing left to try; the file stays where it is */
  }
}

/** The file is there but says nothing Koloft understands, and the next save will write
 *  over it. Keep a copy first — a person can put their jobs back from it. */
function keepBroken(fs: CronStoreFs, file: string, text: string): void {
  try {
    fs.writeFile(`${file}.broken-${Date.now()}`, text)
  } catch {
    /* best effort — a copy we cannot write must not stop the app from starting */
  }
}

export function saveCron(fs: CronStoreFs, file: string, jobs: CronJob[]): void {
  // tmp + rename, like settings.ts: a crash mid-write must not leave a half file that
  // the next load reads as "no jobs at all"
  try {
    const tmp = `${file}.tmp`
    fs.writeFile(tmp, JSON.stringify({ version: 1, jobs }, null, 2))
    fs.rename(tmp, file)
  } catch {
    /* best effort */
  }
}
