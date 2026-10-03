export interface AskPayload {
  tool_name?: string
  tool_input?: Record<string, unknown>
}

interface Option {
  label: string
  description?: string
}

interface Question {
  question: string
  options: Option[]
}

export interface CodexApproval {
  id: string | number
  command?: string
  reason?: string
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
    const options = (Array.isArray(r.options) ? r.options : []).flatMap((o) => {
      const x = o as { label?: unknown; description?: unknown }
      return typeof x.label === 'string'
        ? [
            {
              label: x.label,
              ...(typeof x.description === 'string' ? { description: x.description } : {})
            }
          ]
        : []
    })
    return [{ question: r.question, options }]
  })
}

function questionText(q: Question): string {
  const options = q.options.map(
    (o, i) => `${i + 1}. ${o.label}${o.description ? ` — ${o.description}` : ''}`
  )
  return [`❓ ${q.question}`, ...options].join('\n')
}

export function askText(p: AskPayload): string {
  if (p.tool_name === 'AskUserQuestion') {
    const qs = questionsOf(p)
    const how =
      qs.length > 1
        ? 'Reply with one line per question: a number or your own answer.'
        : 'Reply with a number or your own answer.'
    return [...qs.map(questionText), how].join('\n\n')
  }
  const plan = p.tool_input?.plan
  if (typeof plan === 'string')
    return `❓ Approve this plan?\n\n${plan}\n\nReply yes to approve, or say what to change.`
  return `❓ ${p.tool_name ?? 'A tool'} asks to run:\n${JSON.stringify(p.tool_input ?? {})}\n\nReply yes or no.`
}

function answerOf(q: Question, line: string): string {
  const picks = line.split(/\s*,\s*/)
  const labels = picks.map((x) => (/^\d+$/.test(x) ? q.options[Number(x) - 1]?.label : undefined))
  return labels.every((l) => l !== undefined) ? labels.join(', ') : line
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
  if (NO.test(text)) return '\x1b'
  return undefined
}
