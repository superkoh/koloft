import { worktreeBase } from './cronNames'
import { ROUTABLE_FEATURES } from './paletteFeatures'
import { isValidWorktreeName } from './worktreeName'

export interface RouteSession {
  id: string
  title: string
}

export interface RouteWorkspace {
  path: string
  machine: string
  name: string
  git: boolean
  worktrees: string[]
  sessions: RouteSession[]
}

export type RouteWorktree =
  { kind: 'main' } | { kind: 'issue'; number: number } | { kind: 'new'; name: string }

export interface RouteText {
  title: string
  why: string
}

export type SessionRoute =
  | (RouteText & { kind: 'workspace'; path: string; worktree: RouteWorktree | null })
  | (RouteText & { kind: 'project'; machine: string; folder: string | null })
  | (RouteText & { kind: 'koloft' })
  | (RouteText & { kind: 'discord' })
  | (RouteText & { kind: 'assist'; path: string })
  | (RouteText & { kind: 'feature'; key: string })
  | (RouteText & { kind: 'session'; path: string; id: string })

export const LOCAL_MACHINE = 'local'

const SESSIONS_SENT_PER_WORKSPACE = 5
const PROMPT_MAX_CHARS_SENT = 4000
const TITLE_MAX_CHARS = 40
const WHY_MAX_CHARS = 200
// CODEX§31
const CHECK_IN_RULE = 1

const ROUTE_SYSTEM = 'You decide who in the Koloft app should take what a person typed.'

const sessionsSent = (w: RouteWorkspace): RouteSession[] =>
  w.sessions.slice(0, SESSIONS_SENT_PER_WORKSPACE)

function sessionOfRef(
  list: RouteWorkspace[],
  ref: string
): { path: string; session: RouteSession } | undefined {
  const [i, j] = ref.split('.').map(Number)
  const w = list[i - 1]
  const session = w && sessionsSent(w)[j - 1]
  return session && { path: w.path, session }
}

function workspaceLines(list: RouteWorkspace[]): string {
  return list
    .map((w, i) => {
      const recent = sessionsSent(w)
        .map((s, j) => `[${i + 1}.${j + 1}] ${s.title}`)
        .join('; ')
      const head = `${i + 1} | ${w.machine} | ${w.name} | ${w.git ? 'git' : 'not git'} | ${recent}`
      return w.git ? `${head}\n   existing worktrees: ${w.worktrees.join(', ') || '(none)'}` : head
    })
    .join('\n')
}

const featureLines = (): string =>
  ROUTABLE_FEATURES.map((f) => `${f.key} | ${f.label} | ${f.words.join(', ')}`).join('\n')

export function routeJob(
  list: RouteWorkspace[],
  message: string
): { system: string; prompt: string } {
  const machines = [...new Set([LOCAL_MACHINE, ...list.map((w) => w.machine)])]
  const prompt = `Machines: ${machines.map((m) => `"${m}"`).join(', ')} ("${LOCAL_MACHINE}" is this computer)

Workspaces (id | machine | folder name | git? | recent sessions as [session ref] title):
${workspaceLines(list)}

Koloft features (key | name | words people use for it):
${featureLines()}

What the person typed:
<<<
${message.slice(0, PROMPT_MAX_CHARS_SENT)}
>>>

Go down these rules in order and take the first that fits:
${CHECK_IN_RULE}. It is meant for the sessions already working in one workspace: it asks how their work is going or whether it is done, or passes them a change to what they are doing ("ask <folder name> …", "tell <folder name> …", "how's <folder name> doing …", "is <folder name> done with …", "问一下 <folder name> …", "告诉 <folder name> …", "跟 <folder name> 说 …", "让 <folder name> 那边 …", "<folder name> 那边 … 好了没"); a plain order for new work, with no hint of work already going on there, is not this: {"hand": "assist", "workspace": <id>}
2. It wants Koloft connected to Discord or its Discord set up: {"hand": "discord"}
3. It wants one of the Koloft features above opened or done ("open settings", "check for updates"): {"hand": "feature", "feature": "<key>"}
4. It only wants to open or go to one existing session, and one listed session title says the same thing it names (never a guess): {"hand": "session", "session": "<session ref>"}
5. It wants something done with existing sessions (continue or resume one, stop, restart, check on or message them), even when it names one: {"hand": "koloft"}
6. It is work to change, build, look into or explain something inside a project (also a question or bug report about how that project behaves, like "why does X in <folder> not show"), and exactly one workspace fits (by its folder name, what it is about, or one of its recent session titles): {"workspace": <id>, "worktree": <see below>}
7. It wants something new built (a new program, tool or project) that belongs to no workspace: {"workspace": null, "machine": <"${LOCAL_MACHINE}", or the machine the person named>, "newFolder": <a short kebab-case English folder name, a name only, never a path>}
8. Anything else: a question not about one project, a translation, something to write that no workspace is for, a fact to look up (like whether a pull request is merged), a scheduled job, work across several workspaces, work that could fit more than one workspace ("fix the tests", "tidy the README"), or a Koloft setting not in the features above: {"hand": "koloft"}

"worktree" (rule 6 only): "main" for a folder that is not git; a git folder never works in its main checkout, even to read, ask or release, and never in a worktree that already exists, so for one:
  {"issue": <number>} when the message names an issue number,
  or {"new": "<short kebab-case English name, at most 30 chars, not a listed one>"}

Reply with that one JSON object and nothing else, adding to it:
 "title": <a very short title in the language of the message, at most 16 Chinese characters or 6 words>,
 "why": <one short sentence in the language of the message, naming the rule you took>,
 "rule": <the number of the rule you named in "why">`
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

export function freshWorktreeName(
  worktrees: { name: string }[],
  now: number,
  wished?: string
): string {
  return distinctName(
    wished ?? worktreeBase('session', now),
    worktrees.map((w) => w.name)
  )
}

function worktreeOf(raw: unknown, ws: RouteWorkspace): RouteWorktree | null {
  if (!ws.git) return { kind: 'main' }
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
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
  if (o.hand === 'koloft') return { ...said, kind: 'koloft' }
  if (o.hand === 'discord') return { ...said, kind: 'discord' }
  if (o.hand === 'feature' || o.feature !== undefined) {
    const feature = ROUTABLE_FEATURES.find((f) => f.key === o.feature)
    return feature ? { ...said, kind: 'feature', key: feature.key } : null
  }
  if (o.hand === 'session') {
    const hit = sessionOfRef(list, String(o.session))
    return hit ? { ...said, kind: 'session', path: hit.path, id: hit.session.id } : null
  }
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
  if (o.hand === 'assist' || o.rule === CHECK_IN_RULE)
    return { ...said, kind: 'assist', path: ws.path }
  return {
    ...said,
    kind: 'workspace',
    path: ws.path,
    worktree: worktreeOf(o.worktree, ws)
  }
}
