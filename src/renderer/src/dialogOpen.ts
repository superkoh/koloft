export function aDialogIsOpen(): boolean {
  return !!document.querySelector('.modal-backdrop:not(.in-session), .bmodal-backdrop')
}

const keysWentNowhere = (): boolean =>
  !document.activeElement || document.activeElement === document.body

const A_FIELD_THE_OWNER_TYPES_IN =
  'textarea, select, input:not([type=checkbox], [type=radio], [type=button], [type=range]), webview'

function fieldTheOwnerTypesInOutsideTheTerminals(): HTMLElement | null {
  const at = document.activeElement
  if (!(at instanceof HTMLElement) || at.closest('.term-wrap')) return null
  return at.matches(A_FIELD_THE_OWNER_TYPES_IN) || at.isContentEditable ? at : null
}

export function focusOnceNoDialogIsOpen(el: HTMLElement): () => void {
  const takeTheKeysIfTheyWentNowhere = (): void => {
    if (!aDialogIsOpen() && keysWentNowhere()) el.focus()
  }

  let dialogWatch: MutationObserver | undefined
  const waitForTheDialogToClose = (): void => {
    if (dialogWatch) return
    const watch = new MutationObserver(() => {
      if (aDialogIsOpen()) return
      watch.disconnect()
      dialogWatch = undefined
      takeTheKeysIfTheyWentNowhere()
    })
    dialogWatch = watch
    watch.observe(document.body, { childList: true, subtree: true })
  }
  const aDialogTookTheKeys = (): void => {
    if (aDialogIsOpen()) waitForTheDialogToClose()
  }

  const field = fieldTheOwnerTypesInOutsideTheTerminals()
  let landing: ReturnType<typeof setTimeout> | undefined
  const afterTheFieldLetsGo = (): void => {
    clearTimeout(landing)
    landing = setTimeout(() => {
      if (document.activeElement === field) return
      field?.removeEventListener('focusout', afterTheFieldLetsGo)
      takeTheKeysIfTheyWentNowhere()
    })
  }

  if (aDialogIsOpen()) waitForTheDialogToClose()
  else if (field) field.addEventListener('focusout', afterTheFieldLetsGo)
  else el.focus()
  document.addEventListener('focusin', aDialogTookTheKeys)
  return () => {
    clearTimeout(landing)
    dialogWatch?.disconnect()
    field?.removeEventListener('focusout', afterTheFieldLetsGo)
    document.removeEventListener('focusin', aDialogTookTheKeys)
  }
}
