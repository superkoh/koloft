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
