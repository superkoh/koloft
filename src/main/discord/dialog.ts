import type { AskPayload } from '@shared/sessionEvent'
import { fail, type Parsed } from '../agentRequests'
import type { ToolCall } from '../sessionTracker'

interface Option {
  label: string
  description?: string
}

export interface Question {
  question: string
  options: Option[]
}

export interface CodexApproval {
  id: string | number
  command?: string
  reason?: string
}

export interface CodexQuestion extends Question {
  id: string | number
}

const YES = /^(y|yes|ok|okay|approve|1)[.!]?$/i
const NO = /^(n|no|deny|3)[.!]?$/i
const REFUSAL = /^(no|deny)\b/i

function questionsOf(p: AskPayload): Question[] {
  const raw = p.tool_input?.questions
  if (!Array.isArray(raw)) return []
  return raw.flatMap((q) => {
    const r = q as { question?: unknown; options?: unknown }
    if (typeof r.question !== 'string') return []
    return [{ question: r.question, options: labelsOf(r.options) }]
  })
}

export function questionText(q: Question): string {
  const options = q.options.map(
    (o, i) => `${i + 1}. ${o.label}${o.description ? ` — ${o.description}` : ''}`
  )
  return [q.question, ...options].join('\n')
}

function planOf(p: AskPayload): string | undefined {
  const plan = p.tool_input?.plan
  return typeof plan === 'string' ? plan : undefined
}

function toolText(p: AskPayload): string {
  const command = p.tool_input?.command
  return typeof command === 'string'
    ? `${p.tool_name} asks to run:\n${command}`
    : `${p.tool_name ?? 'A tool'} asks to run:\n${JSON.stringify(p.tool_input ?? {})}`
}

export function dialogText(p: AskPayload): string {
  if (p.tool_name === 'AskUserQuestion') return questionsOf(p).map(questionText).join('\n\n')
  const plan = planOf(p)
  return plan === undefined ? toolText(p) : `Approve this plan?\n\n${plan}`
}

export function askText(p: AskPayload): string {
  if (p.tool_name === 'AskUserQuestion') {
    const qs = questionsOf(p)
    const how =
      qs.length > 1
        ? 'Reply with one line per question: a number or your own answer.'
        : 'Reply with a number or your own answer.'
    return [...qs.map((q) => `❓ ${questionText(q)}`), how].join('\n\n')
  }
  const how =
    planOf(p) === undefined ? 'Reply yes or no.' : 'Reply yes to approve, or say what to change.'
  return `❓ ${dialogText(p)}\n\n${how}`
}

function answerOf(q: Question, line: string): string {
  const picks = line.split(/\s*,\s*/)
  const labels = picks.map((x) => (/^\d+$/.test(x) ? q.options[Number(x) - 1]?.label : undefined))
  return labels.every((l) => l !== undefined) ? labels.join(', ') : line
}

// CC§14
export function isAskedCall(p: AskPayload, call: ToolCall): boolean {
  const asked = p.tool_input ?? {}
  return (
    p.tool_name === call.name &&
    Object.entries(call.input).every(([k, v]) => JSON.stringify(asked[k]) === JSON.stringify(v))
  )
}

function decision(d: Record<string, unknown>): Record<string, unknown> {
  return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: d } }
}

// CC§14
export function hookAnswer(p: AskPayload, reply: string): Record<string, unknown> {
  const text = reply.trim()
  const input = p.tool_input ?? {}
  if (p.tool_name === 'AskUserQuestion') {
    const qs = questionsOf(p)
    const lines = text
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
    const isLabel = qs.some((q) =>
      q.options.some((o) => o.label.toLowerCase() === lines[0]?.toLowerCase())
    )
    if (REFUSAL.test(text) && !isLabel) return decision({ behavior: 'deny', message: text })
    const answers = Object.fromEntries(
      qs.map((q, i) => [q.question, answerOf(q, lines[Math.min(i, lines.length - 1)] ?? text)])
    )
    return decision({ behavior: 'allow', updatedInput: { ...input, answers } })
  }
  if (YES.test(text)) return decision({ behavior: 'allow', updatedInput: input })
  return decision({ behavior: 'deny', message: text })
}

const ESC = '\x1b'
const ONE_QUESTION_BY_KEYS =
  'on another machine Koloft can only answer a dialog with one question that takes one option. Answer this one at the Mac.'
const YES_OR_NO_BY_KEYS = 'on another machine Koloft can only answer yes or no to this dialog.'

// CC§14
export function claudeKeysFor(p: AskPayload, reply: string): Parsed<string[]> {
  const text = reply.trim()
  if (p.tool_name === 'AskUserQuestion') {
    const qs = questionsOf(p)
    const raw = p.tool_input?.questions as { multiSelect?: unknown }[]
    if (qs.length !== 1 || raw[0]?.multiSelect === true) return fail(ONE_QUESTION_BY_KEYS)
    const options = qs[0].options.length
    const pick = /^\d+$/.test(text) ? Number(text) : 0
    if (pick >= 1 && pick <= options) return { ok: true, value: [String(pick)] }
    return { ok: true, value: [String(options + 1), text, '\r'] }
  }
  if (YES.test(text)) return { ok: true, value: ['1'] }
  if (NO.test(text)) return { ok: true, value: [ESC] }
  return fail(YES_OR_NO_BY_KEYS)
}

export function approvalDetail(a: CodexApproval): string | undefined {
  if (!a.command) return a.reason
  return a.reason ? `${a.command} (${a.reason})` : a.command
}

export function codexApprovalText(a: CodexApproval): string {
  return `❓ Codex asks to run: ${approvalDetail(a) ?? 'a command'}\nReply yes or no.`
}

// CODEX§3
export function codexKeyFor(reply: string): string | undefined {
  const text = reply.trim()
  if (YES.test(text)) return 'y'
  if (NO.test(text)) return ESC
  return undefined
}

function labelsOf(raw: unknown): Option[] {
  return (Array.isArray(raw) ? raw : []).flatMap((o) => {
    const x = (o ?? {}) as { label?: unknown; description?: unknown }
    if (typeof o === 'string') return [{ label: o }]
    return typeof x.label === 'string'
      ? [
          {
            label: x.label,
            ...(typeof x.description === 'string' ? { description: x.description } : {})
          }
        ]
      : []
  })
}

// CODEX§20
export function codexQuestionOf(method: string, p: Record<string, unknown>): Question | undefined {
  if (method === 'item/tool/requestUserInput') {
    const qs = Array.isArray(p.questions) ? p.questions : []
    const q = (qs[0] ?? {}) as { question?: unknown; options?: unknown }
    const options = labelsOf(q.options)
    return qs.length === 1 && typeof q.question === 'string' && options.length
      ? { question: q.question, options }
      : undefined
  }
  if (method !== 'mcpServer/elicitation/request' || p.mode !== 'form') return undefined
  const schema = (p.requestedSchema ?? {}) as { properties?: Record<string, { enum?: unknown }> }
  const fields = Object.values(schema.properties ?? {})
  const options = labelsOf(fields[0]?.enum)
  return fields.length === 1 && typeof p.message === 'string' && options.length
    ? { question: p.message, options }
    : undefined
}

// CODEX§20
export function codexOptionKey(q: Question, reply: string): string | undefined {
  const text = reply.trim()
  const pick = /^\d+$/.test(text)
    ? Number(text)
    : q.options.findIndex((o) => o.label.toLowerCase() === text.toLowerCase()) + 1
  return pick >= 1 && pick <= q.options.length ? String(pick) : undefined
}
