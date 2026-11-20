export function aDialogIsOpen(): boolean {
  return !!document.querySelector('.modal-backdrop:not(.in-session), .bmodal-backdrop')
}

const keysWentNowhere = (): boolean =>
  !document.activeElement || document.activeElement === document.body

const keysAreInATerminal = (): boolean => !!document.activeElement?.closest('.term-wrap')

const A_FIELD_THE_OWNER_TYPES_IN =
  'textarea, select, webview, input:not([type=checkbox], [type=radio], [type=button], [type=range], [type=submit], [type=reset], [type=image], [type=file], [type=color], [type=hidden])'

function fieldTheOwnerTypesInOutsideTheTerminals(): HTMLElement | null {
  const at = document.activeElement
  if (!(at instanceof HTMLElement) || keysAreInATerminal()) return null
  if (at.checkVisibility?.({ visibilityProperty: true }) === false) return null
  return at.matches(A_FIELD_THE_OWNER_TYPES_IN) || at.isContentEditable ? at : null
}

function watchTheDomUntil(done: () => boolean, then: () => void): () => void {
  const watch = new MutationObserver(() => {
    if (!done()) return
    watch.disconnect()
    then()
  })
  watch.observe(document.body, { childList: true, subtree: true })
  return () => watch.disconnect()
}

export function focusOnceNoDialogIsOpen(el: HTMLElement): () => void {
  const takeTheKeysIfFree = (): void => {
    if (!aDialogIsOpen() && (keysWentNowhere() || keysAreInATerminal())) el.focus()
  }
  let landing: ReturnType<typeof setTimeout> | undefined
  const onceTheKeysSettle = (then: () => void): void => {
    clearTimeout(landing)
    landing = setTimeout(then)
  }

  let stopWaitingOnTheDialog: (() => void) | undefined
  const waitForTheDialogToClose = (): void => {
    stopWaitingOnTheDialog ??= watchTheDomUntil(
      () => !aDialogIsOpen(),
      () => {
        stopWaitingOnTheDialog = undefined
        onceTheKeysSettle(takeTheKeysIfFree)
      }
    )
  }
  const aDialogTookTheKeys = (): void => {
    if (aDialogIsOpen()) waitForTheDialogToClose()
  }

  const field = fieldTheOwnerTypesInOutsideTheTerminals()
  let stopWatchingTheField = (): void => {}
  const theOwnerLeftTheField = (): void =>
    onceTheKeysSettle(() => {
      if (document.activeElement === field) return
      stopWaitingOnTheField()
      takeTheKeysIfFree()
    })
  const stopWaitingOnTheField = (): void => {
    field?.removeEventListener('focusout', theOwnerLeftTheField)
    document.removeEventListener('pointerdown', theOwnerLeftTheField, true)
    stopWatchingTheField()
  }

  if (aDialogIsOpen()) waitForTheDialogToClose()
  else if (field) {
    field.addEventListener('focusout', theOwnerLeftTheField)
    // PLATFORM§10
    document.addEventListener('pointerdown', theOwnerLeftTheField, true)
    stopWatchingTheField = watchTheDomUntil(() => !field.isConnected, theOwnerLeftTheField)
  } else el.focus()
  document.addEventListener('focusin', aDialogTookTheKeys)
  return () => {
    clearTimeout(landing)
    stopWaitingOnTheDialog?.()
    stopWaitingOnTheField()
    document.removeEventListener('focusin', aDialogTookTheKeys)
  }
}
