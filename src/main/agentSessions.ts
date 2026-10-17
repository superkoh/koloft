import type {
  BackendId,
  CreateTabOptions,
  SessionInfo,
  SessionRow,
  SessionStatus,
  WorkspaceRows,
  WorktreeInfo
} from '@shared/types'
import { ASSIST_SAYS_OPENING, DISCORD_PREFIX, ownerSays } from '@shared/agentGuide'
import {
  BACKEND_LABEL,
  PEER_TRAITS,
  SESSION_BACKENDS,
  backendIdOf,
  messagingOf
} from '@shared/sessionBackend'
import { isValidWorktreeName } from '@shared/worktreeName'
import { withoutBlankEdges } from './messageText'
import { freshWorktreeName } from '@shared/sessionRoute'
import { isRemoteKey, parseRemoteKey, remoteCopyText } from '@shared/remoteKey'
import { basename } from '@shared/preview'
import { GLOBAL_SCOPE, scopeName } from '@shared/conductors'
import { ageLabel } from '@shared/freshnessOps'
import { MAX_READ_TURNS, type Turn } from '@shared/turns'
import { MYSELF, slashCommandProblem } from '@shared/slashCommands'
import {
  answered,
  errorText,
  EXIT_USAGE,
  fail,
  ONLY_ASSIST,
  refused,
  splitAtDashes,
  type AgentCaller,
  type AgentReply,
  type AgentVerb,
  type Parsed
} from './agentRequests'
import { AGENT_SHIM_WAITS_MS } from './agentShim'
import { FROM_A_SESSION, crossSessionLine, type ModeClass } from './crossSessionMessage'
import {
  OWNER_WORDS_QUOTED_CHARS,
  handoverInOwnersLanguage,
  withHandover,
  type SessionCaller
} from './handover'
import { nameForTask } from './sessionTitle'
import type { Assist } from './assist'
import { keysFor } from './typeKeys'
import type { StartedSessions } from './startedSessions'

export interface NewSessionArgs {
  name?: string
  workspace?: string
  worktree?: string
  model?: string
  backend?: BackendId
  prompt: string
}

const NEW_FLAGS: Record<string, 'name' | 'workspace' | 'worktree' | 'model' | 'backend'> = {
  '--name': 'name',
  '--workspace': 'workspace',
  '-w': 'worktree',
  '--model': 'model',
  '--backend': 'backend'
}

const PROMPT_AFTER_DASHES =
  'put the first message after --, like: -- "Fix the broken links in docs/."'

export function parseNewSessionArgs(args: string[]): Parsed<NewSessionArgs> {
  const flags: Omit<NewSessionArgs, 'prompt'> = {}
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--') {
      const prompt = args
        .slice(i + 1)
        .join(' ')
        .trim()
      return prompt ? { ok: true, value: { ...flags, prompt } } : fail(PROMPT_AFTER_DASHES)
    }
    const key = Object.hasOwn(NEW_FLAGS, arg) ? NEW_FLAGS[arg] : undefined
    if (!key) return fail(`did not expect "${arg}". ${PROMPT_AFTER_DASHES}`)
    const value = args[i + 1]
    if (value === undefined || value === '--') return fail(`${arg} needs a value.`)
    if (key === 'worktree' && !isValidWorktreeName(value))
      return fail(`"${value}" cannot be a worktree name. Use letters, digits, dots, - and _.`)
    if (key === 'backend') {
      const backend = backendIdOf(value)
      if (!backend) return fail(`--backend is one of ${SESSION_BACKENDS.join(', ')}.`)
      flags.backend = backend
    } else flags[key] = value
    i++
  }
  return fail(PROMPT_AFTER_DASHES)
}

const ASKING = 'asking the owner a question'

const STATE_WORDS: Record<SessionStatus, string> = {
  working: 'working',
  approval: ASKING,
  waiting: 'finished its turn',
  idle: 'idle'
}

function stateWords(info: SessionInfo | undefined, asking: (tabId: string) => boolean): string {
  return info && asking(info.tabId) ? ASKING : STATE_WORDS[info?.status ?? 'idle']
}

interface ListedSession {
  info: SessionInfo
  peerName?: string
  starter?: string
}

function idToReach(s: SessionInfo): string {
  return s.nativeSessionId ?? s.sessionId
}

function starterPart(starter: string | undefined): string[] {
  return starter ? [`started by: ${starter}`] : []
}

function openSessionLines(
  sessions: ListedSession[],
  callerTabId: string,
  asking: (tabId: string) => boolean
): string[] {
  return sessions.map(({ info, peerName, starter }) => {
    const parts = [
      `${info.title}${info.tabId === callerTabId ? ' (you)' : ''}`,
      BACKEND_LABEL[info.backendId],
      stateWords(info, asking)
    ]
    if (!PEER_TRAITS[info.backendId].reachedBySendMessage) parts.push(`id: ${idToReach(info)}`)
    if (peerName) parts.push(`name: ${peerName}`)
    parts.push(...starterPart(starter))
    const transcript = info.details?.claude?.jsonlPath
    if (transcript) parts.push(`transcript: ${transcript}`)
    return parts.join(' · ')
  })
}

export interface PinnedWorkspace {
  path: string
  missing: boolean
}

function workspaceLabel(wsPath: string): string {
  const key = parseRemoteKey(wsPath)
  return key ? remoteCopyText(key.host, key.path) : wsPath
}

interface PlacedRow {
  workspace: string
  row: SessionRow
  title: string
  live?: SessionInfo
}

function placedRows(sidebar: WorkspaceRows[], sessions: SessionInfo[]): PlacedRow[] {
  return sidebar.flatMap((w) =>
    w.rows
      .filter((row) => !row.pending)
      .map((row) => {
        const live = sessions.find((s) => s.alive && s.sessionId === row.id)
        return { workspace: w.workspace.path, row, title: live?.title ?? row.title, live }
      })
  )
}

function inScope(scope: string | undefined, workspace: string): boolean {
  return scope === undefined || scope === GLOBAL_SCOPE || scope === workspace
}

function peerNamesOf(d: SessionVerbDeps, placed: PlacedRow[]): Promise<(string | null)[]> {
  const nameOf = d.peerNames()
  return Promise.all(placed.map((p) => (p.live ? nameOf(p.live) : null)))
}

function rowLines(
  placed: PlacedRow[],
  names: (string | null)[],
  starters: (string | undefined)[],
  withWorkspace: boolean,
  now: number,
  asking: (tabId: string) => boolean
): string[] {
  return placed.map(({ workspace, row, title, live: info }, i) => {
    const parts = [
      title,
      BACKEND_LABEL[row.backendId],
      parseRemoteKey(workspace)?.host ?? 'local',
      info || row.running ? stateWords(info, asking) : 'closed',
      `last active ${ageLabel(row.mtime, now)}`,
      `id: ${row.nativeSessionId ?? row.id}`
    ]
    if (names[i]) parts.push(`name: ${names[i]}`)
    parts.push(...starterPart(starters[i]))
    if (withWorkspace) parts.push(`workspace: ${workspaceLabel(workspace)}`)
    return parts.join(' · ')
  })
}

function formatTurns(turns: Turn[]): string {
  return turns
    .map((turn) =>
      [
        ...turn.said.map((line) => `${line.who}: ${line.text}`),
        ...(turn.reply ? [`assistant: ${turn.reply}`] : [])
      ].join('\n')
    )
    .join('\n\n')
}

const NO_REMOTE_START =
  'the koloft command cannot start a session in a remote (SSH) workspace. Pick a workspace on this computer.'

export function resolveWorkspace(ref: string, pinned: PinnedWorkspace[]): Parsed<PinnedWorkspace> {
  const hits = pinned.filter(
    (w) => w.path === ref || workspaceLabel(w.path) === ref || basename(w.path) === ref
  )
  const labels = (ws: PinnedWorkspace[]): string =>
    ws.map((w) => `  ${workspaceLabel(w.path)}`).join('\n')
  if (hits.length === 0)
    return fail(
      `there is no workspace "${ref}" in Koloft's sidebar. Give the folder name or full path of one of these:\n${labels(pinned)}`
    )
  if (hits.length > 1)
    return fail(
      `${hits.length} workspaces are named "${ref}". Give the full path:\n${labels(hits)}`
    )
  return { ok: true, value: hits[0] }
}

function startableWorkspace(ref: string, pinned: PinnedWorkspace[]): Parsed<string> {
  const found = resolveWorkspace(ref, pinned)
  if (!found.ok) return fail(found.error)
  if (isRemoteKey(found.value.path)) return fail(NO_REMOTE_START)
  if (found.value.missing) return fail(`the folder of workspace "${found.value.path}" is missing.`)
  return { ok: true, value: found.value.path }
}

const CLAUDE_USES_SEND_MESSAGE =
  'a Claude session talks to another Claude session with its SendMessage tool; ListAgents shows their names. This command reaches Codex and Muse sessions, and the session or Assist that started you.'

function matchRef<T>(
  items: T[],
  ref: string,
  isId: (item: T, i: number) => boolean,
  titleOf: (item: T) => string
): Parsed<T> | null {
  const byId = items.find(isId)
  const hits = byId ? [byId] : items.filter((item) => titleOf(item) === ref)
  if (hits.length > 1)
    return fail(
      `${hits.length} sessions are named "${ref}". Use the id from "koloft session list".`
    )
  return hits.length ? { ok: true, value: hits[0] } : null
}

function matchOpen(sessions: SessionInfo[], ref: string): Parsed<SessionInfo> | null {
  return matchRef(
    sessions,
    ref,
    (s) => s.nativeSessionId === ref || s.sessionId === ref || s.tabId === ref,
    (s) => s.title
  )
}

export function findSiblingTarget(
  sessions: SessionInfo[],
  ref: string,
  from: BackendId
): Parsed<SessionInfo> {
  const hit = matchOpen(sessions, ref)
  if (!hit) return fail(`there is no open session "${ref}". Run "koloft session list" to see them.`)
  return hit.ok &&
    PEER_TRAITS[hit.value.backendId].reachedBySendMessage &&
    PEER_TRAITS[from].reachedBySendMessage
    ? fail(CLAUDE_USES_SEND_MESSAGE)
    : hit
}

function openTarget(s: SessionInfo & { tabId: string }): Target {
  return {
    key: s.sessionId,
    name: s.title,
    backend: s.backendId,
    remote: !!s.remote,
    tabId: s.tabId,
    open: async () => s.tabId
  }
}

export interface ClosableSession {
  sessionId: string
  nativeSessionId?: string
  backendId: BackendId
  title: string
  treeRoot: string
  tabId?: string
}

export type PeerNameOf = (s: { backendId: BackendId; sessionId: string }) => Promise<string | null>

export async function findClosable(
  sessions: ClosableSession[],
  ref: string,
  nameOf: PeerNameOf
): Promise<Parsed<ClosableSession>> {
  const names = await Promise.all(sessions.map((s) => nameOf(s)))
  const hit = matchRef(
    sessions,
    ref,
    (s, i) =>
      s.sessionId === ref || s.nativeSessionId === ref || s.tabId === ref || names[i] === ref,
    (s) => s.title
  )
  if (hit && !hit.ok) return fail(`koloft session close: ${hit.error}`)
  return (
    hit ??
    fail(
      `koloft session close: you did not start a session "${ref}". You can close only this session, or one started with koloft session new by you or by a session you started.`
    )
  )
}

export interface SessionVerbDeps {
  workspaceOf(tabId: string): string | undefined
  allSessions(): SessionInfo[]
  pinnedWorkspaces(): PinnedWorkspace[]
  peerNames(): PeerNameOf
  launch(options: CreateTabOptions & { kind: BackendId }): Promise<string | null>
  assist: Assist
  queue(tabId: string, text: string, clientId?: string): Promise<void>
  startedSessions: StartedSessions
  closable(): ClosableSession[]
  whatIsLeft(target: ClosableSession): Promise<string[]>
  closeSoon(target: ClosableSession): void
  conductorScope(tabId: string): string | undefined
  sidebar(): WorkspaceRows[]
  worktrees(workspace: string): Promise<WorktreeInfo[]>
  readTurns(key: string, n: number): Promise<Turn[]>
  quotedPrompt(tabId: string): string | undefined
  touch(tabId: string, key: string): void
  conductorOf(ref: string): Target | undefined
  resume(row: SessionRow): Promise<string>
  ready(tabId: string, ms: number, turnEnded: boolean): Promise<boolean>
  asking(tabId: string): boolean
  sendLine(tabId: string, line: string, ms: number): Promise<void>
  press(tabId: string, keys: string[]): Promise<void>
  modeOf(tabId: string): ModeClass
  stop(tabId: string): void
  answer(tabId: string, reply: string): Promise<string | undefined>
  undelivered(callerTab: string, target: Target, why: string): void
  command(callerTab: string, target: Target, text: string): Promise<string>
  screen(tabId: string): Promise<SessionScreen>
  started(
    conductorTab: string,
    tabId: string,
    name: string,
    workspace: string,
    backend: BackendId
  ): void
}

export type SessionScreen = { lines: string[]; notes: string[] } | { error: string }

export interface Target {
  key: string
  name: string
  backend: BackendId
  remote: boolean
  workspace?: string
  tabId?: string
  assistScope?: string
  open(): Promise<string>
}

const SESSION_USAGE =
  'koloft session: use list, read, new, send, command, screen, keys, answer, resume, stop or close. Run "koloft help" to see how.'
const READ_USAGE = `koloft session read: give an id or name, and if you like --last <1 to ${MAX_READ_TURNS}>, like: koloft session read fix-login --last 3`
const CONDUCTOR_LIST_USAGE =
  'koloft session list: it takes no options here; it lists every session you look after.'
export const NOT_IN_YOUR_WORKSPACE = 'That session is not in your workspace.'
const SEND_USAGE =
  'koloft session send: give an id or name, then the message, like: koloft session send <id> "Tell me what you found."'
const NO_WORKSPACE = 'koloft session: Koloft does not know which workspace this session is in.'
const LIST_USAGE =
  'koloft session list: the only option is --workspace <folder name or path>, like: koloft session list --workspace koloft'
const hasNoName = (backend: BackendId): string =>
  `koloft session new: a ${BACKEND_LABEL[backend]} session has no name, so leave out --name. Koloft prints an id to reach it by.`

function starterNamer(
  d: SessionVerbDeps,
  everyRow: PlacedRow[],
  me: { sessionId: string }
): (target: { sessionId: string; tabId?: string }) => string | undefined {
  const titles = new Map(everyRow.map((p) => [p.row.id, p.title]))
  return (target) => {
    const [starter] = d.startedSessions.startersOf(target)
    return starter === me.sessionId ? 'you' : starter && titles.get(starter)
  }
}

function placedStarters(
  d: SessionVerbDeps,
  everyRow: PlacedRow[],
  placed: PlacedRow[],
  me: { sessionId: string }
): (string | undefined)[] {
  const starterOf = starterNamer(d, everyRow, me)
  return placed.map((p) => starterOf({ sessionId: p.row.id, tabId: p.live?.tabId }))
}

async function listSessions(
  d: SessionVerbDeps,
  sessions: SessionInfo[],
  me: SessionInfo,
  workspace: string
): Promise<AgentReply> {
  const everyRow = placedRows(d.sidebar(), sessions)
  const starterOf = starterNamer(d, everyRow, me)
  const peerName = d.peerNames()
  const listed = await Promise.all(
    sessions.map(async (info) => ({
      info,
      peerName: (await peerName(info)) ?? undefined,
      starter: starterOf(info)
    }))
  )
  const open = new Set(sessions.map((s) => s.sessionId))
  const notOpen = everyRow.filter((p) => p.workspace === workspace && !open.has(p.row.id))
  const lines = [
    ...openSessionLines(listed, me.tabId, d.asking),
    ...rowLines(notOpen, [], placedStarters(d, everyRow, notOpen, me), false, Date.now(), d.asking)
  ]
  return answered(lines.join('\n') || 'This workspace has no sessions.')
}

async function startSibling(
  d: SessionVerbDeps,
  args: NewSessionArgs,
  me: SessionInfo,
  workspace: string,
  conductorTab: string | undefined,
  ownerWords: string | undefined,
  oweReply: (tabId: string) => void
): Promise<AgentReply> {
  const backend = args.backend ?? me.backendId
  const traits = PEER_TRAITS[backend]
  if (!traits.namedAtLaunch && args.name !== undefined)
    return refused(hasNoName(backend), EXIT_USAGE)
  const caller: SessionCaller = {
    name:
      (await d.peerNames()(me)) ??
      (PEER_TRAITS[me.backendId].reachedBySendMessage ? me.title : undefined),
    id: idToReach(me),
    label: BACKEND_LABEL[me.backendId],
    assist: conductorTab !== undefined,
    ownerWords
  }
  const [name, preamble] = await Promise.all([
    !traits.namedAtLaunch
      ? undefined
      : (args.name ??
        nameForTask(
          args.prompt,
          d.assist,
          new Set(d.allSessions().map((s) => s.title)),
          ownerWords
        )),
    handoverInOwnersLanguage(caller, d.assist)
  ])
  const gitWorkspace = d.sidebar().some((w) => w.workspace.path === workspace && w.workspace.isGit)
  const worktree =
    gitWorkspace && (args.worktree || caller.assist)
      ? freshWorktreeName(await d.worktrees(workspace), Date.now(), args.worktree)
      : args.worktree
  const tabId = await d.launch({
    kind: backend,
    cwd: workspace,
    name,
    worktree,
    model: args.model,
    // ADR-0028
    permission: d.modeOf(me.tabId) === 'bypass' ? 'bypass' : 'default',
    ownerWords,
    // CODEX§17
    ...(traits.handoverAsRole
      ? { role: preamble, firstPrompt: args.prompt }
      : { firstPrompt: withHandover(preamble, args.prompt) })
  })
  if (!tabId) return refused('koloft session new: Koloft could not start the session.')
  oweReply(tabId)
  d.startedSessions.started(tabId, me.sessionId)
  const unnamed = `a ${BACKEND_LABEL[backend]} session`
  if (conductorTab) {
    d.started(conductorTab, tabId, name ?? unnamed, workspace, backend)
    return answered(
      `Started ${name ? `session "${name}"` : unnamed} in a new tab. "koloft session list" shows its id once it starts; reach it with koloft session send.`
    )
  }
  const listHint =
    args.workspace === undefined
      ? 'koloft session list'
      : `koloft session list --workspace ${JSON.stringify(workspace)}`
  return answered(
    traits.reachedBySendMessage
      ? `Started session "${name}" in a new tab. Talk to it with SendMessage to "${name}".`
      : `Started ${name ? `${BACKEND_LABEL[backend]} session "${name}"` : unnamed} in a new tab: ${tabId}. Its id shows in "${listHint}" once it starts; "koloft session send ${tabId} <message>" also reaches it.`
  )
}

function parseReadArgs(rest: string[]): Parsed<{ ref: string; last: number }> {
  const flag = rest.indexOf('--last')
  const ref = (flag < 0 ? rest : rest.slice(0, flag)).join(' ')
  if (!ref) return fail(READ_USAGE)
  if (flag < 0) return { ok: true, value: { ref, last: 1 } }
  const [value, ...extra] = rest.slice(flag + 1)
  const last = Number(value)
  if (extra.length > 0 || !Number.isInteger(last) || last < 1 || last > MAX_READ_TURNS)
    return fail(READ_USAGE)
  return { ok: true, value: { ref, last } }
}

function nameThenWords(
  words: string[],
  isName: (ref: string) => boolean
): Parsed<{ ref: string; tail: string[] }> {
  const heads = words.slice(0, -1).map((_, i) => words.slice(0, i + 1).join(' '))
  const named = heads.filter(isName)
  if (named.length > 1)
    return fail(
      `${named.map((n) => `"${n}"`).join(' and ')} are all session names, so Koloft cannot tell where the name ends. Give the session's id from "koloft session list" instead.`
    )
  const count = named.length ? heads.indexOf(named[0]) + 1 : 1
  return { ok: true, value: { ref: words.slice(0, count).join(' '), tail: words.slice(count) } }
}

function wholeName(words: string[]): Parsed<{ ref: string; tail: string[] }> {
  return { ok: true, value: { ref: words.join(' '), tail: [] } }
}

function asArgument(ref: string): string {
  return /\s/.test(ref) ? JSON.stringify(ref) : ref
}

function matchRow(
  placed: PlacedRow[],
  ref: string,
  names: (string | null)[] = []
): Parsed<PlacedRow> | null {
  return matchRef(
    placed,
    ref,
    (p, i) => p.row.id === ref || p.row.nativeSessionId === ref || names[i] === ref,
    (p) => p.title
  )
}

function findInScope(
  d: SessionVerbDeps,
  verb: string,
  ref: string,
  callerTabId: string
): Promise<Parsed<PlacedRow>> {
  return findIn(d, verb, ref, d.conductorScope(callerTabId))
}

function rowTarget(d: SessionVerbDeps, p: PlacedRow): Target {
  return {
    key: p.row.id,
    name: p.title,
    backend: p.row.backendId,
    remote: isRemoteKey(p.workspace),
    workspace: p.workspace,
    tabId: p.live?.tabId,
    open: () => d.resume(p.row)
  }
}

function starterRow(
  d: SessionVerbDeps,
  caller: AgentCaller,
  open: SessionInfo[]
): PlacedRow | undefined {
  const [id] = d.startedSessions.startersOf({ ...caller.session, tabId: caller.tabId })
  return id === undefined ? undefined : placedRows(d.sidebar(), open).find((r) => r.row.id === id)
}

export async function targetIn(
  d: SessionVerbDeps,
  scope: string,
  ref: string
): Promise<Parsed<Target>> {
  const found = await findIn(d, 'command', ref, scope)
  return found.ok ? { ok: true, value: rowTarget(d, found.value) } : found
}

export function sessionChoices(
  d: SessionVerbDeps,
  scope: string
): { name: string; value: string }[] {
  return placedRows(d.sidebar(), d.allSessions())
    .filter((p) => inScope(scope, p.workspace))
    .map((p) => ({
      name: `${p.title} · ${BACKEND_LABEL[p.row.backendId]}${scope === GLOBAL_SCOPE ? ` · ${scopeName(p.workspace)}` : ''}`,
      value: p.row.id
    }))
}

interface ScopedRows {
  all: PlacedRow[]
  mine: PlacedRow[]
  names: (string | null)[]
}

async function rowsIn(d: SessionVerbDeps, scope: string | undefined): Promise<ScopedRows> {
  const all = placedRows(d.sidebar(), d.allSessions())
  const mine = all.filter((p) => inScope(scope, p.workspace))
  return { all, mine, names: await peerNamesOf(d, mine) }
}

function namesARow({ all, mine, names }: ScopedRows, ref: string): boolean {
  return matchRow(mine, ref, names) !== null || matchRow(all, ref) !== null
}

async function findIn(
  d: SessionVerbDeps,
  verb: string,
  ref: string,
  scope: string | undefined
): Promise<Parsed<PlacedRow>> {
  return findAmong(await rowsIn(d, scope), verb, ref)
}

function findAmong({ all, mine, names }: ScopedRows, verb: string, ref: string): Parsed<PlacedRow> {
  const hit = matchRow(mine, ref, names)
  if (hit && !hit.ok) return fail(`koloft session ${verb}: ${hit.error}`)
  if (hit) {
    const name = names[mine.indexOf(hit.value)]
    return { ok: true, value: name ? { ...hit.value, title: name } : hit.value }
  }
  return fail(
    matchRow(all, ref)
      ? `koloft session ${verb}: ${NOT_IN_YOUR_WORKSPACE}`
      : `koloft session ${verb}: there is no session "${ref}". Run "koloft session list" to see them.`
  )
}

async function readSession(
  d: SessionVerbDeps,
  rest: string[],
  callerTabId: string
): Promise<AgentReply> {
  const args = parseReadArgs(rest)
  if (!args.ok) return refused(args.error, EXIT_USAGE)
  const { ref, last } = args.value
  const found = await findInScope(d, 'read', ref, callerTabId)
  if (!found.ok) return refused(found.error)
  const { row, title } = found.value
  const turns = await d.readTurns(row.id, last)
  d.touch(callerTabId, row.id)
  return answered(turns.length > 0 ? formatTurns(turns) : `${title} has said nothing yet.`)
}

async function endedInScope(
  d: SessionVerbDeps,
  ref: string,
  scope: string
): Promise<Parsed<ClosableSession>> {
  const found = await findIn(d, 'close', ref, scope)
  if (!found.ok) return found
  const { row, title, live, workspace } = found.value
  if (live)
    return fail(
      `koloft session close: ${title} is open. Stop it first with koloft session stop, then close it.`
    )
  if (isRemoteKey(workspace))
    return fail(
      `koloft session close: ${title} runs on another machine, where Koloft cannot check what closing it would lose.`
    )
  const ended = d.closable().find((s) => s.sessionId === row.id)
  return ended ? { ok: true, value: ended } : fail(`koloft session close: ${title} is gone.`)
}

export const THAT_IS_YOU = 'That is you.'
const ONLY_A_CONDUCTOR = `${ONLY_ASSIST} can do this.`
const TIME_FOR_THE_REPLY_TO_REACH_THE_SHIM_MS = 2_000
const REPLY_INSIDE_THE_KOLOFT_SHIM_WAIT_MS =
  AGENT_SHIM_WAITS_MS - TIME_FOR_THE_REPLY_TO_REACH_THE_SHIM_MS
const RESUME_USAGE =
  'koloft session resume: give an id or name, and if you like a first message after --, like: koloft session resume fix-login -- "Carry on."'
const STOP_USAGE = 'koloft session stop: give an id or name, like: koloft session stop fix-login'
const ANSWER_USAGE =
  'koloft session answer: give an id or name, then an option number, yes, no or your own words, like: koloft session answer fix-login 2'
const WAITS_FOR_A_CLOSED_OR_BUSY_TARGET_MS = 10 * 60_000
const SHOWS_NOTHING_WHILE_CLOSED = 'it is not open, so it shows no question.'
const BACKEND_IS_FOR_CONDUCTORS = 'koloft session new: only Assist can pick --backend.'
const GLOBAL_NEEDS_WORKSPACE =
  'koloft session new: say which workspace with --workspace <workspace>; "koloft workspace list" shows them.'
const ONLY_YOUR_WORKSPACE = 'koloft session new: you can only start sessions in your own workspace.'

const COMMAND_USAGE = `koloft session command: give an id or name (or "me" for yourself), then one slash command, like: koloft session command fix-login /compact`
const SCREEN_USAGE = `koloft session screen: give an id or name (or "me" for yourself), like: koloft session screen fix-login`
const KEYS_USAGE = `koloft session keys: give an id or name, then the keys to press in order, like: koloft session keys fix-login Down Enter`

function seeAndPress(ref: string): string {
  const arg = asArgument(ref)
  return `To answer it anyway, see what it shows with koloft session screen ${arg}, then press the keys with koloft session keys ${arg} <keys>.`
}

const CONDUCTOR_ACT_USAGE: Record<string, string> = {
  send: SEND_USAGE,
  command: COMMAND_USAGE,
  screen: SCREEN_USAGE,
  keys: KEYS_USAGE,
  answer: ANSWER_USAGE,
  resume: RESUME_USAGE,
  stop: STOP_USAGE
}

export function formatScreen(name: string, screen: SessionScreen): string {
  if ('error' in screen) return `${name}: ${screen.error}`
  const lines = withoutBlankEdges(screen.lines)
  const shown = lines.length ? `\`\`\`\n${lines.join('\n')}\n\`\`\`` : '(the screen is empty)'
  return [`The screen of ${name} right now:`, shown, ...screen.notes].join('\n')
}

function readsItAfterTheQuestion(name: string): string {
  const arg = asArgument(name)
  return `But ${name} is asking the owner a question, so it reads your message only once that is answered. See the question with koloft session screen ${arg} and pass it on to the owner.`
}

const SESSION_SAYS_OPENING = `${FROM_A_SESSION}"`

export function sessionSays(from: SessionInfo, text: string): string {
  return `${SESSION_SAYS_OPENING}${from.title}", id ${idToReach(from)}:) ${text}`
}

const KOLOFT_ENVELOPES = [SESSION_SAYS_OPENING, ASSIST_SAYS_OPENING]

type OwnerWordsHolder = Pick<SessionInfo, 'sessionId' | 'backendId'> & { tabId?: string }

export function lastOwnerWords(turns: Turn[]): string | undefined {
  const line = turns
    .flatMap((t) => t.said)
    .findLast((l) => l.who === 'owner' && !KOLOFT_ENVELOPES.some((e) => l.text.startsWith(e)))
  if (!line) return undefined
  const relayed = `${DISCORD_PREFIX} `
  const words = line.text.startsWith(relayed) ? line.text.slice(relayed.length) : line.text
  return words.slice(0, OWNER_WORDS_QUOTED_CHARS)
}

function isMe(
  ref: string,
  me: SessionInfo,
  mine: Target | undefined,
  callerTabId: string
): boolean {
  return (
    mine?.tabId === callerTabId ||
    [MYSELF, me.sessionId, me.nativeSessionId, me.title].includes(ref)
  )
}

interface OwedReply {
  owner: string
  asked?: string
}

export function sessionVerb(d: SessionVerbDeps): {
  verb: AgentVerb
  turnEnded(tabId: string, turn: Turn): void
} {
  const opening = new Map<string, Promise<string | null>>()
  let queued = 0
  let lined = 0
  const replyOwed = new Map<string, OwedReply>()

  // ADR-0031
  const ownerWordsOf = async (
    s: OwnerWordsHolder,
    seen = new Set<string>()
  ): Promise<string | undefined> => {
    if (PEER_TRAITS[s.backendId].quotesOwnerWordsInHooks)
      return s.tabId ? d.quotedPrompt(s.tabId) : undefined
    seen.add(s.sessionId)
    const [parent] = d.startedSessions.startersOf(s)
    const holder = parent && !seen.has(parent) ? holderOf(parent) : undefined
    if (holder) return ownerWordsOf(holder, seen)
    return lastOwnerWords(await d.readTurns(s.sessionId, MAX_READ_TURNS))
  }

  const holderOf = (sessionId: string): OwnerWordsHolder | undefined => {
    const open = d.allSessions().find((s) => s.sessionId === sessionId)
    if (open) return open
    const assist = d.conductorOf(sessionId)
    return assist && { sessionId, tabId: assist.tabId, backendId: assist.backend }
  }

  const owing = async <T>(
    tab: string,
    owed: OwedReply | undefined,
    act: () => Promise<T>,
    failed: (result: T) => boolean = () => false
  ): Promise<T> => {
    const before = replyOwed.get(tab)
    if (owed) replyOwed.set(tab, owed)
    const takeBack = (): void => {
      if (!owed || replyOwed.get(tab) !== owed) return
      if (before) replyOwed.set(tab, before)
      else replyOwed.delete(tab)
    }
    try {
      const result = await act()
      if (failed(result)) takeBack()
      return result
    } catch (error) {
      takeBack()
      throw error
    }
  }

  const openReady = (t: Target, until: number): Promise<string | null> => {
    const inflight = opening.get(t.key)
    if (inflight) return inflight
    const p = (async (): Promise<string | null> => {
      const tab = await t.open()
      return (await d.ready(tab, until - Date.now(), false)) ? tab : null
    })().finally(() => opening.delete(t.key))
    opening.set(t.key, p)
    return p
  }

  const sendNow = async (
    t: Target,
    text: string,
    line: string | undefined,
    until: number,
    assist?: string
  ): Promise<string> => {
    const tab = t.tabId ?? (await openReady(t, until))
    if (!tab) throw new Error(`${t.name} was resumed but did not get ready in time.`)
    const owed = assist
      ? {
          owner: assist,
          asked: messagingOf(t.backend, !!t.remote) === 'queue' ? text : undefined
        }
      : undefined
    return owing(tab, owed, () => sendInto(t, tab, text, line, until))
  }

  const sendInto = async (
    t: Target,
    tab: string,
    text: string,
    line: string | undefined,
    until: number
  ): Promise<string> => {
    if (messagingOf(t.backend, !!t.remote) === 'queue') {
      await d.queue(tab, text, `koloft-conductor-${++queued}`)
      return `Sent to ${t.name}.`
    }
    if (line) {
      await d.sendLine(tab, line, until - Date.now())
      return `Sent to ${t.name}.`
    }
    if (!(await d.ready(tab, until - Date.now(), true)))
      throw new Error(
        `${t.name} stayed busy. ${t.remote ? 'It runs on another machine, where Koloft' : 'Koloft'} can only type into it once its turn has ended and it shows no question.`
      )
    await d.press(tab, [text, '\r'])
    return `Typed into ${t.name}.`
  }

  const deliver = async (
    verb: string,
    t: Target,
    text: string,
    caller: Pick<AgentCaller, 'tabId' | 'session'>,
    fromAssist: boolean
  ): Promise<AgentReply> => {
    const route = messagingOf(t.backend, !!t.remote)
    const typed = route === 'typed'
    const line =
      route !== 'peerLine'
        ? undefined
        : crossSessionLine(d.modeOf(caller.tabId), text, `koloft-session-${++lined}`)
    if (line === null)
      return refused(
        `koloft session ${verb}: the message cannot hold the text </cross-session-message>.`,
        EXIT_USAGE
      )
    const busy = typed && t.tabId !== undefined && !(await d.ready(t.tabId, 0, true))
    const assist = fromAssist ? caller.session.sessionId : undefined
    if (t.tabId && !busy) {
      // CC§14
      const asking = fromAssist && d.asking(t.tabId)
      const sent = await sendNow(
        t,
        text,
        line,
        Date.now() + REPLY_INSIDE_THE_KOLOFT_SHIM_WAIT_MS,
        assist
      )
      return answered(asking ? `${sent} ${readsItAfterTheQuestion(t.name)}` : sent)
    }
    void sendNow(t, text, line, Date.now() + WAITS_FOR_A_CLOSED_OR_BUSY_TARGET_MS, assist).catch(
      (error: unknown) => d.undelivered(caller.tabId, t, errorText(error))
    )
    return answered(`Will deliver when ${t.name} is ready.`)
  }

  const turnEnded = (tabId: string, turn: Turn): void => {
    const owed = replyOwed.get(tabId)
    if (!owed) return
    const { owner, asked } = owed
    if (asked !== undefined && !turn.said.some((l) => l.text.includes(asked))) return
    replyOwed.delete(tabId)
    if (!turn.reply.trim()) return
    const parent = placedRows(d.sidebar(), d.allSessions()).find((p) => p.row.id === owner)
    const to = d.conductorOf(owner) ?? (parent && rowTarget(d, parent))
    if (!to) return
    const session = d.allSessions().find((s) => s.tabId === tabId)
    if (!session) return
    deliver('send', to, sessionSays(session, turn.reply), { tabId, session }, false)
      .then((reply) => reply.exit === 0 || d.undelivered(tabId, to, reply.text))
      .catch((error: unknown) => d.undelivered(tabId, to, errorText(error)))
  }

  const conductorAct = async (
    sub: string,
    rest: string[],
    caller: AgentCaller
  ): Promise<AgentReply> => {
    const takesWords = sub === 'send' || sub === 'answer' || sub === 'command' || sub === 'keys'
    const resume = splitAtDashes(rest)
    const rows = await rowsIn(d, d.conductorScope(caller.tabId))
    const split = takesWords
      ? nameThenWords(
          rest,
          (r) =>
            isMe(r, caller.session, d.conductorOf(r), caller.tabId) ||
            d.conductorOf(r) !== undefined ||
            namesARow(rows, r)
        )
      : wholeName(sub === 'resume' ? resume.before : rest)
    if (!split.ok) return refused(`koloft session ${sub}: ${split.error}`, EXIT_USAGE)
    const { ref, tail } = split.value
    const text = sub === 'resume' ? resume.after : tail.join(' ').trim()
    if (!ref || (takesWords && !text)) return refused(CONDUCTOR_ACT_USAGE[sub], EXIT_USAGE)
    if (sub === 'command') {
      const problem = slashCommandProblem(text)
      if (problem) return refused(`koloft session command: ${problem}`, EXIT_USAGE)
    }
    const self = isMe(ref, caller.session, d.conductorOf(ref), caller.tabId)
    if (self && sub === 'screen') return answered(formatScreen('you', await d.screen(caller.tabId)))
    if (self && sub === 'command') {
      const me = d.conductorOf(caller.session.sessionId)
      if (!me) return refused(`koloft session command: ${ONLY_A_CONDUCTOR}`)
      return answered(await d.command(caller.tabId, me, text))
    }
    if (self) return refused(`koloft session ${sub}: ${THAT_IS_YOU}`)
    const found = findAmong(rows, sub, ref)
    if (!found.ok) return refused(found.error)
    const t = rowTarget(d, found.value)
    if (sub === 'screen')
      return t.tabId
        ? answered(formatScreen(t.name, await d.screen(t.tabId)))
        : refused(`koloft session screen: ${t.name} is not open, so it has no screen.`)
    if (sub === 'stop') {
      if (!t.tabId) return refused(`koloft session stop: ${t.name} is not open.`)
      d.stop(t.tabId)
      return answered(`Closed ${t.name}. It stays in the list and can be resumed.`)
    }
    if (sub === 'keys' && !t.tabId) return refused(`koloft session keys: ${t.name} is not open.`)
    d.touch(caller.tabId, t.key)
    if (sub === 'command') return answered(await d.command(caller.tabId, t, text))
    if (sub === 'keys' && t.tabId) {
      const tab = t.tabId
      const owed = d.asking(tab) ? { owner: caller.session.sessionId } : undefined
      await owing(tab, owed, () => d.press(tab, keysFor(tail)))
      return answered(
        `Pressed ${text} in ${t.name}. See what it shows now with koloft session screen ${asArgument(ref)}.`
      )
    }
    if (sub === 'answer') {
      if (!t.tabId)
        return refused(`koloft session answer: ${t.name}: ${SHOWS_NOTHING_WHILE_CLOSED}`)
      const tab = t.tabId
      const error = await owing(
        tab,
        { owner: caller.session.sessionId },
        () => d.answer(tab, text),
        (e) => e !== undefined
      )
      return error
        ? refused(`koloft session answer: ${t.name}: ${error} ${seeAndPress(ref)}`)
        : answered(`Answered ${t.name}.`)
    }
    if (sub === 'resume' && !text) {
      if (t.tabId) return answered(`${t.name} is already open.`)
      await (opening.get(t.key) ?? t.open())
      return answered(`Resumed ${t.name}.`)
    }
    return deliver(sub, t, ownerSays(text), caller, true)
  }

  const verb: AgentVerb = async (args, caller): Promise<AgentReply> => {
    const [sub, ...rest] = args
    const ws = d.workspaceOf(caller.tabId)
    const sessionsIn = (workspace: string): SessionInfo[] =>
      d.allSessions().filter((s) => d.workspaceOf(s.tabId) === workspace)
    const scope = d.conductorScope(caller.tabId)
    if (sub === 'list' && scope !== undefined) {
      if (rest.length > 0) return refused(CONDUCTOR_LIST_USAGE, EXIT_USAGE)
      const everyRow = placedRows(d.sidebar(), d.allSessions())
      const placed = everyRow.filter((p) => inScope(scope, p.workspace))
      if (placed.length === 0) return answered('There are no sessions to look after.')
      return answered(
        rowLines(
          placed,
          await peerNamesOf(d, placed),
          placedStarters(d, everyRow, placed, caller.session),
          scope === GLOBAL_SCOPE,
          Date.now(),
          d.asking
        ).join('\n')
      )
    }
    if (sub === 'read') return readSession(d, rest, caller.tabId)
    if (sub === 'list') {
      const listsOther = rest.length === 2 && rest[0] === '--workspace'
      if (rest.length > 0 && !listsOther) return refused(LIST_USAGE, EXIT_USAGE)
      if (!listsOther)
        return ws ? listSessions(d, sessionsIn(ws), caller.session, ws) : refused(NO_WORKSPACE)
      const found = resolveWorkspace(rest[1], d.pinnedWorkspaces())
      if (!found.ok) return refused(`koloft session list: ${found.error}`)
      return listSessions(d, sessionsIn(found.value.path), caller.session, found.value.path)
    }
    if (sub === 'new') {
      const parsed = parseNewSessionArgs(rest)
      if (!parsed.ok) return refused(`koloft session new: ${parsed.error}`, EXIT_USAGE)
      const where = parsed.value.workspace
      const start = async (workspace: string, conductorTab?: string): Promise<AgentReply> => {
        const ownerWords = await ownerWordsOf(caller.session)
        return startSibling(
          d,
          parsed.value,
          caller.session,
          workspace,
          conductorTab,
          ownerWords,
          (tab) => replyOwed.set(tab, { owner: caller.session.sessionId })
        )
      }
      if (scope !== undefined) {
        if (scope === GLOBAL_SCOPE && where === undefined) return refused(GLOBAL_NEEDS_WORKSPACE)
        const target = startableWorkspace(where ?? scope, d.pinnedWorkspaces())
        if (!target.ok) return refused(`koloft session new: ${target.error}`)
        if (scope !== GLOBAL_SCOPE && target.value !== scope) return refused(ONLY_YOUR_WORKSPACE)
        return start(target.value, caller.tabId)
      }
      if (parsed.value.backend !== undefined) return refused(BACKEND_IS_FOR_CONDUCTORS, EXIT_USAGE)
      if (where === undefined) return ws ? start(ws) : refused(NO_WORKSPACE)
      const target = startableWorkspace(where, d.pinnedWorkspaces())
      if (!target.ok) return refused(`koloft session new: ${target.error}`)
      return start(target.value)
    }
    if (scope !== undefined && Object.hasOwn(CONDUCTOR_ACT_USAGE, sub))
      return conductorAct(sub, rest, caller)
    if (sub === 'send') {
      const open = d.allSessions()
      const parent = starterRow(d, caller, open)
      const starter = (ref: string): Target | undefined =>
        d.conductorOf(ref) ?? (parent && matchRow([parent], ref) ? rowTarget(d, parent) : undefined)
      const split = nameThenWords(
        rest,
        (ref) => starter(ref) !== undefined || matchOpen(open, ref) !== null
      )
      if (!split.ok) return refused(`koloft session send: ${split.error}`, EXIT_USAGE)
      const { ref, tail } = split.value
      const text = tail.join(' ').trim()
      if (!ref || !text) return refused(SEND_USAGE, EXIT_USAGE)
      const to = starter(ref)
      if (to) replyOwed.delete(caller.tabId)
      if (to) return deliver('send', to, sessionSays(caller.session, text), caller, false)
      const target = findSiblingTarget(open, ref, caller.session.backendId)
      if (!target.ok) return refused(`koloft session send: ${target.error}`)
      return deliver(
        'send',
        openTarget(target.value),
        sessionSays(caller.session, text),
        caller,
        false
      )
    }
    if (Object.hasOwn(CONDUCTOR_ACT_USAGE, sub))
      return refused(`koloft session ${sub}: ${ONLY_A_CONDUCTOR}`)
    if (sub === 'close') {
      const ref = rest.length > 0 ? rest.join(' ') : undefined
      let target: ClosableSession = caller.session
      if (ref !== undefined) {
        const mine = d.closable().filter((s) => d.startedSessions.startedBy(s, caller.session))
        let hit = await findClosable(mine, ref, d.peerNames())
        if (!hit.ok && scope !== undefined) hit = await endedInScope(d, ref, scope)
        if (!hit.ok) return refused(hit.error)
        target = hit.value
      }
      const left = await d.whatIsLeft(target)
      if (left.length > 0)
        return refused(
          `koloft session close: nothing was closed.\n\n${left.join('\n\n')}\n\nCommit and push every change, end any other session in that worktree, then run koloft session close again.`
        )
      d.closeSoon(target)
      return answered(
        target.tabId === caller.tabId
          ? 'Closing this session now: its tab, its row in the sidebar, and its git worktree and branch if it has one.'
          : `Closing "${target.title}" now: its tab if it is open, its row in the sidebar, and its git worktree and branch if it has one.`
      )
    }
    return refused(SESSION_USAGE, EXIT_USAGE)
  }

  return { verb, turnEnded }
}

export interface WorkspaceVerbDeps {
  conductorScope(tabId: string): string | undefined
  sidebar(): WorkspaceRows[]
}

export const ONLY_THE_GLOBAL_CONDUCTOR =
  'koloft workspace list: only the global Assist can list workspaces.'

export function workspaceVerb(d: WorkspaceVerbDeps): AgentVerb {
  return (args, caller) => {
    if (args.length !== 1 || args[0] !== 'list')
      return refused('koloft workspace: use list, like: koloft workspace list', EXIT_USAGE)
    if (d.conductorScope(caller.tabId) !== GLOBAL_SCOPE) return refused(ONLY_THE_GLOBAL_CONDUCTOR)
    const lines = d
      .sidebar()
      .map(({ workspace, rows }) =>
        [
          scopeName(workspace.path),
          workspaceLabel(workspace.path),
          `${rows.filter((r) => r.running).length} open`,
          ...(workspace.missing ? ['folder missing'] : [])
        ].join(' · ')
      )
    return answered(lines.join('\n') || "Koloft's sidebar has no workspaces.")
  }
}
