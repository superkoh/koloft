export function aDialogIsOpen(): boolean {
  return !!document.querySelector('.modal-backdrop, .bmodal-backdrop')
}
