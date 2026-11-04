// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { useState } from 'react'
import type {
  BrowserDialog,
  BrowserDialogAnswer
} from '../../src/renderer/src/components/BrowserModal'

const { lagReactTasks, stopLaggingReactTasks, expectReactTasksLagged } =
  await import('./helpers/reactTaskLag')
const { render, cleanup, fireEvent, screen } = await import('@testing-library/react')
const { BrowserModal } = await import('../../src/renderer/src/components/BrowserModal')

afterEach(() => {
  stopLaggingReactTasks()
  cleanup()
})

let challenge: (d: BrowserDialog) => void = () => {}
const answers: [string, BrowserDialogAnswer][] = []

function Host() {
  const [dialog, setDialog] = useState<BrowserDialog | null>(null)
  challenge = setDialog
  return (
    <>
      <textarea aria-label="terminal" />
      {dialog && <BrowserModal dialog={dialog} onAnswer={(id, a) => answers.push([id, a])} />}
    </>
  )
}

describe('BrowserModal opened by a sign-in request from the page', () => {
  it('takes the keys pressed the moment it shows: the cursor is already in Username, and Esc cancels it, even while React’s effects still lag the screen', async () => {
    render(<Host />)
    screen.getByRole('textbox', { name: 'terminal' }).focus()
    lagReactTasks()
    await Promise.resolve().then(() =>
      challenge({ id: 'auth-1', kind: 'auth', origin: 'https://site.test' })
    )
    const username = await screen.findByPlaceholderText('Username')
    expectReactTasksLagged()
    expect(document.activeElement).toBe(username)
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(answers).toEqual([['auth-1', { ok: false }]])
  })
})
