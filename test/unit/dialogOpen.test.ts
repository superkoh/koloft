// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { focusOnceNoDialogIsOpen } from '../../src/renderer/src/dialogOpen'

function button(): HTMLButtonElement {
  const b = document.createElement('button')
  document.body.append(b)
  return b
}

function dialogWithAField(): { backdrop: HTMLElement; field: HTMLTextAreaElement } {
  const backdrop = document.createElement('div')
  backdrop.className = 'modal-backdrop'
  const field = document.createElement('textarea')
  backdrop.append(field)
  document.body.append(backdrop)
  field.focus()
  return { backdrop, field }
}

function terminalUnderAnAskBox(): { terminalInput: HTMLTextAreaElement; field: HTMLInputElement } {
  const wrap = document.createElement('div')
  wrap.className = 'term-wrap'
  const terminalInput = document.createElement('textarea')
  const askBox = document.createElement('div')
  askBox.className = 'modal-backdrop in-session'
  const field = document.createElement('input')
  askBox.append(field)
  wrap.append(terminalInput, askBox)
  document.body.append(wrap)
  return { terminalInput, field }
}

const domSettled = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

afterEach(() => document.body.replaceChildren())

describe('focusOnceNoDialogIsOpen', () => {
  it('leaves the keys in a dialog open over the element, and moves them to the element once that dialog closes', async () => {
    const keep = button()
    const { backdrop, field } = dialogWithAField()
    focusOnceNoDialogIsOpen(keep)
    await domSettled()
    expect(document.activeElement).toBe(field)
    backdrop.remove()
    await domSettled()
    expect(document.activeElement).toBe(keep)
  })

  it('once given up, as when its tab is no longer on screen, takes no keys when the dialog closes', async () => {
    const keep = button()
    const { backdrop } = dialogWithAField()
    const giveUp = focusOnceNoDialogIsOpen(keep)
    giveUp()
    backdrop.remove()
    await domSettled()
    expect(document.activeElement).not.toBe(keep)
  })

  it('takes the keys when closing the dialog puts them back on a terminal an ask box covers, where the owner cannot see them land', async () => {
    const { terminalInput, field } = terminalUnderAnAskBox()
    const { backdrop } = dialogWithAField()
    focusOnceNoDialogIsOpen(field)
    backdrop.remove()
    terminalInput.focus()
    await domSettled()
    expect(document.activeElement).toBe(field)
  })

  it('of two elements waiting behind one dialog, the second leaves the keys in the ask box field the first gave them to', async () => {
    const { field } = terminalUnderAnAskBox()
    const page = button()
    const { backdrop } = dialogWithAField()
    focusOnceNoDialogIsOpen(field)
    focusOnceNoDialogIsOpen(page)
    backdrop.remove()
    await domSettled()
    expect(document.activeElement).toBe(field)
  })

  it('leaves the keys where closing the dialog put them', async () => {
    const keep = button()
    const elsewhere = button()
    const { backdrop } = dialogWithAField()
    focusOnceNoDialogIsOpen(keep)
    elsewhere.focus()
    backdrop.remove()
    await domSettled()
    expect(document.activeElement).toBe(elsewhere)
  })
})
