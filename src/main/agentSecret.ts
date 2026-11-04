import { loopbackHttp, urlOrNull } from '@shared/browserRoute'
import type { SecretAskShape } from '@shared/types'
import { answered, EXIT_USAGE, refused, type AgentReply, type AgentVerb } from './agentRequests'
import type { SecretAnswer, SecretAsk } from './discord/secretAsks'

export const SECRET_USAGE =
  'koloft: usage: koloft secret page <css selector> | koloft secret url "<sign-in address>"'
export const NOT_IN_TIME = 'koloft: the owner did not answer in time; nothing was passed on.'
export const OWNER_DECLINED = 'koloft: the owner turned this down; nothing was passed on.'
export const OWNER_ASLEEP =
  'koloft: the owner is asleep and cannot give a password or a code now. Skip this step, go on with the rest, and say in your report that it waits for the owner.'
export const NO_SUCH_FIELD =
  "koloft: no single field matches that selector in this session's Workbench pages (the Koloft window has to be open). Give a selector that matches exactly one input box."
export const PAGE_CHANGED =
  'koloft: the page moved to another site, or the field went, while the owner answered; Koloft filled nothing.'
export const NOT_LOOPBACK =
  'koloft: what the owner pasted is not an http address on 127.0.0.1 or localhost, so Koloft did not open it.'
const FIELD_KEPT =
  ', but the field still held the text afterwards, so Koloft emptied it: the sign-in may have failed. Look at the page.'
export const FILLED = 'Koloft filled the field and submitted the form.'
export const FILLED_AND_EMPTIED = `Koloft filled the field and submitted the form${FIELD_KEPT}`
export const OWNER_FILLED =
  'The page moved on, or the owner said they were done, after Koloft asked the owner to fill it in on the Mac. Look at the page to see whether it went through.'
export const OWNER_FILLED_AND_EMPTIED = `The page moved on, or the owner said they were done, after Koloft asked the owner to fill it in on the Mac${FIELD_KEPT}`

const A_SUBMITTED_PAGE_MOVES_ON_MS = 3000

export interface FieldPage {
  guestId: number
  url(): string
  run(script: string): Promise<unknown>
}

export interface SecretVerbDeps {
  sessionTab(tabId: string): string
  ask(a: SecretAsk): Promise<SecretAnswer>
  ownerAsleep(): boolean
  machine(tabId: string): string | undefined
  pages(tabId: string): FieldPage[]
  showSignIn(tabId: string, url: string): void
  open(machine: string | undefined, url: string): Promise<string>
  sleep(ms: number): Promise<void>
}

interface FieldFacts {
  count: number
  label?: string
}

type Given = Exclude<SecretAnswer, { ended: unknown }>

const focusField = (selector: string): string =>
  `document.querySelector(${JSON.stringify(selector)})?.focus()`

const describeField = (selector: string): string => `(() => {
  const els = document.querySelectorAll(${JSON.stringify(selector)})
  if (els.length !== 1) return { count: els.length }
  const el = els[0]
  if (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA') return { count: 0 }
  const named = (el.labels && el.labels[0] && el.labels[0].innerText) || el.getAttribute('aria-label') || el.placeholder || el.name || el.id || el.type
  return { count: 1, label: String(named || 'field').trim().slice(0, 80) }
})()`

const SET_VALUE = `const set = (el, v) => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set.call(el, v)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }`

const fillAndSubmit = (selector: string, value: string): string => `(() => {
  ${SET_VALUE}
  const els = document.querySelectorAll(${JSON.stringify(selector)})
  if (els.length !== 1) return false
  const el = els[0]
  const v = ${JSON.stringify(value)}
  el.focus()
  if (el.select) el.select()
  if (!document.execCommand('insertText', false, v) || el.value !== v) set(el, v)
  el.dispatchEvent(new Event('change', { bubbles: true }))
  const enter = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }
  const go = el.dispatchEvent(new KeyboardEvent('keydown', enter)) && el.dispatchEvent(new KeyboardEvent('keypress', enter))
  el.dispatchEvent(new KeyboardEvent('keyup', enter))
  if (go && el.form) el.form.requestSubmit ? el.form.requestSubmit() : el.form.submit()
  return true
})()`

const emptyIfKept = (selector: string): string => `(() => {
  ${SET_VALUE}
  const els = document.querySelectorAll(${JSON.stringify(selector)})
  if (els.length !== 1 || !els[0].value) return false
  set(els[0], '')
  return true
})()`

function originOf(url: string): string {
  return urlOrNull(url)?.origin ?? url
}

async function factsOn(page: FieldPage, selector: string): Promise<FieldFacts> {
  const facts = (await page.run(describeField(selector)).catch(() => null)) as FieldFacts | null
  return facts ?? { count: 0 }
}

interface Asker {
  tabId: string
  from: string
}

async function askOwner(
  d: SecretVerbDeps,
  ask: SecretAsk,
  meanwhile?: () => void
): Promise<Given | AgentReply> {
  if (d.ownerAsleep()) return refused(OWNER_ASLEEP)
  const answer = d.ask(ask)
  meanwhile?.()
  const a = await answer
  if ('ended' in a) return refused(a.ended === 'declined' ? OWNER_DECLINED : NOT_IN_TIME)
  return a
}

function isReply(v: Given | AgentReply): v is AgentReply {
  return 'exit' in v
}

// PLATFORM§58
async function sudoPassword(
  d: SecretVerbDeps,
  at: Asker,
  prompt: string,
  command: string
): Promise<AgentReply> {
  const shape: SecretAskShape = { kind: 'sudo', command: command || 'sudo', prompt }
  const v = await askOwner(d, {
    ...at,
    shape,
    header: (name) => `🔑 **${name}** asks for your sudo password`,
    body: `Command: \`${shape.command}\`\nsudo asked: ${prompt || 'Password:'}`,
    label: 'Your sudo password'
  })
  if (isReply(v)) return v
  return 'typed' in v ? answered(v.typed) : refused(NOT_IN_TIME)
}

// PLATFORM§17
async function pageField(d: SecretVerbDeps, at: Asker, selector: string): Promise<AgentReply> {
  const pages = d.pages(at.tabId)
  const facts = await Promise.all(pages.map((p) => factsOn(p, selector)))
  if (facts.reduce((n, f) => n + f.count, 0) !== 1) return refused(NO_SUCH_FIELD)
  const found = facts.findIndex((f) => f.count === 1)
  const page = pages[found]
  const label = facts[found].label ?? 'field'
  const url = page.url()
  const origin = originOf(url)
  const v = await askOwner(
    d,
    {
      ...at,
      shape: { kind: 'page', guestId: page.guestId, url, label },
      header: (name) => `🔑 **${name}** asks you to fill in a field on a web page`,
      body: `Page: ${origin}\nField: ${label}`,
      label
    },
    () => void page.run(focusField(selector)).catch(() => undefined)
  )
  if (isReply(v)) return v
  const typed = 'typed' in v
  if (typed) {
    if (originOf(page.url()) !== origin) return refused(PAGE_CHANGED)
    if ((await page.run(fillAndSubmit(selector, v.typed)).catch(() => false)) !== true)
      return refused(PAGE_CHANGED)
  }
  await d.sleep(A_SUBMITTED_PAGE_MOVES_ON_MS)
  const emptied = (await page.run(emptyIfKept(selector)).catch(() => false)) === true
  if (typed) return answered(emptied ? FILLED_AND_EMPTIED : FILLED)
  return answered(emptied ? OWNER_FILLED_AND_EMPTIED : OWNER_FILLED)
}

// CODEX§15
async function signInEnd(d: SecretVerbDeps, at: Asker, signIn: string): Promise<AgentReply> {
  const machine = d.machine(at.tabId)
  const where = machine ?? 'this Mac'
  const v = await askOwner(
    d,
    {
      ...at,
      shape: { kind: 'url', signIn },
      header: (name) => `🔑 **${name}** needs the address a sign-in ends on`,
      body: [
        `1. Open this on your phone and finish the sign-in: ${signIn}`,
        '2. The last page will not load: it points at 127.0.0.1 or localhost.',
        `3. Copy that page's whole address and paste it here. Koloft opens it on ${where}.`
      ].join('\n'),
      label: 'The address the sign-in ended on'
    },
    () => d.showSignIn(at.tabId, signIn)
  )
  if (isReply(v)) return v
  if (!('typed' in v))
    return answered(
      `The owner finished the sign-in in this session's Workbench, and its last page loaded on ${where}.`
    )
  const url = loopbackHttp(v.typed)
  if (!url) return refused(NOT_LOOPBACK)
  const status = await d.open(machine, url)
  return answered(`Koloft opened the address on ${where}; it answered ${status}.`)
}

export function secretVerb(d: SecretVerbDeps): AgentVerb {
  return (args, caller) => {
    const [sub, ...rest] = args
    const at = { tabId: d.sessionTab(caller.tabId), from: caller.tabId }
    if (sub === 'sudo' && rest.length <= 2) return sudoPassword(d, at, rest[0] ?? '', rest[1] ?? '')
    if (sub === 'page' && rest.length === 1 && rest[0].trim()) return pageField(d, at, rest[0])
    if (sub === 'url' && rest.length === 1 && rest[0].trim())
      return signInEnd(d, at, rest[0].trim())
    return refused(SECRET_USAGE, EXIT_USAGE)
  }
}
