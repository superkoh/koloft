import { isDeepStrictEqual } from 'util'
import type { AskPayload } from '@shared/sessionEvent'
import type { BackendId } from '@shared/types'
import { fail, type Parsed } from '../agentRequests'
import type { ToolCall } from '../sessionTracker'
import { keysFor, typedPieces } from '../typeKeys'
import { CLEAR_TO_LINE_START } from '@shared/lineEditKeys'
import type { CardButton } from './cards'

interface Option {
  label: string
  description?: string
}

export interface Question {
  question: string
  options: Option[]
  ownWords?: true
  multiSelect?: true
}

export interface CodexApproval {
  id: string | number
  command?: string
  reason?: string
  file?: string
  plan?: true
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

export function questionsOf(p: AskPayload): Question[] {
  const raw = p.tool_input?.questions
  if (!Array.isArray(raw)) return []
  return raw.flatMap((q) => {
    const r = q as { question?: unknown; options?: unknown; multiSelect?: unknown }
    if (typeof r.question !== 'string') return []
    return [
      {
        question: r.question,
        options: labelsOf(r.options),
        ...(r.multiSelect === true && { multiSelect: true as const })
      }
    ]
  })
}

function questionText(q: Question): string {
  const options = q.options.map(
    (o, i) => `${i + 1}. ${o.label}${o.description ? ` — ${o.description}` : ''}`
  )
  return [q.question, ...options].join('\n')
}

export function planOf(p: AskPayload): string | undefined {
  const plan = p.tool_input?.plan
  return typeof plan === 'string' ? plan : undefined
}

function toolText(p: AskPayload): string {
  const command = p.tool_input?.command
  return typeof command === 'string'
    ? `${p.tool_name} asks to run:\n${command}`
    : `${p.tool_name ?? 'A tool'} asks to run:\n${JSON.stringify(p.tool_input ?? {})}`
}

export const PLAN_IS_IN_ITS_SESSION = 'Open the session to read the plan.'

function planText(plan: string): string {
  return `Approve this plan?\n\n${plan}`
}

export function dialogText(p: AskPayload): string {
  if (p.tool_name === 'AskUserQuestion') return questionsOf(p).map(questionText).join('\n\n')
  const plan = planOf(p)
  return plan === undefined ? toolText(p) : planText(plan)
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

// CC§14
function drawsTabs(qs: Question[]): boolean {
  return qs.length !== 1 || !!qs[0]!.multiSelect
}

function singlePick(p: AskPayload): Question | undefined {
  const qs = questionsOf(p)
  return drawsTabs(qs) ? undefined : qs[0]
}

export function choicesOf(p: AskPayload): Choice[] {
  if (p.tool_name === 'AskUserQuestion') {
    const q = singlePick(p)
    return q ? optionChoices(q) : []
  }
  return planOf(p) === undefined ? YES_OR_NO : APPROVE_OR_REJECT
}

const APPROVE_OR_REJECT: Choice[] = [
  { label: 'Approve', reply: 'yes', style: 'success' },
  { label: 'Reject', reply: 'no', style: 'danger' }
]

export interface DialogView {
  text: string
  choices: Choice[]
}

export function claudeDialog(p: AskPayload): DialogView {
  return { text: dialogText(p), choices: choicesOf(p) }
}

export function codexDialog(a: CodexApproval | CodexQuestion): DialogView {
  if (!('questions' in a) && a.plan)
    return { text: planText(a.reason ?? PLAN_IS_IN_ITS_SESSION), choices: APPROVE_OR_REJECT }
  if (!('questions' in a)) return { text: approvalDetail(a) ?? '', choices: YES_OR_NO }
  const [only, ...more] = a.questions
  return {
    text: a.questions.map(questionText).join('\n\n'),
    choices: only && !more.length ? optionChoices(only) : []
  }
}

export const ONE_LINE_PER_QUESTION =
  'Reply with one line per question: a number or your own answer.'
const ONE_LINE_PER_QUESTION_SOME_PICK_SEVERAL =
  'Reply with one line per question: a number (or several, split by commas, where it takes more than one) or your own answer.'
const PICK_SEVERAL =
  'Reply with the numbers of the options you pick, split by commas, or your own answer.'

export function askHow(p: AskPayload): string {
  if (p.tool_name === 'AskUserQuestion') {
    const qs = questionsOf(p)
    const several = qs.some((q) => q.multiSelect)
    if (qs.length > 1)
      return several ? ONE_LINE_PER_QUESTION_SOME_PICK_SEVERAL : ONE_LINE_PER_QUESTION
    return several ? PICK_SEVERAL : 'Reply with a number or your own answer.'
  }
  return planOf(p) === undefined
    ? 'Reply yes or no.'
    : 'Reply yes to approve, or say what to change.'
}

function answerOf(q: Question, line: string): string {
  const picks = picksFor(q, line)
  return picks ? picks.map((n) => q.options[n - 1]!.label).join(', ') : line
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
    const lines = linesPerQuestion(qs, text) ?? replyLines(text)
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
const YES_OR_NO_BY_KEYS = 'Koloft answers this dialog by its keys, so it can only answer yes or no.'

function pickOf(q: Question, word: string): number {
  const pick = /^\d+$/.test(word)
    ? Number(word)
    : q.options.findIndex((o) => o.label.toLowerCase() === word.toLowerCase()) + 1
  return pick >= 1 && pick <= q.options.length ? pick : 0
}

function picksFor(q: Question, line: string): number[] | undefined {
  if (!q.multiSelect) {
    const pick = pickOf(q, line)
    return pick ? [pick] : undefined
  }
  const picks = line
    .split(/\s*,\s*/)
    .filter(Boolean)
    .map((word) => pickOf(q, word))
  return picks.length && picks.every((n) => n > 0)
    ? [...new Set(picks)].sort((a, b) => a - b)
    : undefined
}

function linesPerQuestion(qs: Question[], reply: string): string[] | undefined {
  const all = replyLines(reply)
  if (qs.length === 1) return [all.join(qs[0]!.multiSelect ? ', ' : ' ')]
  return all.length === qs.length ? all : undefined
}

// AGY§14
function ownWordsAfterTheLastOption(q: Question, text: string): string[] {
  return [String(q.options.length + 1), ...typedPieces(text), '\r']
}

// CC§14
const NEXT_QUESTION_AFTER_TICKS = '\t'
const SUBMIT_ON_THE_REVIEW_PAGE = '1'
const SHIFT_TAB = 'Shift-Tab'
const PASSES_SO_A_STALLED_READ_CANNOT_SWALLOW_THE_WAY_BACK = 2

const presses = (key: string, n: number): string[] => keysFor(Array<string>(n).fill(key))

const rowsUnderTheOptions = (q: Question): number => (q.multiSelect ? 3 : 2)

// CC§14
export function takesSeveralPicks(p: AskPayload): boolean {
  return p.tool_name === 'AskUserQuestion' && questionsOf(p).some((q) => q.multiSelect)
}

// CC§14
function backToTheFirstQuestion(qs: Question[]): string[] {
  const toTheBottomRow = Math.max(...qs.map((q) => q.options.length + rowsUnderTheOptions(q)))
  const ontoAnOption = Math.max(...qs.map(rowsUnderTheOptions))
  const pass = [
    ...presses('Down', toTheBottomRow),
    ...presses('Up', ontoAnOption),
    ...presses(SHIFT_TAB, qs.length)
  ]
  return Array<string[]>(PASSES_SO_A_STALLED_READ_CANNOT_SWALLOW_THE_WAY_BACK).fill(pass).flat()
}

// CC§14
function emptyTheOwnWordsField(q: Question): string[] {
  return [
    ...presses('Down', q.options.length + rowsUnderTheOptions(q)),
    ...presses('Up', rowsUnderTheOptions(q) - 1),
    CLEAR_TO_LINE_START
  ]
}

// CC§14
function intoTheFieldOfAFreshQuestion(q: Question): string[] {
  return q.multiSelect ? presses('Down', q.options.length) : [String(q.options.length + 1)]
}

// CC§14
function questionKeys(q: Question, line: string, emptyItFirst: boolean): string[] {
  const picks = picksFor(q, line)
  const moveOn = q.multiSelect ? [NEXT_QUESTION_AFTER_TICKS] : []
  if (picks) {
    const ontoAnOption = emptyItFirst ? [...emptyTheOwnWordsField(q), ...presses('Up', 1)] : []
    return [...ontoAnOption, ...picks.map(String), ...moveOn]
  }
  const intoTheField = emptyItFirst ? emptyTheOwnWordsField(q) : intoTheFieldOfAFreshQuestion(q)
  return [...intoTheField, ...typedPieces(line), ...moveOn, '\r']
}

const ROWS_OF_A_PLAN_DIALOG = 3

// CC§14
function emptyThePlanFeedbackRowFromAnyRow(): string[] {
  const nextRow = [...presses('Down', 1), CLEAR_TO_LINE_START]
  return [
    CLEAR_TO_LINE_START,
    ...Array<string[]>(ROWS_OF_A_PLAN_DIALOG - 1)
      .fill(nextRow)
      .flat()
  ]
}

// CC§14
export function claudeKeysFor(
  p: AskPayload,
  reply: string,
  keysPressedSinceAsked = true
): Parsed<string[]> {
  const text = reply.trim()
  if (p.tool_name === 'AskUserQuestion') {
    const qs = questionsOf(p)
    const lines = linesPerQuestion(qs, text)
    if (!lines) return fail(askHow(p))
    const answers = qs.flatMap((q, i) =>
      questionKeys(q, lines[i]!, keysPressedSinceAsked || i === 0)
    )
    if (!drawsTabs(qs)) return { ok: true, value: answers }
    const wayBack = keysPressedSinceAsked ? backToTheFirstQuestion(qs) : []
    return { ok: true, value: [...wayBack, ...answers, SUBMIT_ON_THE_REVIEW_PAGE] }
  }
  if (p.tool_name === 'ExitPlanMode' && YES.test(text))
    return { ok: true, value: [...emptyThePlanFeedbackRowFromAnyRow(), ...keysFor([SHIFT_TAB])] }
  if (YES.test(text)) return { ok: true, value: ['1'] }
  if (NO.test(text)) return { ok: true, value: [ESC] }
  return fail(YES_OR_NO_BY_KEYS)
}

export const A_TAKEN_ANSWER_SHOWS_WITHIN_MS = 15_000
export const ANSWER_NOT_TAKEN = 'Koloft sent your answer, but the session still waits for it.'

export interface SentAnswer {
  error?: string
  watch?: boolean
}

const ANSWERED_WITHOUT_RUNNING = new Set(['AskUserQuestion', 'ExitPlanMode'])

// CC§14
export function claudeResultComesAtOnce(p: AskPayload, reply: string): boolean {
  return ANSWERED_WITHOUT_RUNNING.has(p.tool_name ?? '') || !YES.test(reply.trim())
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
  const pick = pickOf(q, line)
  if (pick) return { pick }
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
  const lines = linesPerQuestion(q.questions, reply)
  if (!lines) return undefined
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
  agy: { pick: (n) => [String(n)], words: ownWordsAfterTheLastOption, submit: () => [] }
}

export function answerKeys(keys: AnswerKeys, q: Asked, answers: QuestionAnswer[]): string[] {
  return [
    ...answers.flatMap((a, i) =>
      'pick' in a ? keys.pick(a.pick) : keys.words(q.questions[i]!, a.words)
    ),
    ...keys.submit(answers)
  ]
}
