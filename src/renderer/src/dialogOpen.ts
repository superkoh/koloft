export function aDialogIsOpen(): boolean {
  return !!document.querySelector('.modal-backdrop:not(.in-session), .bmodal-backdrop')
}

const underAnAskBox = (at: Element): boolean =>
  !at.closest('.modal-backdrop.in-session') &&
  !!at.closest('.term-wrap')?.querySelector(':scope > .modal-backdrop.in-session')

const keysWentNowhere = (): boolean =>
  !document.activeElement ||
  document.activeElement === document.body ||
  underAnAskBox(document.activeElement)

const keysAreInATerminal = (at: Element): boolean =>
  !at.closest('.modal-backdrop.in-session') && !!at.closest('.term-wrap')

const A_FIELD_THE_OWNER_TYPES_IN =
  'textarea, select, webview, input:not([type=checkbox], [type=radio], [type=button], [type=range], [type=submit], [type=reset], [type=image], [type=file], [type=color], [type=hidden])'

function fieldTheOwnerTypesInOutsideTheTerminals(): HTMLElement | null {
  const at = document.activeElement
  if (!(at instanceof HTMLElement) || keysAreInATerminal(at)) return null
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

const anotherAskBoxOnScreen = (el: HTMLElement): HTMLElement | undefined =>
  [...document.querySelectorAll<HTMLElement>('.modal-backdrop.in-session')].find(
    (box) => !box.contains(el) && box.checkVisibility?.({ visibilityProperty: true }) !== false
  )

export function focusOnceNoDialogIsOpen(el: HTMLElement): () => void {
  let theTerminalAnAskBoxCovered: Element | null = null
  const aDialogIsOpenOverEl = (): boolean => {
    const box = anotherAskBoxOnScreen(el)
    if (box) theTerminalAnAskBoxCovered = box.closest('.term-wrap')
    else if (aDialogIsOpen()) theTerminalAnAskBoxCovered = null
    else return false
    return true
  }
  let landing: ReturnType<typeof setTimeout> | undefined
  let frame = 0
  const onceTheKeysSettle = (then: () => void): void => {
    clearTimeout(landing)
    landing = setTimeout(then)
  }
  const onceTheCoveredTerminalTookTheKeysBack = (then: () => void): void => {
    cancelAnimationFrame(frame)
    frame = requestAnimationFrame(() => (frame = requestAnimationFrame(then)))
  }

  let stopWaitingOnTheDialog: (() => void) | undefined
  const waitForTheDialogToClose = (): void => {
    stopWaitingOnTheDialog ??= watchTheDomUntil(
      () => !aDialogIsOpenOverEl(),
      () => {
        stopWaitingOnTheDialog = undefined
        if (theTerminalAnAskBoxCovered) onceTheCoveredTerminalTookTheKeysBack(takeTheKeysIfFree)
        else onceTheKeysSettle(takeTheKeysIfFree)
      }
    )
  }
  const takeTheKeysIfFree = (): void => {
    if (aDialogIsOpenOverEl()) return waitForTheDialogToClose()
    const covered = theTerminalAnAskBoxCovered
    theTerminalAnAskBoxCovered = null
    const keysAreInTheTerminalItCovered =
      !!covered && document.activeElement?.closest('.term-wrap') === covered
    if (keysWentNowhere() || keysAreInTheTerminalItCovered) el.focus()
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

  if (aDialogIsOpenOverEl()) waitForTheDialogToClose()
  else if (field && field !== el) {
    field.addEventListener('focusout', theOwnerLeftTheField)
    // PLATFORM§10
    document.addEventListener('pointerdown', theOwnerLeftTheField, true)
    stopWatchingTheField = watchTheDomUntil(() => !field.isConnected, theOwnerLeftTheField)
  } else el.focus()
  document.addEventListener('focusin', aDialogTookTheKeys)
  return () => {
    clearTimeout(landing)
    cancelAnimationFrame(frame)
    stopWaitingOnTheDialog?.()
    stopWaitingOnTheField()
    document.removeEventListener('focusin', aDialogTookTheKeys)
  }
}
