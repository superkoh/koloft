import {
  answered,
  EXIT_USAGE,
  refused,
  splitAtDashes,
  type AgentCaller,
  type AgentReply,
  type AgentVerb
} from '@core/command'
import { ADD_A_LINE, REPLACE_THE_TEXT, editedText, type AgentEdit } from '@core/ownerInstructions'
import { resolveWorkspace, type PinnedWorkspace } from './placedRows'

export interface InstructionsBlock {
  name: string
  workspace?: string
  changedBy(by: string): string
  read(): Promise<string>
  write(edit: (current: string) => string, by: string): Promise<boolean>
}

export interface InstructionsChanged {
  workspace?: string
  by: string
  notice: string
}

export interface InstructionsVerbDeps {
  changed(c: InstructionsChanged): Promise<string[]>
  overseerSide(tabId: string): boolean
  overseerBlock(): InstructionsBlock
  workspaceOf(tabId: string): string | undefined
  pinnedWorkspaces(): PinnedWorkspace[]
  workspaceBlock(workspace: string): InstructionsBlock
}

const USAGE =
  'koloft instructions: run it alone to read them, or: koloft instructions add [--workspace <workspace>] -- "<sentence>" | koloft instructions set [--workspace <workspace>] -- "<whole text>"'
const WORDS_AFTER_DASHES = (edit: AgentEdit): string =>
  edit === ADD_A_LINE
    ? 'koloft instructions add: put the sentence after --, like: koloft instructions add -- "Run npm test before you say a change is done."'
    : 'koloft instructions set: put the whole new text after --; an empty text clears them.'
export const ONLY_ITS_OWN_WORKSPACE =
  "koloft instructions: a session reads and changes only its own workspace's instructions."
const NO_WORKSPACE =
  'koloft instructions: this session is in no workspace of the sidebar, so it has no instructions to change.'

function parsed(
  args: string[]
): { ok: true; edit?: AgentEdit; workspace?: string; words: string } | { ok: false } {
  const { before, after } = splitAtDashes(args)
  const [first, ...rest] = before
  const edit = first === ADD_A_LINE || first === REPLACE_THE_TEXT ? first : undefined
  const flags = edit ? rest : before
  if (edit === undefined && args.includes('--')) return { ok: false }
  if (flags.length === 0) return { ok: true, edit, words: after }
  if (flags.length === 2 && flags[0] === '--workspace')
    return { ok: true, edit, workspace: flags[1], words: after }
  return { ok: false }
}

function blockOf(
  d: InstructionsVerbDeps,
  caller: AgentCaller,
  ref: string | undefined
): { ok: true; block: InstructionsBlock } | { ok: false; reply: AgentReply } {
  const overseer = d.overseerSide(caller.tabId)
  if (ref === undefined) {
    if (overseer) return { ok: true, block: d.overseerBlock() }
    const own = d.workspaceOf(caller.tabId)
    return own
      ? { ok: true, block: d.workspaceBlock(own) }
      : { ok: false, reply: refused(NO_WORKSPACE) }
  }
  const found = resolveWorkspace(ref, d.pinnedWorkspaces())
  if (!found.ok) return { ok: false, reply: refused(`koloft instructions: ${found.error}`) }
  if (!overseer && found.value.path !== d.workspaceOf(caller.tabId))
    return { ok: false, reply: refused(ONLY_ITS_OWN_WORKSPACE) }
  return { ok: true, block: d.workspaceBlock(found.value.path) }
}

const capitalized = (s: string): string => `${s[0].toUpperCase()}${s.slice(1)}`

const changedLine = (edit: AgentEdit, name: string): string =>
  `${edit === ADD_A_LINE ? 'Added to' : 'Replaced'} ${name}. The owner is shown the change and can undo it.`

// CC§27
export function instructionsVerb(d: InstructionsVerbDeps): AgentVerb {
  return async (args, caller) => {
    const p = parsed(args)
    if (!p.ok) return refused(USAGE, EXIT_USAGE)
    const target = blockOf(d, caller, p.workspace)
    if (!target.ok) return target.reply
    const { block } = target
    if (!p.edit) {
      const text = await block.read()
      return answered(text || `${capitalized(block.name)} are empty.`)
    }
    if (p.edit === ADD_A_LINE && !p.words) return refused(WORDS_AFTER_DASHES(p.edit), EXIT_USAGE)
    if (p.edit === REPLACE_THE_TEXT && !args.includes('--'))
      return refused(WORDS_AFTER_DASHES(p.edit), EXIT_USAGE)
    const edit = p.edit
    const by = caller.session.title
    if (!(await block.write((current) => editedText(current, edit, p.words), by)))
      return answered(`${capitalized(block.name)} already say that; nothing changed.`)
    const notes = await d.changed({ workspace: block.workspace, by, notice: block.changedBy(by) })
    return answered([changedLine(edit, block.name), ...notes].join('\n'))
  }
}
