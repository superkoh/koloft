// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, cleanup, act, fireEvent, within } from '@testing-library/react'
import type { AccountAddResult, AccountKind, AccountView } from '@shared/types'
import { ACCOUNT_KINDS } from '@shared/types'
import { AGENT_IDS, accountKindFacts, agentManifest, type AgentId } from '@core/agent/registry'

vi.mock('../../src/renderer/src/components/settings/GitAccountsSection', () => ({
  GitAccountsSection: () => null
}))

const PINNED = './accounts-pane-text'

type SignInReply = 'ok' | 'invalid-name' | 'duplicate' | 'keychain' | 'unknown'
interface HeldFailure {
  kind: AccountKind
  name: string
  again: boolean
  tail: string
}

const fake = {
  log: [] as string[],
  installed: [] as AgentId[],
  addReply: Promise.resolve<AccountAddResult>({ ok: true }),
  signInReply: Promise.resolve<SignInReply>('ok'),
  held: null as HeldFailure | null
}

const SIGN_IN_TAB = { tabId: 'sign-in-tab', cwd: '/sign-in-home' }

const askedToSignIn = (kind: AccountKind, name: string, again?: boolean): void => {
  fake.log.push(`sign-in asked: ${kind} "${name}"${again ? ' again' : ''}`)
}

const accounts = {
  list: () => Promise.resolve([]),
  onUpdate: () => () => {},
  probe: () => Promise.resolve([]),
  add: (name: string, kind: AccountKind, secret: string, endpoint?: object) => {
    fake.log.push(
      `added: ${kind} "${name}" with a secret of ${secret.length} characters` +
        (endpoint ? ` at ${JSON.stringify(endpoint)}` : '')
    )
    return fake.addReply
  },
  beginSignIn: async (kind: AccountKind, name: string, again?: boolean) => {
    askedToSignIn(kind, name, again)
    const reply = await fake.signInReply
    if (reply !== 'ok') return { ok: false, error: reply }
    const inATab = accountKindFacts(kind).isASignInFolder
    return {
      ok: true,
      progress: inATab
        ? { kind, name, again: !!again, phase: 'inATab', tab: SIGN_IN_TAB }
        : { kind, name, again: !!again, phase: 'starting' }
    }
  },
  endSignIn: (kind: AccountKind, name: string) =>
    fake.log.push(
      fake.held?.kind === kind && fake.held.name === name
        ? 'held failure dismissed'
        : `sign-in ended: ${kind}`
    ),
  heldSignInFailure: async () => fake.held && { ...fake.held, phase: 'failed' },
  onSignInProgress: () => () => {}
}

Element.prototype.scrollIntoView = () => {}

;(window as unknown as { api: unknown }).api = {
  accounts,
  sessions: {
    backends: () =>
      Promise.resolve(AGENT_IDS.map((id) => ({ id, available: fake.installed.includes(id) }))),
    onToolsChanged: () => () => {}
  },
  os: { open: (url: string) => fake.log.push(`opened in the browser: ${url}`) }
}

const { AccountsPane, AddAccountDialog, SignInFailedDialog } =
  await import('../../src/renderer/src/components/settings/AccountsPane')
const { useStore } = await import('../../src/renderer/src/store')

let shots: string[] = []

const markup = (el: Element): string => el.outerHTML.replace(/></g, '>\n<')

function shoot(title: string, el: Element | null = document.querySelector('.acct-add')): void {
  const tabs = useStore.getState().tabs.map((t) => `tab opened: "${t.title}" ${t.id} in ${t.cwd}`)
  shots.push([`=== ${title} ===`, el ? markup(el) : '(no form)', ...fake.log, ...tabs].join('\n'))
  fake.log = []
  useStore.setState({ tabs: [], signIn: null })
}

const pinned = (name: string): Promise<void> =>
  expect(shots.join('\n\n') + '\n').toMatchFileSnapshot(`${PINNED}/${name}.txt`)

const settle = (): Promise<void> => act(async () => {})

function held<T>(): { promise: Promise<T>; answer(v: T): Promise<void> } {
  let answer!: (v: T) => void
  const promise = new Promise<T>((resolve) => (answer = resolve))
  return { promise, answer: (v) => act(async () => answer(v)) }
}

const typeInto = (input: Element | null, value: string): void => {
  fireEvent.change(input as Element, { target: { value } })
}

const formButton = (label: RegExp): HTMLElement =>
  within(document.querySelector('.acct-add') as HTMLElement).getByRole('button', { name: label })

beforeEach(() => {
  shots = []
  fake.log = []
  fake.held = null
  fake.installed = [...AGENT_IDS]
  useStore.setState({ tabs: [], signIn: null, accountLogin: null })
})

afterEach(() => cleanup())

const accountOf = (kind: AccountKind, name: string): AccountView => ({
  name,
  kind,
  enabled: true,
  fable: 'unknown',
  status: 'expired',
  addedAt: 0
})

describe('Settings ▸ Accounts forms the screenshots cannot reach keep every word, attribute and effect', () => {
  for (const kind of ACCOUNT_KINDS) {
    it(`the paste form of ${kind}: empty, busy, each refusal, and what happens once a saved account does not read signed in`, async () => {
      render(<AddAccountDialog kind={kind} onClose={() => fake.log.push('form closed')} />)
      await settle()
      shoot('empty')
      const [name, ...more] = Array.from(document.querySelectorAll('.acct-add input'))
      typeInto(name, 'acct')
      const secret = more.pop()
      for (const [i, extra] of more.entries())
        typeInto(extra, i === 0 ? 'https://gw.example.invalid/v1' : 'house-model')
      typeInto(secret as Element, 'sekret-1234')
      shoot('filled')

      const busy = held<AccountAddResult>()
      fake.addReply = busy.promise
      fireEvent.click(formButton(/save/i))
      shoot('busy')
      await busy.answer({ ok: false, error: 'invalid-name' })
      shoot('refused: invalid-name')

      for (const error of ['duplicate', 'invalid-endpoint', 'network'] as const) {
        typeInto(secret as Element, 'sekret-1234')
        fake.addReply = Promise.resolve({ ok: false, error })
        fireEvent.click(formButton(/save/i))
        await settle()
        shoot(`refused: ${error}`)
      }

      typeInto(secret as Element, 'sekret-1234')
      fake.addReply = Promise.resolve({ ok: false, account: accountOf(kind, 'acct') })
      fake.signInReply = Promise.resolve('keychain')
      fireEvent.click(formButton(/save/i))
      await settle()
      shoot('saved but not signed in, and its sign-in could not start')

      typeInto(secret as Element, 'sekret-1234')
      fake.addReply = Promise.resolve({ ok: false, account: accountOf(kind, 'acct') })
      fake.signInReply = Promise.resolve('ok')
      fireEvent.click(formButton(/save/i))
      await settle()
      shoot('saved but not signed in, and its sign-in started')

      await pinned(`paste-form-${kind}`)
    })
  }

  for (const id of AGENT_IDS) {
    it(`the sign-in of ${id} opened from its section: the form, not installed yet, each refusal, a start, and a cancel`, async () => {
      fake.installed = AGENT_IDS.filter((other) => other !== id)
      render(<AccountsPane />)
      await settle()
      const group = Array.from(document.querySelectorAll('.set-grp')).find(
        (g) => g.textContent === agentManifest(id).name
      )
      const sectionOf = (): HTMLElement => {
        let el = group?.nextElementSibling
        while (el && !el.classList.contains('acct-section')) el = el.nextElementSibling
        return el as HTMLElement
      }
      const signInButton = (): Element => sectionOf().querySelector('.acct-foot button') as Element
      shoot('foot', sectionOf().querySelector('.acct-foot'))
      fireEvent.click(signInButton())
      await settle()
      shoot('form, the agent not installed')

      typeInto(document.querySelector('.acct-add input[type="text"]'), 'fresh')
      for (const reply of ['invalid-name', 'duplicate', 'keychain', 'unknown'] as const) {
        const start = held<SignInReply>()
        fake.signInReply = start.promise
        fireEvent.click(formButton(/^Sign in$/))
        shoot(`starting, then refused: ${reply}`)
        await start.answer(reply)
        shoot(`refused: ${reply}`)
      }

      fake.signInReply = Promise.resolve('ok')
      fireEvent.click(formButton(/^Sign in$/))
      await settle()
      shoot('started')
      const cancel = document.querySelector('.acct-add')
        ? within(document.querySelector('.acct-add') as HTMLElement).queryByRole('button', {
            name: /^Cancel( sign-in)?$/
          })
        : null
      if (cancel) fireEvent.click(cancel)
      await settle()
      shoot('cancelled')
      await pinned(`sign-in-${id}`)
    })
  }

  it('the background sign-in box: the browser step with no link, a failure with no terminal and no output, a failure with a terminal shown, and trying again', async () => {
    render(<AccountsPane />)
    await settle()
    useStore.getState().beginLogin('oauth')
    await settle()
    const { setLoginProgress } = useStore.getState()
    for (const [title, progress] of [
      ['browser step, no link yet', { phase: 'browser', name: 'night' }],
      ['failed, no terminal, no output', { phase: 'failed', name: 'night' }],
      [
        'failed, with a terminal',
        { phase: 'failed', name: 'night', tail: 'last line', tabId: 'login-tab', cwd: '/home' }
      ]
    ] as const) {
      await act(async () => setLoginProgress(progress))
      shoot(title)
    }
    fireEvent.click(formButton(/^Show terminal$/))
    await settle()
    shoot('terminal shown')
    useStore.getState().beginLogin('oauth', 'night')
    await act(async () =>
      setLoginProgress({ phase: 'failed', name: 'night', tail: 'again failed' })
    )
    fireEvent.click(formButton(/^Try again$/))
    await settle()
    shoot('try again after a failed sign-in again')
    await pinned('sign-in-box-states')
  })

  for (const kind of ACCOUNT_KINDS.filter((k) =>
    AGENT_IDS.some((id) =>
      agentManifest(id).accountKinds.some((own) => own.id === k && own.isASignInFolder)
    )
  )) {
    it(`a held failure of a ${kind} sign-in: new and again, with and without output, dismissed and tried again`, async () => {
      for (const again of [false, true]) {
        for (const tail of ['', 'the last lines']) {
          fake.held = { kind, name: 'kept', again, tail }
          render(<SignInFailedDialog />)
          await settle()
          shoot(`held failure, ${again ? 'again' : 'new'}, ${tail ? 'with' : 'no'} output`)
          cleanup()
        }
      }
      fake.held = { kind, name: 'kept', again: false, tail: 'x' }
      render(<SignInFailedDialog />)
      await settle()
      fireEvent.click(formButton(/^Cancel$/))
      await settle()
      shoot('dismissed', null)
      fake.signInReply = Promise.resolve('ok')
      fireEvent.click(formButton(/^Try again$/))
      await settle()
      shoot('tried again', null)
      await pinned(`held-failure-${kind}`)
    })
  }
})
