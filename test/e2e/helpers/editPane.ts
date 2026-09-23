import type { ElectronApplication, Locator, Page } from '@playwright/test'
import { expect, quitAndClose } from './app'

export const EDIT = {
  showIgnored: 'button.ft-chip[data-chip="show-ignored"]',
  ignoredRow: '.ft-node.ignored',
  ignoredTitle: 'Ignored by .gitignore',
  hiddenByDefaultTitle: 'Hidden by default — shown because "Show ignored files" is on',

  tabEdit: '.wb-bar:not(.fv-artifact-hd) .icobtn.wb-edit[aria-label="Edit"]',
  readEdit: '.wb-bar.fv-artifact-hd .icobtn.wb-edit[aria-label="Edit"]',

  pane: '.wb-col .wb-edit-pane',
  area: '.wb-col .wb-edit-pane textarea.ed-area:visible',
  status: '.wb-col .wb-edit-pane .ed-status',
  pos: '.wb-col .wb-edit-pane .ed-status .ed-pos',
  eol: '.wb-col .wb-edit-pane .ed-status .ed-eol',
  dirty: '.wb-col .wb-edit-pane .ed-status .ed-dirty',
  readOnly: '.ed-ro',

  tabDirty: '.wb-tab .dirty',

  stale: '.fp-stale.ed-stale',
  staleText: 'Changed on disk',
  conflict: '.ed-conflict',

  unsavedModal: '.modal.unsaved-modal',
  sessionModal: '.modal.lifecycle-modal',
  sessionModalTitle: 'Close running session?',

  newFileInput: 'input.ft-newfile',

  ctxMenu: '.ft-ctx[role="menu"]',
  ctxItem: '.ft-ctx .ft-ctx-it'
} as const

export const showIgnoredKey = (root: string): string => 'koloft.ft.showIgnored:' + root

export async function sendSave(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send('shortcut:save')
  })
}

export async function saveMenuEnabled(app: ElectronApplication): Promise<boolean | null> {
  return app.evaluate(({ Menu }) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById('save')
    return item ? item.enabled : null
  })
}

export async function closeDiscardingEdits(app: ElectronApplication): Promise<void> {
  await quitAndClose(app)
}

export const editArea = (page: Page): Locator => page.locator(EDIT.area)

export async function editText(page: Page): Promise<string> {
  return editArea(page).inputValue()
}

export async function typeAtEnd(page: Page, text: string): Promise<void> {
  const area = editArea(page)
  await area.click()
  await area.evaluate((el) => {
    const t = el as HTMLTextAreaElement
    t.setSelectionRange(t.value.length, t.value.length)
  })
  await page.keyboard.type(text)
}

export async function editReady(page: Page, contains: string): Promise<void> {
  await expect(editArea(page)).toBeVisible({ timeout: 25_000 })
  await expect(editArea(page)).toHaveValue(
    new RegExp(contains.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    {
      timeout: 20_000
    }
  )
}
