export function aDialogIsOpen(): boolean {
  return !!document.querySelector('.modal-backdrop:not(.in-session), .bmodal-backdrop')
}

const keysWentNowhere = (): boolean =>
  !document.activeElement || document.activeElement === document.body

function ownerTypesOutside(own: Element): boolean {
  const at = document.activeElement
  if (!(at instanceof HTMLElement) || own.contains(at)) return false
  return (
    at instanceof HTMLInputElement ||
    at instanceof HTMLTextAreaElement ||
    at.isContentEditable ||
    at.tagName === 'WEBVIEW'
  )
}

export function focusOnceNoDialogIsOpen(el: HTMLElement): () => void {
  const own = el.closest('.term-wrap') ?? el
  if (!aDialogIsOpen() && !ownerTypesOutside(own)) el.focus()
  const takeTheKeysIfFree = (): void => {
    if (!aDialogIsOpen() && keysWentNowhere()) el.focus()
  }
  const watch = new MutationObserver(takeTheKeysIfFree)
  watch.observe(document.body, { childList: true, subtree: true })
  let landing: ReturnType<typeof setTimeout> | undefined
  const afterTheKeysLeave = (): void => {
    landing = setTimeout(takeTheKeysIfFree)
  }
  document.addEventListener('focusout', afterTheKeysLeave)
  return () => {
    clearTimeout(landing)
    watch.disconnect()
    document.removeEventListener('focusout', afterTheKeysLeave)
  }
}
