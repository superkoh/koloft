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
    (box) => !box.contains(el) && box.checkVisibility?.() !== false
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
  const onceTheKeysSettle = (then: () => void): void => {
    clearTimeout(landing)
    landing = setTimeout(then)
  }

  let stopWaitingOnTheDialog: (() => void) | undefined
  const waitForTheDialogToClose = (): void => {
    stopWaitingOnTheDialog ??= watchTheDomUntil(
      () => !aDialogIsOpenOverEl(),
      () => {
        stopWaitingOnTheDialog = undefined
        onceTheKeysSettle(takeTheKeysIfFree)
      }
    )
  }
  const aDialogTookTheKeys = (): void => {
    if (aDialogIsOpen()) waitForTheDialogToClose()
  }

  let stopTakingThemBackFromTheTerminal = (): void => {}
  const takeThemBackWhenTheTerminalRefocuses = (covered: Element): void => {
    stopTakingThemBackFromTheTerminal()
    const takeThemBack = (): void => {
      stopTakingThemBackFromTheTerminal()
      el.focus()
    }
    const theOwnerActed = (): void => stopTakingThemBackFromTheTerminal()
    covered.addEventListener('focusin', takeThemBack)
    document.addEventListener('pointerdown', theOwnerActed, true)
    document.addEventListener('keydown', theOwnerActed, true)
    stopTakingThemBackFromTheTerminal = () => {
      covered.removeEventListener('focusin', takeThemBack)
      document.removeEventListener('pointerdown', theOwnerActed, true)
      document.removeEventListener('keydown', theOwnerActed, true)
    }
  }

  let stopWaitingOnTheField = (): void => {}
  const waitForTheOwnerToLeave = (field: HTMLElement): void => {
    const theOwnerLeftTheField = (): void =>
      onceTheKeysSettle(() => {
        if (document.activeElement === field) return
        stopWaitingOnTheField()
        takeTheKeysIfFree()
      })
    field.addEventListener('focusout', theOwnerLeftTheField)
    // PLATFORM§10
    document.addEventListener('pointerdown', theOwnerLeftTheField, true)
    const stopWatchingTheField = watchTheDomUntil(() => !field.isConnected, theOwnerLeftTheField)
    stopWaitingOnTheField = () => {
      field.removeEventListener('focusout', theOwnerLeftTheField)
      document.removeEventListener('pointerdown', theOwnerLeftTheField, true)
      stopWatchingTheField()
    }
  }

  const takeTheKeysIfFree = (): void => {
    if (aDialogIsOpenOverEl()) return waitForTheDialogToClose()
    const covered = theTerminalAnAskBoxCovered
    theTerminalAnAskBoxCovered = null
    if (
      keysWentNowhere() ||
      (covered && document.activeElement?.closest('.term-wrap') === covered)
    ) {
      el.focus()
      if (covered) takeThemBackWhenTheTerminalRefocuses(covered)
      return
    }
    const typing = covered && fieldTheOwnerTypesInOutsideTheTerminals()
    if (typing && typing !== el) waitForTheOwnerToLeave(typing)
  }

  const field = fieldTheOwnerTypesInOutsideTheTerminals()
  if (aDialogIsOpenOverEl()) waitForTheDialogToClose()
  else if (field && field !== el) waitForTheOwnerToLeave(field)
  else el.focus()
  document.addEventListener('focusin', aDialogTookTheKeys)
  return () => {
    clearTimeout(landing)
    stopWaitingOnTheDialog?.()
    stopWaitingOnTheField()
    stopTakingThemBackFromTheTerminal()
    document.removeEventListener('focusin', aDialogTookTheKeys)
  }
}
