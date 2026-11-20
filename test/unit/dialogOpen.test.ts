// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { focusOnceNoDialogIsOpen } from '../../src/renderer/src/dialogOpen'

function button(): HTMLButtonElement {
  const b = document.createElement('button')
  document.body.append(b)
  return b
}

function focused<E extends HTMLElement>(el: E): E {
  document.body.append(el)
  el.focus()
  return el
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

const aTick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
const domSettled = async (): Promise<void> => {
  await aTick()
  await aTick()
}

const givingUp: (() => void)[] = []
function focusOnce(el: HTMLElement): () => void {
  const giveUp = focusOnceNoDialogIsOpen(el)
  givingUp.push(giveUp)
  return giveUp
}

afterEach(() => {
  for (const giveUp of givingUp.splice(0)) giveUp()
  document.body.replaceChildren()
})

describe('focusOnceNoDialogIsOpen', () => {
  it('leaves the keys in a dialog open over the element, and moves them to the element once that dialog closes', async () => {
    const keep = button()
    const { backdrop, field } = dialogWithAField()
    focusOnce(keep)
    await domSettled()
    expect(document.activeElement).toBe(field)
    backdrop.remove()
    await domSettled()
    expect(document.activeElement).toBe(keep)
  })

  it('once given up, as when its tab is no longer on screen, takes no keys when the dialog closes', async () => {
    const keep = button()
    const { backdrop } = dialogWithAField()
    const giveUp = focusOnce(keep)
    giveUp()
    backdrop.remove()
    await domSettled()
    expect(document.activeElement).not.toBe(keep)
  })

  it('leaves the keys in a field the owner types in outside any dialog, and takes them once the owner leaves it', async () => {
    const note = focused(document.createElement('textarea'))
    const keep = button()
    focusOnce(keep)
    await domSettled()
    expect(document.activeElement).toBe(note)
    note.blur()
    await domSettled()
    expect(document.activeElement).toBe(keep)
  })

  it('takes the keys once the field the owner types in is taken off the page', async () => {
    const page = focused(document.createElement('textarea'))
    const keep = button()
    focusOnce(keep)
    page.remove()
    await domSettled()
    expect(document.activeElement).toBe(keep)
  })

  it('waits on nothing when the field the owner types in is the element itself, so leaving it later does not pull the keys back', async () => {
    const page = focused(document.createElement('textarea'))
    focusOnce(page)
    page.blur()
    await domSettled()
    expect(document.activeElement).toBe(document.body)
  })

  it('takes the keys from a checkbox, which is not a field the owner types in', () => {
    const box = document.createElement('input')
    box.type = 'checkbox'
    focused(box)
    const keep = button()
    focusOnce(keep)
    expect(document.activeElement).toBe(keep)
  })

  it("takes the keys from a session's terminal, its own or the one just switched away from", () => {
    for (const sameTab of [true, false]) {
      const wrap = document.createElement('div')
      wrap.className = 'term-wrap'
      const terminal = document.createElement('textarea')
      wrap.append(terminal)
      document.body.append(wrap)
      const keep = sameTab ? wrap.appendChild(document.createElement('button')) : button()
      terminal.focus()
      focusOnce(keep)
      expect(document.activeElement).toBe(keep)
    }
  })

  it('takes the keys only once: focus the owner later moves to nowhere stays nowhere', async () => {
    const keep = button()
    focusOnce(keep)
    const elsewhere = button()
    elsewhere.focus()
    elsewhere.blur()
    elsewhere.remove()
    await domSettled()
    expect(document.activeElement).toBe(document.body)
  })

  it('takes the keys back when a dialog opened after it closes', async () => {
    const keep = button()
    focusOnce(keep)
    const { backdrop, field } = dialogWithAField()
    await domSettled()
    expect(document.activeElement).toBe(field)
    backdrop.remove()
    await domSettled()
    expect(document.activeElement).toBe(keep)
  })

  it('takes the keys when closing the dialog puts them back on a terminal an ask box covers, where the owner cannot see them land', async () => {
    const { terminalInput, field } = terminalUnderAnAskBox()
    const { backdrop } = dialogWithAField()
    focusOnce(field)
    backdrop.remove()
    terminalInput.focus()
    await domSettled()
    expect(document.activeElement).toBe(field)
  })

  it('of two elements waiting behind one dialog, the second leaves the keys in the ask box field the first gave them to', async () => {
    const { field } = terminalUnderAnAskBox()
    const page = button()
    const { backdrop } = dialogWithAField()
    focusOnce(field)
    focusOnce(page)
    backdrop.remove()
    await domSettled()
    expect(document.activeElement).toBe(field)
  })

  it('of two elements waiting behind one dialog, the ask box field takes the keys even when the other began waiting first', async () => {
    const { field } = terminalUnderAnAskBox()
    const page = button()
    const { backdrop } = dialogWithAField()
    focusOnce(page)
    focusOnce(field)
    backdrop.remove()
    await domSettled()
    expect(document.activeElement).toBe(field)
  })

  it('leaves the keys in an ask box field the owner types in while the box is on screen, and takes them once the box is gone, even when the terminal it covered takes them first or later', async () => {
    for (const terminalRefocuses of ['first', 'later'] as const) {
      const { terminalInput, field } = terminalUnderAnAskBox()
      field.focus()
      const page = button()
      focusOnce(page)
      await domSettled()
      expect(document.activeElement).toBe(field)
      field.closest('.modal-backdrop')!.remove()
      if (terminalRefocuses === 'first') terminalInput.focus()
      await domSettled()
      expect(document.activeElement).toBe(page)
      terminalInput.focus()
      expect(document.activeElement).toBe(page)
      document.body.replaceChildren()
    }
  })

  it('leaves the keys in the terminal the owner clicks into once the page took them from it', async () => {
    const { terminalInput, field } = terminalUnderAnAskBox()
    field.focus()
    const page = button()
    focusOnce(page)
    field.closest('.modal-backdrop')!.remove()
    await domSettled()
    expect(document.activeElement).toBe(page)
    terminalInput.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    terminalInput.focus()
    expect(document.activeElement).toBe(terminalInput)
  })

  it('waits for the owner to leave the field they type in when the ask box goes, and takes the keys then', async () => {
    terminalUnderAnAskBox()
    const note = focused(document.createElement('textarea'))
    const page = button()
    focusOnce(page)
    document.querySelector('.modal-backdrop.in-session')!.remove()
    await domSettled()
    expect(document.activeElement).toBe(note)
    note.blur()
    await domSettled()
    expect(document.activeElement).toBe(page)
  })

  it('leaves the keys in the terminal of another session that took them as the ask box went', async () => {
    const { field } = terminalUnderAnAskBox()
    field.focus()
    const page = button()
    focusOnce(page)
    const other = terminalUnderAnAskBox()
    other.field.closest('.modal-backdrop')!.remove()
    field.closest('.modal-backdrop')!.remove()
    other.terminalInput.focus()
    await domSettled()
    expect(document.activeElement).toBe(other.terminalInput)
  })

  it('leaves the keys in the terminal a dialog closing put them on, when the ask box went while the dialog was open', async () => {
    const { terminalInput, field } = terminalUnderAnAskBox()
    field.focus()
    const page = button()
    focusOnce(page)
    const { backdrop } = dialogWithAField()
    field.closest('.modal-backdrop')!.remove()
    await domSettled()
    backdrop.remove()
    terminalInput.focus()
    await domSettled()
    expect(document.activeElement).toBe(terminalInput)
  })

  it('leaves the keys in a terminal the owner went to after a dialog closed, when no ask box held it back', async () => {
    const wrap = document.createElement('div')
    wrap.className = 'term-wrap'
    const terminal = wrap.appendChild(document.createElement('textarea'))
    document.body.append(wrap)
    const page = button()
    const { backdrop } = dialogWithAField()
    focusOnce(page)
    backdrop.remove()
    terminal.focus()
    await domSettled()
    expect(document.activeElement).toBe(terminal)
  })

  it('is not held back by an ask box that is not on screen', () => {
    const { field } = terminalUnderAnAskBox()
    const box = field.closest<HTMLElement>('.modal-backdrop')!
    box.checkVisibility = () => false
    const page = button()
    focusOnce(page)
    expect(document.activeElement).toBe(page)
  })

  it('leaves the keys where closing the dialog put them', async () => {
    const keep = button()
    const elsewhere = button()
    const { backdrop } = dialogWithAField()
    focusOnce(keep)
    elsewhere.focus()
    backdrop.remove()
    await domSettled()
    expect(document.activeElement).toBe(elsewhere)
  })
})
