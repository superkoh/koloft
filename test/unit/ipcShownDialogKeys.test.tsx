// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import type { JSX } from 'react'
import type { AccountView, ExtensionPermissionRequest } from '../../src/shared/types'
import type {
  BrowserDialog,
  BrowserDialogAnswer
} from '../../src/renderer/src/components/BrowserModal'
import type { AgentChoice } from '../../src/renderer/src/agentChoice'
import { meta } from './helpers/accounts'

const accountsListed: AccountView[] = [meta({ name: 'work' })]

function stillWaiting(): unknown {
  const never: unknown = Object.assign(() => {}, {
    then: () => never,
    catch: () => never,
    finally: () => never
  })
  return never
}

function api(path: string): unknown {
  return new Proxy(function () {}, {
    get: (_t, k) =>
      k === 'then' ? undefined : k === 'home' ? '/home' : api(`${path}.${String(k)}`),
    apply: () => (path === '.accounts.list' ? Promise.resolve(accountsListed) : stillWaiting())
  })
}
;(window as unknown as { api: unknown }).api = api('')

const { lagReactTasks, stopLaggingReactTasks, expectReactTasksLagged } =
  await import('./helpers/reactTaskLag')
const { useState } = await import('react')
const { render, cleanup, fireEvent, screen, waitFor } = await import('@testing-library/react')
const { BrowserModal } = await import('../../src/renderer/src/components/BrowserModal')
const { ExtensionConfirm } = await import('../../src/renderer/src/components/ExtensionConfirm')
const { CommandPalette } = await import('../../src/renderer/src/components/CommandPalette')
const { RestoreDialog } = await import('../../src/renderer/src/components/RestoreDialog')
const { CronJobsDialog } = await import('../../src/renderer/src/components/CronJobsDialog')
const { useDismissOnOutside } = await import('../../src/renderer/src/components/WorkspaceSidebar')
const { TopbarUsage } = await import('../../src/renderer/src/components/TopbarUsage')

const answers: unknown[] = []

afterEach(() => {
  stopLaggingReactTasks()
  cleanup()
  answers.length = 0
})

let show: (what: JSX.Element) => void = () => {}

function Host() {
  const [shown, setShown] = useState<JSX.Element | null>(null)
  show = setShown
  return (
    <>
      <textarea aria-label="terminal" />
      {shown}
    </>
  )
}

async function showFromAnIpcPush(what: JSX.Element): Promise<void> {
  render(<Host />)
  screen.getByRole('textbox', { name: 'terminal' }).focus()
  lagReactTasks()
  await Promise.resolve().then(() => show(what))
}

const pressEsc = (): void => {
  fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
}

const claudeOnly: AgentChoice = {
  listed: ['claude'],
  lead: 'claude',
  defaultBackend: 'claude',
  issue: () => '',
  note: () => ''
}

describe('a dialog that an IPC push shows takes the keys pressed the moment it shows, even while React’s effects still lag the screen', () => {
  it('a page’s sign-in dialog: the cursor is already in Username, and one Esc there cancels it once', async () => {
    const dialog: BrowserDialog = { id: 'auth-1', kind: 'auth', origin: 'https://site.test' }
    await showFromAnIpcPush(
      <BrowserModal
        dialog={dialog}
        onAnswer={(id: string, a: BrowserDialogAnswer) => answers.push([id, a])}
      />
    )
    const username = await screen.findByPlaceholderText('Username')
    expectReactTasksLagged()
    expect(document.activeElement).toBe(username)
    fireEvent.keyDown(username, { key: 'Escape' })
    expect(answers).toEqual([['auth-1', { ok: false }]])
  })

  it('an extension’s permission request: Deny already has focus, and Esc denies it', async () => {
    const request = {
      id: 'ext-1',
      kind: 'permissions',
      name: 'Helper',
      permissions: ['tabs'],
      origins: []
    } as unknown as ExtensionPermissionRequest
    await showFromAnIpcPush(
      <ExtensionConfirm request={request} onAnswer={(id, granted) => answers.push([id, granted])} />
    )
    const deny = await screen.findByRole('button', { name: 'Deny' })
    expectReactTasksLagged()
    expect(document.activeElement).toBe(deny)
    fireEvent.keyDown(deny, { key: 'Escape' })
    expect(answers).toEqual([['ext-1', false]])
  })

  it('the ⌘P palette: the cursor is already in its box, and Esc closes it', async () => {
    await showFromAnIpcPush(
      <CommandPalette
        actions={[]}
        onClose={() => answers.push('closed')}
        onRouted={() => {}}
        onOpenHit={() => {}}
        choices={{ local: claudeOnly, ssh: claudeOnly }}
      />
    )
    const box = await screen.findByRole('textbox', { name: 'Ask or jump' })
    expectReactTasksLagged()
    expect(document.activeElement).toBe(box)
    pressEsc()
    expect(answers).toEqual(['closed'])
  })

  it('Restore session, opened by the palette’s AI answer: Esc closes it', async () => {
    await showFromAnIpcPush(
      <RestoreDialog wsPath="/ws/app" onClose={() => answers.push('closed')} onRestore={() => {}} />
    )
    await screen.findByRole('dialog', { name: 'Restore session · app' })
    expectReactTasksLagged()
    pressEsc()
    expect(answers).toEqual(['closed'])
  })

  it('Scheduled jobs, opened by the palette’s AI answer: Esc closes it', async () => {
    await showFromAnIpcPush(
      <CronJobsDialog wsPath="/ws/app" onClose={() => answers.push('closed')} />
    )
    await screen.findByRole('dialog', { name: 'Scheduled jobs' })
    expectReactTasksLagged()
    pressEsc()
    expect(answers).toEqual(['closed'])
  })
})

let openMenu: () => void = () => {}

function Menu() {
  const [open, setOpen] = useState<true | null>(null)
  openMenu = () => setOpen(true)
  useDismissOnOutside(!!open, (none) => {
    answers.push('dismissed')
    setOpen(none)
  })
  return open && <div role="menu" aria-label="Row menu" />
}

describe('a menu or card a hover timer shows takes the Esc pressed the moment it shows, even while React’s effects still lag the screen', () => {
  it('a menu kept by useDismissOnOutside (the sidebar rows’ hover menu): Esc closes it', async () => {
    render(<Menu />)
    lagReactTasks()
    setTimeout(openMenu)
    await screen.findByRole('menu', { name: 'Row menu' })
    expectReactTasksLagged()
    pressEsc()
    expect(answers).toEqual(['dismissed'])
  })

  it('the top bar’s account usage card, opened by hovering: Esc closes it', async () => {
    render(<TopbarUsage />)
    const capsule = await screen.findByRole('button')
    lagReactTasks()
    fireEvent.mouseEnter(capsule)
    await waitFor(() => expect(document.querySelector('.tbu-pop')).not.toBeNull())
    expectReactTasksLagged()
    pressEsc()
    await Promise.resolve()
    expect(document.querySelector('.tbu-pop')).toBeNull()
  })
})
