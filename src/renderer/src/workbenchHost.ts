import { useSyncExternalStore } from 'react'
import { WORKBENCH_WINDOW_NAME } from '@shared/types'

export type HostWindow = Window & typeof globalThis

const host = document.createElement('div')
host.className = 'wb-host-root'

let auxFocused = false
let headMirror: MutationObserver | null = null
const moveListeners = new Set<(win: HostWindow) => void>()
const focusListeners = new Set<() => void>()

export function workbenchHost(): HTMLDivElement {
  return host
}

export function workbenchDoc(): Document {
  return host.ownerDocument
}

export function windowOf(node: Node | null | undefined): HostWindow {
  return (node?.ownerDocument?.defaultView as HostWindow | null | undefined) ?? window
}

export function querySelectorAnywhere(selector: string): Element | null {
  const found = document.querySelector(selector)
  if (found || !workbenchPopped()) return found
  return workbenchDoc().querySelector(selector)
}

export function workbenchPopped(): boolean {
  return host.ownerDocument !== document
}

export function setWorkbenchWindowFocused(focused: boolean): void {
  if (auxFocused === focused) return
  auxFocused = focused
  for (const cb of [...focusListeners]) cb()
}

export function workbenchHasKeyboard(): boolean {
  return !workbenchPopped() || auxFocused
}

function onFocusChange(cb: () => void): () => void {
  focusListeners.add(cb)
  return () => focusListeners.delete(cb)
}

export function useFocusedDocument(): Document {
  const inWorkbenchWindow = useSyncExternalStore(
    onFocusChange,
    () => auxFocused && workbenchPopped()
  )
  return inWorkbenchWindow ? workbenchDoc() : document
}

export function onWorkbenchMoved(cb: (win: HostWindow) => void): () => void {
  moveListeners.add(cb)
  return () => moveListeners.delete(cb)
}

let moves = 0

export function useWorkbenchMoves(): number {
  return useSyncExternalStore(onWorkbenchMoved, () => moves)
}

export function placeWorkbench(slot: HTMLElement): void {
  if (host.parentElement === slot) return
  const from = host.ownerDocument
  slot.appendChild(host)
  if (host.ownerDocument === from) return
  moves++
  const win = windowOf(host)
  for (const cb of [...moveListeners]) cb(win)
}

function copyStyles(into: Document): void {
  for (const old of into.head.querySelectorAll('[data-koloft-copy]')) old.remove()
  for (const node of document.head.querySelectorAll('style, link[rel="stylesheet"]')) {
    const copy = into.importNode(node, true) as HTMLElement
    copy.setAttribute('data-koloft-copy', '')
    into.head.appendChild(copy)
  }
}

export interface WorkbenchWindow {
  win: HostWindow
  shell: HTMLDivElement
  column: HTMLDivElement
}

// PLATFORM§41
export function openWorkbenchWindow(): WorkbenchWindow | null {
  const opened = window.open('about:blank', WORKBENCH_WINDOW_NAME) as HostWindow | null
  if (!opened) return null
  const doc = opened.document
  doc.title = 'Workbench'
  doc.documentElement.lang = document.documentElement.lang
  copyStyles(doc)
  headMirror?.disconnect()
  headMirror = new MutationObserver(() => copyStyles(doc))
  headMirror.observe(document.head, { childList: true, subtree: true, characterData: true })
  const shell = doc.createElement('div')
  shell.className = 'wb-aux'
  const bar = doc.createElement('div')
  bar.className = 'wb-aux-bar'
  const column = doc.createElement('div')
  column.className = 'island wb-col full'
  shell.append(bar, column)
  doc.body.replaceChildren(shell)
  placeWorkbench(column)
  return { win: opened, shell, column }
}

export function forgetWorkbenchWindow(): void {
  headMirror?.disconnect()
  headMirror = null
  setWorkbenchWindowFocused(false)
}
