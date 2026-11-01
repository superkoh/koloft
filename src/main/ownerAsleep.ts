import { FROM_KOLOFT } from './crossSessionMessage'
import { digestLine, type DigestItem } from './awayDigest'

export const OWNER_ASLEEP_ANSWER =
  'The owner is asleep and cannot answer. Choose the option you recommend, note the choice in your report, and go on. If that choice cannot be undone (merging, releasing, pushing to main, deleting on GitHub, spending money, accounts and passwords), do not make it: leave it for the owner and go on with the rest.'
const FIRST_OPTION = '1'
const APPROVE = 'yes'
const ASKED_CHARS_QUOTED = 200
const MINUTE_MS = 60_000

export const THIS_MAC = ''

export interface Asked {
  question: boolean
  text: string
}

interface AnsweredForOwner {
  title: string
  asked: Asked
  gave?: string
  failed?: string
}

export interface OwnerAsleepDeps {
  since(): number | null
  machines(): string[]
  mark(machine: string, awakeTabs: string[] | null): Promise<boolean>
  awakeTabs(): string[]
  asking(): string[]
  asked(tabId: string): Promise<Asked | undefined>
  answer(tabId: string, reply: string): Promise<string | undefined>
  titleOf(tabId: string): string
  changedSince(since: number): DigestItem[]
  report(text: string): void
  now(): number
}

function quoted(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > ASKED_CHARS_QUOTED ? `${line.slice(0, ASKED_CHARS_QUOTED)}…` : line
}

function howLong(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / MINUTE_MS))
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return [h && `${h} h`, m && `${m} min`].filter(Boolean).join(' ')
}

function answeredLine(a: AnsweredForOwner, n: number): string {
  const what = a.asked.question
    ? `asked the owner "${quoted(a.asked.text)}"`
    : `asked to be allowed: "${quoted(a.asked.text)}"`
  const did = a.failed
    ? `Koloft could not answer it (${a.failed}), so it still waits for the owner`
    : !a.asked.question
      ? 'Koloft allowed it'
      : a.gave === FIRST_OPTION
        ? 'Koloft picked its first option'
        : 'Koloft told it to choose its own recommendation and go on'
  return `${n}. "${a.title}" ${what}; ${did}.`
}

export function morningReport(
  sleptMs: number,
  changed: DigestItem[],
  answered: AnsweredForOwner[]
): string | undefined {
  if (!changed.length && !answered.length) return undefined
  const parts = [
    `${FROM_KOLOFT}The owner was asleep for ${howLong(sleptMs)} and is back now. Tell them in a few short sentences, in their language: what the sessions below got done, which are stuck and what each needs from them, and what Koloft answered for them while they slept.`
  ]
  if (changed.length)
    parts.push(
      `Sessions that changed while they slept: ${changed.map((item, i) => digestLine(item, i + 1)).join(' ')}`
    )
  if (answered.length)
    parts.push(
      `Koloft answered for the owner: ${answered.map((a, i) => answeredLine(a, i + 1)).join(' ')}`
    )
  return parts.join(' ')
}

export class OwnerAsleep {
  private answered: AnsweredForOwner[] = []
  private marked: Set<string>
  private answering = new Set<string>()
  private sleptAt: number | null

  constructor(private readonly d: OwnerAsleepDeps) {
    this.sleptAt = d.since()
    this.marked = new Set(this.sleptAt === null ? [THIS_MAC] : [])
  }

  asleep(): boolean {
    return this.d.since() !== null
  }

  changed(): void {
    const since = this.d.since()
    const sleptAt = this.sleptAt
    this.sleptAt = since
    if (since !== null && sleptAt === null) {
      this.answered = []
      this.marked.clear()
      for (const tabId of this.d.asking()) void this.asks(tabId)
    }
    if (since === null && sleptAt !== null) {
      const text = morningReport(
        this.d.now() - sleptAt,
        this.d.changedSince(sleptAt),
        this.answered
      )
      this.answered = []
      if (text) this.d.report(text)
    }
    void this.reconcile()
  }

  awakeTabsChanged(): void {
    if (this.asleep()) this.marked.delete(THIS_MAC)
    void this.reconcile()
  }

  async reconcile(): Promise<void> {
    const asleep = this.asleep()
    const machines = asleep ? this.d.machines() : [...this.marked]
    const awake = asleep ? this.d.awakeTabs() : null
    for (const machine of machines) {
      if (asleep === this.marked.has(machine)) continue
      if (!(await this.d.mark(machine, awake))) continue
      if (asleep) this.marked.add(machine)
      else this.marked.delete(machine)
    }
  }

  answersFor(tabId: string): boolean {
    return this.asleep() && !this.d.awakeTabs().includes(tabId)
  }

  async asks(tabId: string): Promise<void> {
    if (!this.answersFor(tabId) || this.answering.has(tabId)) return
    this.answering.add(tabId)
    try {
      const asked = await this.d.asked(tabId)
      if (!asked) return
      const entry: AnsweredForOwner = { title: this.d.titleOf(tabId), asked }
      for (const reply of asked.question ? [OWNER_ASLEEP_ANSWER, FIRST_OPTION] : [APPROVE]) {
        entry.failed = await this.d.answer(tabId, reply)
        if (entry.failed === undefined) {
          entry.gave = reply
          break
        }
      }
      this.answered.push(entry)
    } finally {
      this.answering.delete(tabId)
    }
  }
}
