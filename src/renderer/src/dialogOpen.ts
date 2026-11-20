export function aDialogIsOpen(): boolean {
  return !!document.querySelector('.modal-backdrop:not(.in-session), .bmodal-backdrop')
}

const keysWentNowhere = (): boolean =>
  !document.activeElement || document.activeElement === document.body

export function focusOnceNoDialogIsOpen(el: HTMLElement): () => void {
  if (!aDialogIsOpen()) {
    el.focus()
    return () => {}
  }
  const watch = new MutationObserver(() => {
    if (aDialogIsOpen()) return
    watch.disconnect()
    if (keysWentNowhere()) el.focus()
  })
  watch.observe(document.body, { childList: true, subtree: true })
  return () => watch.disconnect()
}
