import fs from 'fs'
import { schemeOf } from '@shared/browserRoute'
import type { ArtifactView } from '@shared/types'
import { openDropTarget } from './openDrop'
import {
  answered,
  EXIT_USAGE,
  NOT_PINNED,
  refused,
  type AgentCaller,
  type AgentReply,
  type AgentVerbs
} from './agentRequests'

export interface WorkbenchVerbDeps {
  open(tabId: string, target: string, view?: ArtifactView): boolean
  notesFileOf(tabId: string): string | undefined
}

const OPEN_USAGE = 'koloft open: give one file or web address, like "koloft open docs/plan.md".'
const DIFF_USAGE = 'koloft diff: give one file, like "koloft diff src/app.ts".'
const NOTE_USAGE =
  'koloft note: run "koloft note" to read the note, or "koloft note append <text>" to add to it.'

export function noteAppendText(existing: string, text: string): string {
  const separator = existing && !existing.endsWith('\n') ? '\n' : ''
  return `${separator}${text}\n`
}

function show(
  d: WorkbenchVerbDeps,
  arg: string,
  caller: AgentCaller,
  view?: ArtifactView
): AgentReply {
  const target = openDropTarget(schemeOf(arg) ? { url: arg } : { path: arg, cwd: caller.cwd })
  if (!d.open(caller.tabId, target, view))
    return refused(`koloft: there is no file at ${target} that the Workbench can show.`)
  return answered(`Opened ${target} in this session's Workbench.`)
}

export function workbenchVerbs(d: WorkbenchVerbDeps): AgentVerbs {
  return {
    open: (args, caller) =>
      args.length === 1 ? show(d, args[0], caller) : refused(OPEN_USAGE, EXIT_USAGE),
    diff: (args, caller) =>
      args.length === 1 && !schemeOf(args[0])
        ? show(d, args[0], caller, 'diff')
        : refused(DIFF_USAGE, EXIT_USAGE),
    note: (args, caller) => {
      const [sub, ...words] = args
      const text = words.join(' ').trim()
      if (sub !== undefined && (sub !== 'append' || !text)) return refused(NOTE_USAGE, EXIT_USAGE)
      const file = d.notesFileOf(caller.tabId)
      if (!file) return refused(NOT_PINNED)
      const existing = fs.readFileSync(file, 'utf8')
      if (sub === undefined) return answered(existing || 'The workspace note is empty.')
      fs.appendFileSync(file, noteAppendText(existing, text))
      return answered('Added to the workspace note.')
    }
  }
}
