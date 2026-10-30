import { isDeepStrictEqual } from 'util'
import type { AskPayload } from '@shared/sessionEvent'
import type { BackendId } from '@shared/types'
import { fail, type Parsed } from '../agentRequests'
import type { ToolCall } from '../sessionTracker'
import { keysFor, typedPieces } from '../typeKeys'
import type { CardButton } from './cards'

interface Option {
  label: string
  description?: string
}

export interface Question {
  question: string
  options: Option[]
  ownWords?: true
}

export interface CodexApproval {
  id: string | number
  command?: string
  reason?: string
}

export interface Asked {
  questions: Question[]
}

export interface CodexQuestion extends Asked {
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

export interface Choice {
  label: string
  reply: string
  style: CardButton['style']
}

export const YES_OR_NO: Choice[] = [
  { label: 'Yes', reply: 'yes', style: 'success' },
  { label: 'No', reply: 'no', style: 'danger' }
]

export function optionChoices(q: Question): Choice[] {
  return q.options.map((o, i) => ({
    label: `${i + 1}. ${o.label}`,
    reply: String(i + 1),
    style: 'secondary'
  }))
}

function singlePick(p: AskPayload): Question | undefined {
  const qs = questionsOf(p)
  const raw = p.tool_input?.questions as { multiSelect?: unknown }[]
  return qs.length === 1 && raw[0]?.multiSelect !== true ? qs[0] : undefined
}

export function choicesOf(p: AskPayload): Choice[] {
  if (p.tool_name === 'AskUserQuestion') {
    const q = singlePick(p)
    return q ? optionChoices(q) : []
  }
  if (planOf(p) === undefined) return YES_OR_NO
  return [
    { label: 'Approve', reply: 'yes', style: 'success' },
    { label: 'Reject', reply: 'no', style: 'danger' }
  ]
}

export interface DialogView {
  text: string
  choices: Choice[]
}

export function claudeDialog(p: AskPayload): DialogView {
  return { text: dialogText(p), choices: choicesOf(p) }
}

export function codexDialog(a: CodexApproval | CodexQuestion): DialogView {
  if (!('questions' in a)) return { text: approvalDetail(a) ?? '', choices: YES_OR_NO }
  const [only, ...more] = a.questions
  return {
    text: a.questions.map(questionText).join('\n\n'),
    choices: only && !more.length ? optionChoices(only) : []
  }
}

export const ONE_LINE_PER_QUESTION =
  'Reply with one line per question: a number or your own answer.'

export function askHow(p: AskPayload): string {
  if (p.tool_name === 'AskUserQuestion')
    return questionsOf(p).length > 1
      ? ONE_LINE_PER_QUESTION
      : 'Reply with a number or your own answer.'
  return planOf(p) === undefined
    ? 'Reply yes or no.'
    : 'Reply yes to approve, or say what to change.'
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
    Object.entries(call.input).every(([k, v]) => isDeepStrictEqual(asked[k], v))
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
    const lines = replyLines(text)
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
  'Koloft answers this dialog by its keys, so it can only answer one question that takes one option. Assist can still answer this one by pressing its keys.'
const YES_OR_NO_BY_KEYS = 'Koloft answers this dialog by its keys, so it can only answer yes or no.'

// CC§14
export function claudeKeysFor(p: AskPayload, reply: string): Parsed<string[]> {
  const text = reply.trim()
  if (p.tool_name === 'AskUserQuestion') {
    const q = singlePick(p)
    if (!q) return fail(ONE_QUESTION_BY_KEYS)
    const options = q.options.length
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

// CODEX§3
export function codexKeyFor(reply: string): string | undefined {
  const text = reply.trim()
  if (YES.test(text)) return 'y'
  if (NO.test(text)) return ESC
  return undefined
}

export function labelsOf(raw: unknown): Option[] {
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
export function codexQuestionOf(method: string, p: Record<string, unknown>): Asked | undefined {
  if (method === 'item/tool/requestUserInput') {
    const raw = Array.isArray(p.questions) ? p.questions : []
    const questions = raw.flatMap((x) => {
      const q = (x ?? {}) as { question?: unknown; options?: unknown; isOther?: unknown }
      const options = labelsOf(q.options)
      return typeof q.question === 'string' && options.length
        ? [
            {
              question: q.question,
              options,
              ...(q.isOther === true && { ownWords: true as const })
            }
          ]
        : []
    })
    return raw.length && questions.length === raw.length ? { questions } : undefined
  }
  if (method !== 'mcpServer/elicitation/request' || p.mode !== 'form') return undefined
  const schema = (p.requestedSchema ?? {}) as { properties?: Record<string, { enum?: unknown }> }
  const fields = Object.values(schema.properties ?? {})
  const options = labelsOf(fields[0]?.enum)
  return fields.length === 1 && typeof p.message === 'string' && options.length
    ? { questions: [{ question: p.message, options }] }
    : undefined
}

export const PICK_ONE_OPTION = 'Reply with the number or the name of one option.'
export const PICK_OR_OWN_WORDS =
  'Reply with the number or the name of one option, or with your own answer.'
export const NO_OWN_WORDS =
  'Tap a button, or reply with the number or the name of one option. To answer in your own words, answer it at the Mac.'

const ONE_LINE_PER_PICK = 'Reply with one line per question: the number or the name of one option.'

export function howToAnswer(q: Asked): string {
  const ownWords = q.questions.some((x) => x.ownWords)
  if (q.questions.length > 1) return ownWords ? ONE_LINE_PER_QUESTION : ONE_LINE_PER_PICK
  return ownWords ? PICK_OR_OWN_WORDS : PICK_ONE_OPTION
}

export function cannotAnswer(q: Asked): string {
  return q.questions.length === 1 && !q.questions[0]?.ownWords ? NO_OWN_WORDS : howToAnswer(q)
}

export type QuestionAnswer = { pick: number } | { words: string }

function answerTo(q: Question, line: string): QuestionAnswer | undefined {
  const pick = /^\d+$/.test(line)
    ? Number(line)
    : q.options.findIndex((o) => o.label.toLowerCase() === line.toLowerCase()) + 1
  if (pick >= 1 && pick <= q.options.length) return { pick }
  return q.ownWords && line ? { words: line } : undefined
}

function replyLines(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
}

// CODEX§20 MUSE§11 AGY§14
export function questionAnswers(q: Asked, reply: string): QuestionAnswer[] | undefined {
  const all = replyLines(reply)
  const lines = q.questions.length === 1 ? [all.join(' ')] : all
  if (lines.length !== q.questions.length) return undefined
  const answers = q.questions.map((x, i) => answerTo(x, lines[i]))
  return answers.every((a): a is QuestionAnswer => a !== undefined) ? answers : undefined
}

export interface AnswerKeys {
  pick(n: number): string[]
  words(q: Question, text: string): string[]
  submit(answers: QuestionAnswer[]): string[]
}

// CODEX§20 MUSE§11
const noteUnderNoneOfTheAbove = (q: Question, text: string): string[] => [
  ...keysFor([...q.options.map(() => 'Down'), 'Tab']),
  ...typedPieces(text),
  '\r'
]

// MUSE§11
function museReviewKeys(answers: QuestionAnswer[]): string[] {
  return answers.length > 1 || answers.some((a) => 'words' in a) ? ['\r'] : []
}

// CODEX§20 MUSE§11 AGY§14
export const ANSWER_KEYS: Record<Exclude<BackendId, 'claude'>, AnswerKeys> = {
  codex: { pick: (n) => [String(n)], words: noteUnderNoneOfTheAbove, submit: () => [] },
  muse: { pick: (n) => [String(n), '\r'], words: noteUnderNoneOfTheAbove, submit: museReviewKeys },
  agy: {
    pick: (n) => [String(n)],
    words: (q, text) => [String(q.options.length + 1), ...typedPieces(text), '\r'],
    submit: () => []
  }
}

export function answerKeys(keys: AnswerKeys, q: Asked, answers: QuestionAnswer[]): string[] {
  return [
    ...answers.flatMap((a, i) =>
      'pick' in a ? keys.pick(a.pick) : keys.words(q.questions[i]!, a.words)
    ),
    ...keys.submit(answers)
  ]
}
