// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import type { JSX } from 'react'
import type { ExtensionPermissionRequest } from '../../src/shared/types'
import type {
  BrowserDialog,
  BrowserDialogAnswer
} from '../../src/renderer/src/components/BrowserModal'

const { lagReactTasks, stopLaggingReactTasks, expectReactTasksLagged } =
  await import('./helpers/reactTaskLag')
const { useState } = await import('react')
const { render, cleanup, fireEvent, screen } = await import('@testing-library/react')
const { BrowserModal } = await import('../../src/renderer/src/components/BrowserModal')
const { ExtensionConfirm } = await import('../../src/renderer/src/components/ExtensionConfirm')

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
})
