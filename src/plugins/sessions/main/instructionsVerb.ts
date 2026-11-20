import {
  answered,
  EXIT_USAGE,
  refused,
  splitAtDashes,
  type AgentCaller,
  type AgentReply,
  type AgentVerb
} from '@core/command'
import {
  ADD_A_LINE,
  REPLACE_THE_TEXT,
  cleanInstructions,
  editedText,
  type AgentEdit
} from '@core/ownerInstructions'
import type { SessionInfo } from '@shared/types'
import { resolveWorkspace, type PinnedWorkspace } from './placedRows'
import type { InstructionAsk, OwnersAnswer } from './instructionAsks'

export interface InstructionsBlock {
  name: string
  forEveryWorkspace?: true
  read(): Promise<string>
  check(text: string): Promise<void>
  writeIfStill(before: string, after: string, by: string): Promise<boolean>
}

export interface InstructionsVerbDeps {
  askTheOwner(ask: InstructionAsk, stillWaiting?: () => boolean): Promise<OwnersAnswer>
  overseerSide(tabId: string): boolean
  isOverseer(tabId: string): boolean
  overseerBlock(): InstructionsBlock
  workspaceOf(tabId: string): string | undefined
  pinnedWorkspaces(): PinnedWorkspace[]
  workspaceBlock(workspace: string): InstructionsBlock
  everyWorkspaceBlock(): InstructionsBlock
  nameOf(session: SessionInfo): string
}

const EVERY_WORKSPACE_FLAG = '--every-workspace'
const WHICH = `[--workspace <workspace> | ${EVERY_WORKSPACE_FLAG}]`
const USAGE = `koloft instructions: run it alone to read them, or: koloft instructions add ${WHICH} -- "<sentence>" | koloft instructions set ${WHICH} -- "<whole text>"`
const WORDS_AFTER_DASHES = (edit: AgentEdit): string =>
  edit === ADD_A_LINE
    ? 'koloft instructions add: put the sentence after --, like: koloft instructions add -- "Run npm test before you say a change is done."'
    : 'koloft instructions set: put the whole new text after --; an empty text clears them.'
export const ONLY_ITS_OWN_WORKSPACE =
  "koloft instructions: a session reads and changes only its own workspace's instructions."
export const A_HELPER_ONLY_PROPOSES_FOR_THE_BUTLER =
  "koloft instructions: a helper may propose changes only to the instructions of the session that started it (leave out --workspace); a project's instructions are changed by a session in that project's workspace."
const NO_WORKSPACE =
  'koloft instructions: this session is in no workspace of the sidebar, so it has no instructions to change.'

const NOT_CHANGED: Record<Exclude<OwnersAnswer, 'agreed'>, string> = {
  declined: 'koloft instructions: the owner did not agree, so nothing was changed.',
  timeout: 'koloft instructions: the owner did not answer in time, so nothing was changed.',
  closed:
    'koloft instructions: the command stopped waiting, or this session was closed, before the owner answered, so nothing was changed.'
}

const CHANGED_WHILE_ASKING =
  'koloft instructions: the instructions changed while the owner was asked, so nothing was changed. Read them again before you propose.'

type Target = { workspace?: string; everyWorkspace?: true }

function parsed(
  args: string[]
): ({ ok: true; edit?: AgentEdit; words: string } & Target) | { ok: false } {
  const { before, after } = splitAtDashes(args)
  const [first, ...rest] = before
  const edit = first === ADD_A_LINE || first === REPLACE_THE_TEXT ? first : undefined
  const flags = edit ? rest : before
  if (edit === undefined && args.includes('--')) return { ok: false }
  if (flags.length === 0) return { ok: true, edit, words: after }
  if (flags.length === 1 && flags[0] === EVERY_WORKSPACE_FLAG)
    return { ok: true, edit, everyWorkspace: true, words: after }
  if (flags.length === 2 && flags[0] === '--workspace')
    return { ok: true, edit, workspace: flags[1], words: after }
  return { ok: false }
}

function blockOf(
  d: InstructionsVerbDeps,
  caller: AgentCaller,
  { workspace: ref, everyWorkspace }: Target,
  editing: boolean
): { ok: true; block: InstructionsBlock } | { ok: false; reply: AgentReply } {
  if (everyWorkspace) return { ok: true, block: d.everyWorkspaceBlock() }
  const overseerSide = d.overseerSide(caller.tabId)
  if (ref === undefined) {
    if (overseerSide) return { ok: true, block: d.overseerBlock() }
    const own = d.workspaceOf(caller.tabId)
    return own
      ? { ok: true, block: d.workspaceBlock(own) }
      : { ok: false, reply: refused(NO_WORKSPACE) }
  }
  if (editing && overseerSide && !d.isOverseer(caller.tabId))
    return { ok: false, reply: refused(A_HELPER_ONLY_PROPOSES_FOR_THE_BUTLER) }
  const found = resolveWorkspace(ref, d.pinnedWorkspaces())
  if (!found.ok) return { ok: false, reply: refused(`koloft instructions: ${found.error}`) }
  if (!overseerSide && found.value.path !== d.workspaceOf(caller.tabId))
    return { ok: false, reply: refused(ONLY_ITS_OWN_WORKSPACE) }
  return { ok: true, block: d.workspaceBlock(found.value.path) }
}

const capitalized = (s: string): string => `${s[0].toUpperCase()}${s.slice(1)}`

const changedLine = (edit: AgentEdit, name: string): string =>
  `The owner agreed: ${edit === ADD_A_LINE ? 'added to' : 'replaced'} ${name}. Sessions started from now on follow it.`

// CC§27
export function instructionsVerb(d: InstructionsVerbDeps): AgentVerb {
  return async (args, caller) => {
    const p = parsed(args)
    if (!p.ok) return refused(USAGE, EXIT_USAGE)
    const target = blockOf(d, caller, p, p.edit !== undefined)
    if (!target.ok) return target.reply
    const { block } = target
    if (!p.edit) {
      const text = await block.read()
      return answered(text || `${capitalized(block.name)} are empty.`)
    }
    if (p.edit === ADD_A_LINE && !cleanInstructions(p.words))
      return refused(WORDS_AFTER_DASHES(p.edit), EXIT_USAGE)
    if (p.edit === REPLACE_THE_TEXT && !args.includes('--'))
      return refused(WORDS_AFTER_DASHES(p.edit), EXIT_USAGE)
    const before = await block.read()
    const after = editedText(before, p.edit, p.words)
    if (after === before)
      return answered(`${capitalized(block.name)} already say that; nothing changed.`)
    await block.check(after)
    const by = d.nameOf(caller.session)
    const given = await d.askTheOwner(
      {
        tabId: caller.tabId,
        by,
        what: block.name,
        before,
        after,
        forEveryWorkspace: block.forEveryWorkspace
      },
      caller.stillWaiting
    )
    if (given !== 'agreed') return refused(NOT_CHANGED[given])
    if (!(await block.writeIfStill(before, after, by))) return refused(CHANGED_WHILE_ASKING)
    return answered(changedLine(p.edit, block.name))
  }
}
