// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup, fireEvent, screen } from '@testing-library/react'
import {
  BrowserModal,
  type BrowserDialog,
  type BrowserDialogAnswer
} from '../../src/renderer/src/components/BrowserModal'

const answers: [string, BrowserDialogAnswer][] = []
const undo: (() => void)[] = []

afterEach(() => {
  cleanup()
  answers.length = 0
  for (const u of undo.splice(0)) u()
})

function showBesideATerminalThatStopsKeys(dialog: BrowserDialog): HTMLTextAreaElement {
  render(
    <>
      <textarea aria-label="terminal" onKeyDown={(e) => e.stopPropagation()} />
      <BrowserModal dialog={dialog} onAnswer={(id, a) => answers.push([id, a])} />
    </>
  )
  const terminal = screen.getByRole('textbox', { name: 'terminal' })
  return terminal as HTMLTextAreaElement
}

function listenPastTheDialog(): string[] {
  const heard: string[] = []
  const onWindow = (e: KeyboardEvent): void => void heard.push(`window ${e.key}`)
  const onDocument = (e: KeyboardEvent): void => void heard.push(`document ${e.key}`)
  window.addEventListener('keydown', onWindow)
  document.addEventListener('keydown', onDocument, true)
  undo.push(() => {
    window.removeEventListener('keydown', onWindow)
    document.removeEventListener('keydown', onDocument, true)
  })
  return heard
}

describe('a page’s alert or confirm dialog takes Enter and Esc away from the session terminal', () => {
  it('an alert puts focus on OK, and a confirm on Cancel', () => {
    showBesideATerminalThatStopsKeys({
      id: 'a-1',
      kind: 'alert',
      origin: 'https://site.test',
      message: 'Hi'
    })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'OK' }))
    cleanup()
    showBesideATerminalThatStopsKeys({
      id: 'c-1',
      kind: 'confirm',
      origin: 'https://site.test',
      message: 'Sure?'
    })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }))
  })

  it('Esc pressed in a terminal that stops the key still cancels the dialog once', () => {
    const terminal = showBesideATerminalThatStopsKeys({
      id: 'c-2',
      kind: 'confirm',
      origin: 'https://site.test',
      message: 'Sure?'
    })
    terminal.focus()
    fireEvent.keyDown(terminal, { key: 'Escape' })
    expect(answers).toEqual([['c-2', { ok: false }]])
  })

  it('the Esc that cancels the dialog reaches nothing behind it, so the web overlay or a full Workbench stays open', () => {
    const heard = listenPastTheDialog()
    showBesideATerminalThatStopsKeys({
      id: 'a-2',
      kind: 'alert',
      origin: 'https://site.test',
      message: 'Hi'
    })
    fireEvent.keyDown(screen.getByRole('button', { name: 'OK' }), { key: 'Escape' })
    expect(answers).toEqual([['a-2', { ok: false }]])
    expect(heard).toEqual([])
  })

  it('Enter on a focused Cancel button never answers OK first', () => {
    showBesideATerminalThatStopsKeys({
      id: 'c-3',
      kind: 'confirm',
      origin: 'https://site.test',
      message: 'Sure?'
    })
    fireEvent.keyDown(screen.getByRole('button', { name: 'Cancel' }), { key: 'Enter' })
    expect(answers.filter(([, a]) => a.ok)).toEqual([])
  })

  it('once the dialog is answered, the keys go back to where they were before it showed', () => {
    const terminal = document.body.appendChild(document.createElement('textarea'))
    try {
      terminal.focus()
      const { unmount } = render(
        <BrowserModal
          dialog={{ id: 'c-4', kind: 'confirm', origin: 'https://site.test', message: 'Sure?' }}
          onAnswer={() => {}}
        />
      )
      expect(document.activeElement).not.toBe(terminal)
      unmount()
      expect(document.activeElement).toBe(terminal)
    } finally {
      terminal.remove()
    }
  })

  it('Enter in the sign-in fields still signs in', () => {
    showBesideATerminalThatStopsKeys({ id: 's-1', kind: 'auth', origin: 'https://site.test' })
    fireEvent.change(screen.getByPlaceholderText('Username'), { target: { value: 'me' } })
    fireEvent.keyDown(screen.getByPlaceholderText('Username'), { key: 'Enter' })
    expect(answers).toEqual([['s-1', { ok: true, username: 'me', password: '' }]])
  })
})
