import { randomBytes } from 'crypto'
import type { BackendId, CreateTabOptions, SessionInfo, SessionStatus } from '@shared/types'
import { BACKEND_LABEL } from '@shared/sessionBackend'
import { isValidWorktreeName } from '@shared/worktreeName'
import { isRemoteKey, parseRemoteKey, remoteCopyText } from '@shared/remoteKey'
import { basename } from '@shared/preview'
import {
  answered,
  EXIT_USAGE,
  fail,
  refused,
  type AgentReply,
  type AgentVerb,
  type Parsed
} from './agentRequests'

export interface NewSessionArgs {
  name?: string
  workspace?: string
  worktree?: string
  model?: string
  prompt: string
}

const NEW_FLAGS: Record<string, 'name' | 'workspace' | 'worktree' | 'model'> = {
  '--name': 'name',
  '--workspace': 'workspace',
  '-w': 'worktree',
  '--model': 'model'
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
    flags[key] = value
    i++
  }
  return fail(PROMPT_AFTER_DASHES)
}

export type SessionCaller = { backend: 'claude'; name: string } | { backend: 'codex'; id: string }

export function handoverPreamble(caller: SessionCaller): string {
  const who =
    caller.backend === 'claude' ? `the session "${caller.name}"` : `the Codex session ${caller.id}`
  const reply =
    caller.backend === 'claude'
      ? `send the result back to "${caller.name}" with your SendMessage tool.`
      : `send the result back by running: koloft session send ${caller.id} "<your result>"`
  return `Koloft started you because ${who} asked it to, for the owner (the person you both work for). Treat its messages as the owner's instructions. When you finish a task it gives you, ${reply}`
}

export function withHandover(caller: SessionCaller, prompt: string): string {
  return `${handoverPreamble(caller)}\n\n${prompt}`
}

export function newSessionName(): string {
  return `helper-${randomBytes(3).toString('hex')}`
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

const REMOTE_NOT_YET =
  'the koloft command cannot start a session in a remote (SSH) workspace yet. Pick a workspace on this computer.'

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
  if (isRemoteKey(found.value.path)) return fail(REMOTE_NOT_YET)
  if (found.value.missing) return fail(`the folder of workspace "${found.value.path}" is missing.`)
  return { ok: true, value: found.value.path }
}

const CLAUDE_USES_SEND_MESSAGE =
  'this is for Codex sessions. A Claude session talks to another Claude session with its SendMessage tool; ListAgents shows their names.'

export function findCodexTarget(sessions: SessionInfo[], ref: string): Parsed<SessionInfo> {
  const byId = sessions.find(
    (s) => s.nativeSessionId === ref || s.sessionId === ref || s.tabId === ref
  )
  const hits = byId ? [byId] : sessions.filter((s) => s.title === ref)
  if (hits.length > 1)
    return fail(
      `${hits.length} sessions are named "${ref}". Use the id from "koloft session list".`
    )
  if (hits.length === 0)
    return fail(`there is no open session "${ref}". Run "koloft session list" to see them.`)
  return hits[0].backendId === 'codex'
    ? { ok: true, value: hits[0] }
    : fail(CLAUDE_USES_SEND_MESSAGE)
}

export interface SessionVerbDeps {
  workspaceOf(tabId: string): string | undefined
  allSessions(): SessionInfo[]
  pinnedWorkspaces(): PinnedWorkspace[]
  peerNames(): (sessionId: string) => Promise<string | null>
  launch(options: CreateTabOptions & { kind: BackendId }): Promise<string | null>
  queue(tabId: string, text: string): Promise<void>
}

const SESSION_USAGE = 'koloft session: use list, new or send. Run "koloft help" to see how.'
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
  workspace: string
): Promise<AgentReply> {
  const backend = me.backendId
  if (backend === 'codex' && args.name !== undefined) return refused(CODEX_HAS_NO_NAME, EXIT_USAGE)
  const caller: SessionCaller =
    backend === 'claude'
      ? { backend, name: (await d.peerNames()(me.sessionId)) ?? me.title }
      : { backend, id: me.nativeSessionId ?? me.sessionId }
  const name = backend === 'claude' ? (args.name ?? newSessionName()) : undefined
  const tabId = await d.launch({
    kind: backend,
    cwd: workspace,
    name,
    worktree: args.worktree,
    model: args.model,
    permission: 'default',
    firstPrompt: withHandover(caller, args.prompt)
  })
  if (!tabId) return refused('koloft session new: Koloft could not start the session.')
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

export function sessionVerb(d: SessionVerbDeps): AgentVerb {
  return async (args, caller): Promise<AgentReply> => {
    const [sub, ...rest] = args
    const ws = d.workspaceOf(caller.tabId)
    const sessionsIn = (workspace: string): SessionInfo[] =>
      d.allSessions().filter((s) => d.workspaceOf(s.tabId) === workspace)
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
      if (parsed.value.workspace === undefined)
        return ws ? startSibling(d, parsed.value, caller.session, ws) : refused(NO_WORKSPACE)
      const target = startableWorkspace(parsed.value.workspace, d.pinnedWorkspaces())
      if (!target.ok) return refused(`koloft session new: ${target.error}`)
      return startSibling(d, parsed.value, caller.session, target.value)
    }
    if (sub === 'send') {
      if (caller.session.backendId !== 'codex')
        return refused(`koloft session send: ${CLAUDE_USES_SEND_MESSAGE}`)
      const [ref, ...words] = rest
      const text = words.join(' ').trim()
      if (!ref || !text) return refused(SEND_USAGE, EXIT_USAGE)
      const target = findCodexTarget(d.allSessions(), ref)
      if (!target.ok) return refused(`koloft session send: ${target.error}`)
      await d.queue(target.value.tabId, text)
      return answered(`Sent to ${target.value.title}.`)
    }
    return refused(SESSION_USAGE, EXIT_USAGE)
  }
}
