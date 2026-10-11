import { isValidWorktreeName } from './worktreeName'

export interface RouteWorkspace {
  path: string
  machine: string
  name: string
  git: boolean
  worktrees: string[]
  titles: string[]
}

export type RouteWorktree =
  | { kind: 'main' }
  | { kind: 'existing'; name: string }
  | { kind: 'issue'; number: number }
  | { kind: 'new'; name: string }

export interface RouteText {
  title: string
  why: string
}

export type SessionRoute =
  | (RouteText & { kind: 'workspace'; path: string; worktree: RouteWorktree | null; sure: boolean })
  | (RouteText & { kind: 'project'; machine: string; folder: string | null })

export const LOCAL_MACHINE = 'local'

const TITLES_SENT_PER_WORKSPACE = 5
const PROMPT_MAX_CHARS_SENT = 4000
const TITLE_MAX_CHARS = 40
const WHY_MAX_CHARS = 200

const ROUTE_SYSTEM = 'You decide where a new coding session should start.'

function workspaceLines(list: RouteWorkspace[]): string {
  return list
    .map((w, i) => {
      const head = `${i + 1} | ${w.machine} | ${w.name} | ${w.git ? 'git' : 'not git'} | ${w.titles
        .slice(0, TITLES_SENT_PER_WORKSPACE)
        .join('; ')}`
      return w.git ? `${head}\n   existing worktrees: ${w.worktrees.join(', ') || '(none)'}` : head
    })
    .join('\n')
}

export function routeJob(
  list: RouteWorkspace[],
  message: string
): { system: string; prompt: string } {
  const machines = [...new Set([LOCAL_MACHINE, ...list.map((w) => w.machine)])]
  const prompt = `Machines: ${machines.map((m) => `"${m}"`).join(', ')} ("${LOCAL_MACHINE}" is this computer)

Workspaces (id | machine | folder name | git? | recent session titles):
${workspaceLines(list)}

The person's first message for the new session:
<<<
${message.slice(0, PROMPT_MAX_CHARS_SENT)}
>>>

Reply with one JSON object and nothing else:
{"workspace": <workspace id, or null when this needs a brand-new project>,
 "machine": <only when workspace is null: "${LOCAL_MACHINE}", or the machine the person named>,
 "newFolder": <only when workspace is null: a short kebab-case English folder name, a name only, never a path>,
 "worktree": <"main" to work in the main checkout (always "main" for a folder that is not git),
              or {"existing": "<name>"} to continue in a listed worktree,
              or {"issue": <number>} when the message names an issue number,
              or {"new": "<short kebab-case English name, at most 30 chars, not a listed one>"}>,
 "title": <a very short title in the language of the message, at most 16 Chinese characters or 6 words>,
 "sure": <true only when the message names one workspace or clearly points to exactly one (by its folder name, what it is about, or one of its recent session titles); false when it could fit more than one, like "fix the tests" or "tidy the README">,
 "why": <one short sentence in the language of the message>}
Use a new worktree for a change to the code; use "main" for releasing, reading, asking or investigating without changing code.`
  return { system: ROUTE_SYSTEM, prompt }
}

function jsonIn(reply: string): Record<string, unknown> | null {
  const start = reply.indexOf('{')
  const end = reply.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const v: unknown = JSON.parse(reply.slice(start, end + 1))
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function text(v: unknown, max = TITLE_MAX_CHARS): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : ''
}

export function distinctName(name: string, taken: string[]): string {
  const used = new Set(taken.map((t) => t.toLowerCase()))
  if (!used.has(name.toLowerCase())) return name
  let n = 2
  while (used.has(`${name}-${n}`.toLowerCase())) n++
  return `${name}-${n}`
}

function worktreeOf(raw: unknown, ws: RouteWorkspace): RouteWorktree | null {
  if (!ws.git || raw === 'main') return { kind: 'main' }
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (typeof o.existing === 'string') {
    const hit = ws.worktrees.find((w) => w.toLowerCase() === String(o.existing).toLowerCase())
    return hit ? { kind: 'existing', name: hit } : null
  }
  if (typeof o.issue === 'number' && Number.isInteger(o.issue) && o.issue > 0)
    return { kind: 'issue', number: o.issue }
  if (typeof o.new === 'string') {
    const name = o.new.trim()
    if (!isValidWorktreeName(name) || name.toLowerCase() === 'main') return null
    return { kind: 'new', name: distinctName(name, ws.worktrees) }
  }
  return null
}

export function parseRoute(reply: string | null, list: RouteWorkspace[]): SessionRoute | null {
  const o = reply ? jsonIn(reply) : null
  if (!o) return null
  const said = { title: text(o.title), why: text(o.why, WHY_MAX_CHARS) }
  if (o.workspace === null) {
    const machines = new Set(list.map((w) => w.machine))
    const machine =
      typeof o.machine === 'string' && machines.has(o.machine) ? o.machine : LOCAL_MACHINE
    const folder = typeof o.newFolder === 'string' ? o.newFolder.trim() : ''
    return {
      ...said,
      kind: 'project',
      machine,
      folder: isValidWorktreeName(folder) ? folder : null
    }
  }
  const ws = typeof o.workspace === 'number' ? list[o.workspace - 1] : undefined
  if (!ws) return null
  return {
    ...said,
    kind: 'workspace',
    path: ws.path,
    worktree: worktreeOf(o.worktree, ws),
    sure: o.sure !== false
  }
}
