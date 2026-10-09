import type {
  BackendId,
  CreateTabOptions,
  SessionInfo,
  SessionRow,
  SessionStatus,
  WorkspaceRows
} from '@shared/types'
import { BACKEND_LABEL } from '@shared/sessionBackend'
import { isValidWorktreeName } from '@shared/worktreeName'
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
  refused,
  splitAtDashes,
  type AgentCaller,
  type AgentReply,
  type AgentVerb,
  type Parsed
} from './agentRequests'
import { AGENT_SHIM_WAITS_MS } from './agentShim'
import { crossSessionLine, type ModeClass } from './crossSessionMessage'
import { handoverPreamble, withHandover, type SessionCaller } from './handover'
import { nameForTask, type TitleModel } from './sessionTitle'
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
      if (value !== 'claude' && value !== 'codex') return fail('--backend is claude or codex.')
      flags.backend = value
    } else flags[key] = value
    i++
  }
  return fail(PROMPT_AFTER_DASHES)
}

const STATE_WORDS: Record<SessionStatus, string> = {
  working: 'working',
  approval: 'waiting for the owner',
  waiting: 'waiting for the owner',
  idle: 'idle'
}

export interface ListedSession {
  info: SessionInfo
  peerName?: string
}

export function formatSessionList(sessions: ListedSession[], callerTabId: string): string {
  if (sessions.length === 0) return 'This workspace has no open sessions.'
  return sessions
    .map(({ info, peerName }) => {
      const parts = [
        `${info.title}${info.tabId === callerTabId ? ' (you)' : ''}`,
        BACKEND_LABEL[info.backendId],
        STATE_WORDS[info.status ?? 'idle']
      ]
      if (info.backendId === 'codex') parts.push(`id: ${info.nativeSessionId ?? info.sessionId}`)
      if (peerName) parts.push(`name: ${peerName}`)
      const transcript = info.details?.claude?.jsonlPath
      if (transcript) parts.push(`transcript: ${transcript}`)
      return parts.join(' · ')
    })
    .join('\n')
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
  return Promise.all(
    placed.map((p) => (p.live?.backendId === 'claude' ? nameOf(p.live.sessionId) : null))
  )
}

function formatConductorList(
  placed: PlacedRow[],
  names: (string | null)[],
  withWorkspace: boolean,
  now: number
): string {
  if (placed.length === 0) return 'There are no sessions to look after.'
  return placed
    .map(({ workspace, row, title, live: info }, i) => {
      const parts = [
        title,
        BACKEND_LABEL[row.backendId],
        parseRemoteKey(workspace)?.host ?? 'local',
        info || row.running ? STATE_WORDS[info?.status ?? 'idle'] : 'closed',
        `last active ${ageLabel(row.mtime, now)}`,
        `id: ${row.nativeSessionId ?? row.id}`
      ]
      if (names[i]) parts.push(`name: ${names[i]}`)
      if (withWorkspace) parts.push(`workspace: ${workspaceLabel(workspace)}`)
      return parts.join(' · ')
    })
    .join('\n')
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

function resolveWorkspace(ref: string, pinned: PinnedWorkspace[]): Parsed<PinnedWorkspace> {
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
  'this is for Codex sessions. A Claude session talks to another Claude session with its SendMessage tool; ListAgents shows their names.'

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

export function findCodexTarget(sessions: SessionInfo[], ref: string): Parsed<SessionInfo> {
  const hit = matchRef(
    sessions,
    ref,
    (s) => s.nativeSessionId === ref || s.sessionId === ref || s.tabId === ref,
    (s) => s.title
  )
  if (!hit) return fail(`there is no open session "${ref}". Run "koloft session list" to see them.`)
  return !hit.ok || hit.value.backendId === 'codex' ? hit : fail(CLAUDE_USES_SEND_MESSAGE)
}

export interface ClosableSession {
  sessionId: string
  nativeSessionId?: string
  backendId: BackendId
  title: string
  treeRoot: string
  tabId?: string
}

const CLOSE_USAGE =
  'koloft session close: give nothing to close this session, or the id or name of one you started with koloft session new (a conductor: of an ended session it looks after), like: koloft session close <id or name>'

export async function findClosable(
  sessions: ClosableSession[],
  ref: string,
  nameOf: (sessionId: string) => Promise<string | null>
): Promise<Parsed<ClosableSession>> {
  const names = await Promise.all(
    sessions.map((s) => (s.backendId === 'claude' ? nameOf(s.sessionId) : null))
  )
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
      `koloft session close: you did not start a session "${ref}". You can close only this session or one you started with koloft session new.`
    )
  )
}

export interface SessionVerbDeps {
  workspaceOf(tabId: string): string | undefined
  allSessions(): SessionInfo[]
  pinnedWorkspaces(): PinnedWorkspace[]
  peerNames(): (sessionId: string) => Promise<string | null>
  launch(options: CreateTabOptions & { kind: BackendId }): Promise<string | null>
  titleModel: TitleModel
  queue(tabId: string, text: string, clientId?: string): Promise<void>
  startedSessions: StartedSessions
  closable(): ClosableSession[]
  whatIsLeft(target: ClosableSession): Promise<string[]>
  closeSoon(target: ClosableSession): void
  conductorScope(tabId: string): string | undefined
  sidebar(): WorkspaceRows[]
  readTurns(key: string, n: number): Promise<Turn[]>
  touch(tabId: string, key: string): void
  conductorOf(ref: string): Target | undefined
  resume(row: SessionRow): Promise<string>
  ready(tabId: string, ms: number, turnEnded: boolean): Promise<boolean>
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
  bindingId?: string
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
const CODEX_HAS_NO_NAME =
  'koloft session new: a Codex session has no name, so leave out --name. Koloft prints an id to reach it by.'

async function listSessions(
  d: SessionVerbDeps,
  sessions: SessionInfo[],
  callerTabId: string
): Promise<AgentReply> {
  const peerName = d.peerNames()
  const listed = await Promise.all(
    sessions.map(async (info) => ({
      info,
      peerName:
        info.backendId === 'claude' ? ((await peerName(info.sessionId)) ?? undefined) : undefined
    }))
  )
  return answered(formatSessionList(listed, callerTabId))
}

async function startSibling(
  d: SessionVerbDeps,
  args: NewSessionArgs,
  me: SessionInfo,
  workspace: string,
  conductorTab?: string
): Promise<AgentReply> {
  const backend = args.backend ?? me.backendId
  if (backend === 'codex' && args.name !== undefined) return refused(CODEX_HAS_NO_NAME, EXIT_USAGE)
  const caller: SessionCaller = {
    name: me.backendId === 'claude' ? ((await d.peerNames()(me.sessionId)) ?? me.title) : undefined,
    id: me.nativeSessionId ?? me.sessionId
  }
  const name =
    backend === 'claude'
      ? (args.name ??
        (await nameForTask(
          args.prompt,
          d.titleModel,
          new Set(d.allSessions().map((s) => s.title))
        )))
      : undefined
  const tabId = await d.launch({
    kind: backend,
    cwd: workspace,
    name,
    worktree: args.worktree,
    model: args.model,
    // ADR-0028
    permission: conductorTab && d.modeOf(conductorTab) === 'bypass' ? 'bypass' : 'default',
    // CODEX§17
    ...(backend === 'codex'
      ? { role: handoverPreamble(caller, backend), firstPrompt: args.prompt }
      : { firstPrompt: withHandover(caller, backend, args.prompt) })
  })
  if (!tabId) return refused('koloft session new: Koloft could not start the session.')
  d.startedSessions.started(tabId, me.sessionId)
  if (conductorTab) {
    d.started(conductorTab, tabId, name ?? 'a Codex session', workspace, backend)
    return answered(
      `Started ${name ? `session "${name}"` : 'a Codex session'} in a new tab. "koloft session list" shows its id once it starts; reach it with koloft session send.`
    )
  }
  const listHint =
    args.workspace === undefined
      ? 'koloft session list'
      : `koloft session list --workspace ${JSON.stringify(workspace)}`
  return answered(
    name
      ? `Started session "${name}" in a new tab. Talk to it with SendMessage to "${name}".`
      : `Started a Codex session in a new tab: ${tabId}. Its id shows in "${listHint}" once it starts; "koloft session send ${tabId} <message>" also reaches it.`
  )
}

function parseReadArgs(rest: string[]): Parsed<{ ref: string; last: number }> {
  const [ref, flag, value, ...extra] = rest
  if (!ref || extra.length > 0) return fail(READ_USAGE)
  if (flag === undefined) return { ok: true, value: { ref, last: 1 } }
  const last = Number(value)
  if (flag !== '--last' || !Number.isInteger(last) || last < 1 || last > MAX_READ_TURNS)
    return fail(READ_USAGE)
  return { ok: true, value: { ref, last } }
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

async function findIn(
  d: SessionVerbDeps,
  verb: string,
  ref: string,
  scope: string | undefined
): Promise<Parsed<PlacedRow>> {
  const all = placedRows(d.sidebar(), d.allSessions())
  const mine = all.filter((p) => inScope(scope, p.workspace))
  const names = await peerNamesOf(d, mine)
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
const ONLY_A_CONDUCTOR = 'only a conductor (a session bound to a Discord channel) can do this.'
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
const BACKEND_IS_FOR_CONDUCTORS = 'koloft session new: only a conductor can pick --backend.'
const GLOBAL_NEEDS_WORKSPACE =
  'koloft session new: say which workspace with --workspace <workspace>; "koloft workspace list" shows them.'
const ONLY_YOUR_WORKSPACE = 'koloft session new: you can only start sessions in your own workspace.'

const COMMAND_USAGE = `koloft session command: give an id or name (or "me" for yourself), then one slash command, like: koloft session command fix-login /compact`
const SCREEN_USAGE = `koloft session screen: give an id or name (or "me" for yourself), like: koloft session screen fix-login`
const KEYS_USAGE = `koloft session keys: give an id or name, then the keys to press in order, like: koloft session keys fix-login Down Enter`

function seeAndPress(ref: string): string {
  return `To answer it anyway, see what it shows with koloft session screen ${ref}, then press the keys with koloft session keys ${ref} <keys>.`
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
  const lines = [...screen.lines]
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop()
  while (lines.length && !lines[0].trim()) lines.shift()
  const shown = lines.length ? `\`\`\`\n${lines.join('\n')}\n\`\`\`` : '(the screen is empty)'
  return [`The screen of ${name} right now:`, shown, ...screen.notes].join('\n')
}

export function ownerSays(text: string): string {
  return `(Your owner, via the Koloft conductor:) ${text}`
}

function isMe(
  ref: string,
  me: SessionInfo,
  mine: Target | undefined,
  callerTabId: string
): boolean {
  return mine?.tabId === callerTabId || [me.sessionId, me.nativeSessionId, me.title].includes(ref)
}

export function sessionVerb(d: SessionVerbDeps): AgentVerb {
  const opening = new Map<string, Promise<string | null>>()
  let queued = 0

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
    until: number
  ): Promise<string> => {
    const tab = t.tabId ?? (await openReady(t, until))
    if (!tab) throw new Error(`${t.name} was resumed but did not get ready in time.`)
    if (t.backend === 'codex') {
      await d.queue(tab, text, `koloft-conductor-${++queued}`)
      return `Sent to ${t.name}.`
    }
    if (line) {
      await d.sendLine(tab, line, until - Date.now())
      return `Sent to ${t.name}.`
    }
    if (!(await d.ready(tab, until - Date.now(), true)))
      throw new Error(
        `${t.name} stayed busy. It runs on another machine, where Koloft can only type into it once its turn has ended and it shows no question.`
      )
    await d.press(tab, [text, '\r'])
    return `Typed into ${t.name}.`
  }

  const deliver = async (
    verb: string,
    t: Target,
    text: string,
    caller: AgentCaller
  ): Promise<AgentReply> => {
    const typed = t.backend === 'claude' && t.remote
    const line =
      typed || t.backend === 'codex' ? undefined : crossSessionLine(d.modeOf(caller.tabId), text)
    if (line === null)
      return refused(
        `koloft session ${verb}: the message cannot hold the text </cross-session-message>.`,
        EXIT_USAGE
      )
    const busy = typed && t.tabId !== undefined && !(await d.ready(t.tabId, 0, true))
    if (t.tabId && !busy)
      return answered(
        await sendNow(t, text, line, Date.now() + REPLY_INSIDE_THE_KOLOFT_SHIM_WAIT_MS)
      )
    void sendNow(t, text, line, Date.now() + WAITS_FOR_A_CLOSED_OR_BUSY_TARGET_MS).catch(
      (error: unknown) => d.undelivered(caller.tabId, t, errorText(error))
    )
    return answered(`Will deliver when ${t.name} is ready.`)
  }

  const conductorAct = async (
    sub: string,
    rest: string[],
    caller: AgentCaller
  ): Promise<AgentReply> => {
    const [ref, ...tail] = rest
    const resume = splitAtDashes(tail)
    const text = sub === 'resume' ? resume.after : tail.join(' ').trim()
    const extra = sub === 'resume' ? resume.before : tail
    const takesWords = sub === 'send' || sub === 'answer' || sub === 'command' || sub === 'keys'
    if (!ref || (takesWords && !text) || (!takesWords && extra.length > 0))
      return refused(CONDUCTOR_ACT_USAGE[sub], EXIT_USAGE)
    if (sub === 'command') {
      const problem = slashCommandProblem(text)
      if (problem) return refused(`koloft session command: ${problem}`, EXIT_USAGE)
    }
    const self = ref === MYSELF || isMe(ref, caller.session, d.conductorOf(ref), caller.tabId)
    if (self && sub === 'screen') return answered(formatScreen('you', await d.screen(caller.tabId)))
    if (self && sub === 'command') {
      const me = d.conductorOf(caller.session.sessionId)
      if (!me) return refused(`koloft session command: ${ONLY_A_CONDUCTOR}`)
      return answered(await d.command(caller.tabId, me, text))
    }
    if (self) return refused(`koloft session ${sub}: ${THAT_IS_YOU}`)
    const found = await findInScope(d, sub, ref, caller.tabId)
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
      await d.press(t.tabId, keysFor(tail))
      return answered(
        `Pressed ${text} in ${t.name}. See what it shows now with koloft session screen ${ref}.`
      )
    }
    if (sub === 'answer') {
      if (!t.tabId)
        return refused(`koloft session answer: ${t.name}: ${SHOWS_NOTHING_WHILE_CLOSED}`)
      const error = await d.answer(t.tabId, text)
      return error
        ? refused(`koloft session answer: ${t.name}: ${error} ${seeAndPress(ref)}`)
        : answered(`Answered ${t.name}.`)
    }
    if (sub === 'resume' && !text) {
      if (t.tabId) return answered(`${t.name} is already open.`)
      await (opening.get(t.key) ?? t.open())
      return answered(`Resumed ${t.name}.`)
    }
    return deliver(sub, t, ownerSays(text), caller)
  }

  return async (args, caller): Promise<AgentReply> => {
    const [sub, ...rest] = args
    const ws = d.workspaceOf(caller.tabId)
    const sessionsIn = (workspace: string): SessionInfo[] =>
      d.allSessions().filter((s) => d.workspaceOf(s.tabId) === workspace)
    const scope = d.conductorScope(caller.tabId)
    if (sub === 'list' && scope !== undefined) {
      if (rest.length > 0) return refused(CONDUCTOR_LIST_USAGE, EXIT_USAGE)
      const placed = placedRows(d.sidebar(), d.allSessions()).filter((p) =>
        inScope(scope, p.workspace)
      )
      return answered(
        formatConductorList(
          placed,
          await peerNamesOf(d, placed),
          scope === GLOBAL_SCOPE,
          Date.now()
        )
      )
    }
    if (sub === 'read') return readSession(d, rest, caller.tabId)
    if (sub === 'list') {
      const listsOther = rest.length === 2 && rest[0] === '--workspace'
      if (rest.length > 0 && !listsOther) return refused(LIST_USAGE, EXIT_USAGE)
      if (!listsOther)
        return ws ? listSessions(d, sessionsIn(ws), caller.tabId) : refused(NO_WORKSPACE)
      const found = resolveWorkspace(rest[1], d.pinnedWorkspaces())
      if (!found.ok) return refused(`koloft session list: ${found.error}`)
      return listSessions(d, sessionsIn(found.value.path), caller.tabId)
    }
    if (sub === 'new') {
      const parsed = parseNewSessionArgs(rest)
      if (!parsed.ok) return refused(`koloft session new: ${parsed.error}`, EXIT_USAGE)
      const where = parsed.value.workspace
      if (scope !== undefined) {
        if (scope === GLOBAL_SCOPE && where === undefined) return refused(GLOBAL_NEEDS_WORKSPACE)
        const target = startableWorkspace(where ?? scope, d.pinnedWorkspaces())
        if (!target.ok) return refused(`koloft session new: ${target.error}`)
        if (scope !== GLOBAL_SCOPE && target.value !== scope) return refused(ONLY_YOUR_WORKSPACE)
        return startSibling(d, parsed.value, caller.session, target.value, caller.tabId)
      }
      if (parsed.value.backend !== undefined) return refused(BACKEND_IS_FOR_CONDUCTORS, EXIT_USAGE)
      if (where === undefined)
        return ws ? startSibling(d, parsed.value, caller.session, ws) : refused(NO_WORKSPACE)
      const target = startableWorkspace(where, d.pinnedWorkspaces())
      if (!target.ok) return refused(`koloft session new: ${target.error}`)
      return startSibling(d, parsed.value, caller.session, target.value)
    }
    if (scope !== undefined && Object.hasOwn(CONDUCTOR_ACT_USAGE, sub))
      return conductorAct(sub, rest, caller)
    if (sub === 'send') {
      const [ref, ...words] = rest
      const text = words.join(' ').trim()
      if (!ref || !text) return refused(SEND_USAGE, EXIT_USAGE)
      const conductor = d.conductorOf(ref)
      if (conductor) return deliver('send', conductor, text, caller)
      if (caller.session.backendId !== 'codex')
        return refused(`koloft session send: ${CLAUDE_USES_SEND_MESSAGE}`)
      const target = findCodexTarget(d.allSessions(), ref)
      if (!target.ok) return refused(`koloft session send: ${target.error}`)
      await d.queue(target.value.tabId, text)
      return answered(`Sent to ${target.value.title}.`)
    }
    if (Object.hasOwn(CONDUCTOR_ACT_USAGE, sub))
      return refused(`koloft session ${sub}: ${ONLY_A_CONDUCTOR}`)
    if (sub === 'close') {
      if (rest.length > 1) return refused(CLOSE_USAGE, EXIT_USAGE)
      const [ref] = rest
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
}

export interface WorkspaceVerbDeps {
  conductorScope(tabId: string): string | undefined
  sidebar(): WorkspaceRows[]
}

export const ONLY_THE_GLOBAL_CONDUCTOR =
  'koloft workspace list: only the global conductor can list workspaces.'

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
