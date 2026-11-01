import { FROM_KOLOFT } from './crossSessionMessage'
import { digestLine, quoteOf, type DigestItem } from './awayDigest'

export const OWNER_ASLEEP_ANSWER =
  'The owner is asleep and cannot answer. Choose the option you recommend, note the choice in your report, and go on. If that choice cannot be undone (merging, releasing, pushing to main, deleting on GitHub, spending money, accounts and passwords), do not make it: leave it for the owner and go on with the rest.'
const FIRST_OPTION = '1'
const APPROVE = 'yes'
const ASKED_CHARS_QUOTED = 200
const MINUTE_MS = 60_000

export const THIS_MAC = ''

export interface AskedOwner {
  question: boolean
  questions: number
  text: string
}

interface AnsweredForOwner {
  title: string
  asked: AskedOwner
  gave?: string
  failed?: string
}

export interface OwnerAsleepDeps {
  machines(): string[]
  mark(machine: string, awakeTabs: string[] | null): Promise<boolean>
  awakeTabs(): string[]
  tabs(): string[]
  asked(tabId: string): Promise<AskedOwner | undefined>
  answer(tabId: string, reply: string): Promise<string | undefined>
  titleOf(tabId: string): string
  changedSince(since: number): DigestItem[]
  report(text: string): void
  now(): number
}

function howLong(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / MINUTE_MS))
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return [h && `${h} h`, m && `${m} min`].filter(Boolean).join(' ')
}

function answeredLine(a: AnsweredForOwner, n: number): string {
  const text = quoteOf(a.asked.text, ASKED_CHARS_QUOTED)
  const what = a.asked.question ? `asked the owner "${text}"` : `asked to be allowed: "${text}"`
  const did = a.failed
    ? `Koloft could not answer it (${a.failed}), so it still waits for the owner`
    : !a.asked.question
      ? 'Koloft allowed it'
      : a.gave?.startsWith(FIRST_OPTION)
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

function repliesTo(asked: AskedOwner): string[] {
  if (!asked.question) return [APPROVE]
  const each = (reply: string): string => Array(asked.questions).fill(reply).join('\n')
  return [each(OWNER_ASLEEP_ANSWER), each(FIRST_OPTION)]
}

export class OwnerAsleep {
  private answered: AnsweredForOwner[] = []
  private settled = new Set<string>()
  private everMarked = new Set<string>()
  private generation = 0
  private answering = new Set<string>()

  constructor(
    private readonly d: OwnerAsleepDeps,
    private since: number | null
  ) {}

  asleep(): boolean {
    return this.since !== null
  }

  set(since: number | null): boolean {
    const sleptAt = this.since
    if (since === sleptAt) return false
    this.since = since
    if (since !== null && sleptAt === null) {
      this.answered = []
      for (const tabId of this.d.tabs()) void this.asks(tabId)
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
    this.awakeTabsChanged()
    return true
  }

  awakeTabsChanged(): void {
    this.generation++
    this.settled.clear()
    void this.reconcile()
  }

  async reconcile(): Promise<void> {
    const asleep = this.asleep()
    const generation = this.generation
    const awake = asleep ? this.d.awakeTabs() : null
    const machines = new Set([...this.d.machines(), ...(asleep ? [] : this.everMarked)])
    await Promise.all(
      [...machines]
        .filter((machine) => !this.settled.has(machine))
        .map(async (machine) => {
          const done = await this.d.mark(machine, awake).catch(() => false)
          if (!done) return
          if (asleep) this.everMarked.add(machine)
          if (generation !== this.generation) return void this.settled.delete(machine)
          this.settled.add(machine)
          if (!asleep) this.everMarked.delete(machine)
        })
    )
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
      for (const reply of repliesTo(asked)) {
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
