import type { Machine } from '../../../main/host/machine'
import { needsSignIn, problemOf, sshLinkBroke } from '../../../main/remote/ssh'
import { parseAnnotationTitle, type SummaryRow } from './agyStore'
import {
  AGY_HELD_ELSEWHERE_EXIT,
  AGY_SEND_SSH_OUTLASTS_THE_SCRIPT_MS,
  agyHeldCmd,
  agySendCmd,
  agyTitleCmd,
  listAgyCmd,
  parseAgyConfig,
  readAgyConfigCmd,
  type AgyMachineLaunch,
  type AgyMachinePlan,
  type RemoteAgyConfig
} from './agyTab'

export async function readAgyConfig(
  machine: Machine,
  account: string,
  saidWhenTheMachineWantsAPasswordFirst: string
): Promise<RemoteAgyConfig> {
  const r = await machine.run(readAgyConfigCmd(account))
  if (needsSignIn(r)) throw new Error(saidWhenTheMachineWantsAPasswordFirst)
  if (sshLinkBroke(r)) throw new Error(problemOf(r))
  return parseAgyConfig(r.stdout.toString('utf8'))
}

export async function agyHeldElsewhere(machine: Machine, conversationId: string): Promise<boolean> {
  return (await machine.run(agyHeldCmd(conversationId))).code === AGY_HELD_ELSEWHERE_EXIT
}

export async function agySend(
  machine: Machine,
  tmuxName: string,
  conversationId: string,
  text: string
): Promise<boolean> {
  const r = await machine.run(agySendCmd(tmuxName, conversationId), {
    input: Buffer.from(text),
    timeoutMs: AGY_SEND_SSH_OUTLASTS_THE_SCRIPT_MS
  })
  return r.code === 0
}

export async function agyConversationTitle(
  machine: Machine,
  conversationId: string
): Promise<string | undefined> {
  const r = await machine.run(agyTitleCmd(conversationId))
  if (r.code !== 0) return undefined
  const text = r.stdout.toString('utf8').trim()
  if (!text) return undefined
  try {
    const parsed = JSON.parse(text) as { title?: unknown; pbtxt?: unknown }
    if (typeof parsed.title === 'string' && parsed.title) return parsed.title
    if (typeof parsed.pbtxt === 'string' && parsed.pbtxt) return parseAnnotationTitle(parsed.pbtxt)
  } catch {}
  return undefined
}

export async function agyConversations(machine: Machine): Promise<SummaryRow[]> {
  const r = await machine.run(listAgyCmd(machine.packageName()))
  if (r.code !== 0) throw new Error(problemOf(r))
  const rows: unknown = JSON.parse(r.stdout.toString('utf8') || '[]')
  return Array.isArray(rows) ? (rows as SummaryRow[]) : []
}

export async function launchAgy(machine: Machine, spec: AgyMachineLaunch): Promise<AgyMachinePlan> {
  await machine.ready()
  const opened = await machine.tmux.open(
    spec.resumeId ? { session: spec.resumeId } : { tab: spec.tabId }
  )
  const attach = opened.mode === 'attach'
  const loginPath = attach ? '' : await opened.loginPath
  return {
    attach,
    tmuxName: opened.tmuxName,
    spawnCwd: opened.spawnCwd,
    shell: opened.shell,
    resized: opened.resized,
    launchCommand: () =>
      opened.launchCommand(spec.tabId, {
        cwd: machine.bare(spec.cwd),
        banner: '',
        env: spec.env,
        portOffset: spec.portOffset,
        loginPath,
        program: attach ? { ...spec.program, files: {} } : spec.program
      })
  }
}
