import { LOOPBACK_HOSTS, urlOrNull } from '@shared/browserRoute'
import { answered, EXIT_USAGE, refused, type AgentReply, type AgentVerb } from './agentRequests'
import type { SecretAsk } from './discord/secretAsks'

export const SECRET_USAGE =
  'koloft: usage: koloft secret page <css selector> | koloft secret url "<sign-in address>"'
export const NO_DISCORD =
  "koloft: Koloft asks the owner for a secret only in the butler's Discord channel, and no Discord channel is bound. Ask the owner to do this step at the Mac."
export const NOT_IN_TIME = 'koloft: the owner did not answer in time; nothing was passed on.'
export const NO_SUCH_FIELD =
  "koloft: no single field matches that selector in this session's Workbench pages (the Koloft window has to be open). Give a selector that matches exactly one input box."
export const PAGE_CHANGED =
  'koloft: the page moved to another site, or the field went, while the owner answered; Koloft filled nothing.'
export const NOT_LOOPBACK =
  'koloft: what the owner pasted is not an http address on 127.0.0.1 or localhost, so Koloft did not open it.'
export const FILLED = 'Koloft filled the field and submitted the form.'
export const FILLED_AND_EMPTIED =
  'Koloft filled the field and submitted the form, but the field still held the text afterwards, so Koloft emptied it: the sign-in may have failed. Look at the page.'

const A_SUBMITTED_PAGE_MOVES_ON_MS = 3000

export interface FieldPage {
  url(): string
  run(script: string): Promise<unknown>
}

export interface SecretVerbDeps {
  ask(a: SecretAsk): Promise<string | undefined | null>
  machine(tabId: string): string | undefined
  pages(tabId: string): FieldPage[]
  open(machine: string | undefined, url: string): Promise<string>
  sleep(ms: number): Promise<void>
}

interface FieldFacts {
  count: number
  label?: string
}

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

async function askOwner(d: SecretVerbDeps, ask: SecretAsk): Promise<string | AgentReply> {
  const value = await d.ask(ask)
  if (value === null) return refused(NO_DISCORD)
  return value ?? refused(NOT_IN_TIME)
}

// PLATFORM§58
async function sudoPassword(
  d: SecretVerbDeps,
  tabId: string,
  prompt: string,
  command: string
): Promise<AgentReply> {
  const value = await askOwner(d, {
    tabId,
    header: (name) => `🔑 **${name}** asks for your sudo password`,
    body: `Command: \`${command || 'sudo'}\`\nsudo asked: ${prompt || 'Password:'}`,
    label: 'Your sudo password'
  })
  return typeof value === 'string' ? answered(value) : value
}

// PLATFORM§17
async function pageField(d: SecretVerbDeps, tabId: string, selector: string): Promise<AgentReply> {
  const pages = d.pages(tabId)
  const facts = await Promise.all(pages.map((p) => factsOn(p, selector)))
  if (facts.reduce((n, f) => n + f.count, 0) !== 1) return refused(NO_SUCH_FIELD)
  const at = facts.findIndex((f) => f.count === 1)
  const page = pages[at]
  const label = facts[at].label ?? 'field'
  const origin = originOf(page.url())
  const value = await askOwner(d, {
    tabId,
    header: (name) => `🔑 **${name}** asks you to fill in a field on a web page`,
    body: `Page: ${origin}\nField: ${label}`,
    label
  })
  if (typeof value !== 'string') return value
  if (originOf(page.url()) !== origin) return refused(PAGE_CHANGED)
  if ((await page.run(fillAndSubmit(selector, value)).catch(() => false)) !== true)
    return refused(PAGE_CHANGED)
  await d.sleep(A_SUBMITTED_PAGE_MOVES_ON_MS)
  const emptied = await page.run(emptyIfKept(selector)).catch(() => false)
  return answered(emptied === true ? FILLED_AND_EMPTIED : FILLED)
}

function loopback(text: string): string | undefined {
  const url = urlOrNull(text.trim())
  return url?.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname) ? url.href : undefined
}

// CODEX§15
async function signInEnd(d: SecretVerbDeps, tabId: string, signIn: string): Promise<AgentReply> {
  const machine = d.machine(tabId)
  const where = machine ?? 'this Mac'
  const value = await askOwner(d, {
    tabId,
    header: (name) => `🔑 **${name}** needs the address a sign-in ends on`,
    body: [
      `1. Open this on your phone and finish the sign-in: ${signIn}`,
      '2. The last page will not load: it points at 127.0.0.1 or localhost.',
      `3. Copy that page's whole address and paste it here. Koloft opens it on ${where}.`
    ].join('\n'),
    label: 'The address the sign-in ended on'
  })
  if (typeof value !== 'string') return value
  const url = loopback(value)
  if (!url) return refused(NOT_LOOPBACK)
  const status = await d.open(machine, url)
  return answered(`Koloft opened the address on ${where}; it answered ${status}.`)
}

export function secretVerb(d: SecretVerbDeps): AgentVerb {
  return (args, caller) => {
    const [sub, ...rest] = args
    if (sub === 'sudo' && rest.length <= 2)
      return sudoPassword(d, caller.tabId, rest[0] ?? '', rest[1] ?? '')
    if (sub === 'page' && rest.length === 1 && rest[0].trim())
      return pageField(d, caller.tabId, rest[0])
    if (sub === 'url' && rest.length === 1 && rest[0].trim())
      return signInEnd(d, caller.tabId, rest[0].trim())
    return refused(SECRET_USAGE, EXIT_USAGE)
  }
}
