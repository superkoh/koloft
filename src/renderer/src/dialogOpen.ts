export function aDialogIsOpen(): boolean {
  return !!document.querySelector('.modal-backdrop:not(.in-session), .bmodal-backdrop')
}

export function focusOnceNoDialogIsOpen(el: HTMLElement): () => void {
  if (!aDialogIsOpen()) {
    el.focus()
    return () => {}
  }
  const watch = new MutationObserver(() => {
    if (aDialogIsOpen()) return
    watch.disconnect()
    el.focus()
  })
  watch.observe(document.body, { childList: true, subtree: true })
  return () => watch.disconnect()
}
