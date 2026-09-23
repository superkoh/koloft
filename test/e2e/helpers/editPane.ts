import type { ElectronApplication, Locator, Page } from '@playwright/test'
import { expect, quitAndClose } from './app'

/**
 * The in-panel editor's markup contract, in one place — same rule helpers/workbench.ts is
 * written under: every selector is ONE constant, so a rename is one edit rather than a
 * hunt through five spec files. CORRECT THESE HERE, not in a spec.
 *
 * Two scoping traps are baked into the constants below, both measured against the panel
 * that already ships:
 *  - the reading area's header and a `file` tab's kind bar are BOTH `.wb-bar` (FilesView
 *    renders `<div className="wb-bar fv-artifact-hd">`), so a bare `.wb-bar .wb-edit`
 *    matches two different ✎ buttons the moment Browse has a file on screen. `tabEdit`
 *    and `readEdit` say which one they mean.
 *  - every VISITED file tab keeps a resident, `visibility:hidden` node that still has an
 *    `offsetParent` — the trap `artifactBody()` exists for — so the textarea locator is
 *    `:visible`. Never put `:visible` inside a `page.evaluate`: it reaches
 *    `document.querySelector` as a CSS syntax error.
 */
export const EDIT = {
  /** A-01 — the Browse tree's own switch. The `[data-chip]` half is load-bearing: since the
   *  Filter menu landed, a bare `.ft-chip` also matches its Status/Ownership/Type chips
   *  (test/CLAUDE.md), and each of those groups carries an `on` of its own. */
  showIgnored: 'button.ft-chip[data-chip="show-ignored"]',
  /** A-02 — a row the switch revealed */
  ignoredRow: '.ft-node.ignored',
  ignoredTitle: 'Ignored by .gitignore',
  /** the hidden-by-default names (node_modules, .git) say why they were hidden instead */
  hiddenByDefaultTitle: 'Hidden by default — shown because "Show ignored files" is on',

  /** B-01 — the ✎ on a `file` tab's kind bar (the bar that is NOT the reading area's) */
  tabEdit: '.wb-bar:not(.fv-artifact-hd) .icobtn.wb-edit[aria-label="Edit"]',
  /** B-02 — the ✎ in Browse's reading area, which PROMOTES the file to its own tab */
  readEdit: '.wb-bar.fv-artifact-hd .icobtn.wb-edit[aria-label="Edit"]',

  /** B-07 — the editor itself. Scoped to the Workbench column: the workspace
   *  note in the left dock is the SAME pane component, so a bare `.wb-edit-pane` matches
   *  two boxes on screen and every locator here goes strict-mode. */
  pane: '.wb-col .wb-edit-pane',
  area: '.wb-col .wb-edit-pane textarea.ed-area:visible',
  /** B-10 — the status strip and its three fields */
  status: '.wb-col .wb-edit-pane .ed-status',
  pos: '.wb-col .wb-edit-pane .ed-status .ed-pos',
  eol: '.wb-col .wb-edit-pane .ed-status .ed-eol',
  dirty: '.wb-col .wb-edit-pane .ed-status .ed-dirty',
  /** B-04/B-05 — the yellow "you may read this but not change it" band */
  readOnly: '.ed-ro',

  /** B-24 — a tab carrying unsaved work */
  tabDirty: '.wb-tab .dirty',

  /** B-20 — the conflict strip and the two things it offers */
  stale: '.fp-stale.ed-stale',
  staleText: 'Changed on disk',
  /** B-21 — the diff view "Show diff" opens, and the override that lives inside it */
  conflict: '.ed-conflict',

  /** B-24 — the close guard */
  unsavedModal: '.modal.unsaved-modal',
  /** B-25 — the ONE question a session that is running AND holding unsaved files asks:
   *  D3's own dialog grown a third button, never a second dialog behind the first */
  sessionModal: '.modal.lifecycle-modal',
  sessionModalTitle: 'Close running session?',

  /** B-06 — the inline name box a folder's "New File…" opens */
  newFileInput: 'input.ft-newfile',

  /** the row context menu (portalled to the body — root it at the PAGE, never at the panel) */
  ctxMenu: '.ft-ctx[role="menu"]',
  ctxItem: '.ft-ctx .ft-ctx-it'
} as const

/** A-05 — the per-checkout switch slot, spelled exactly as `filesModel.showIgnoredKey`. */
export const showIgnoredKey = (root: string): string => 'koloft.ft.showIgnored:' + root

/**
 * B-16 — ⌘S, driven the way test/CLAUDE.md requires: a native accelerator is unreachable
 * from Playwright's synthetic keys, so the spec sends the same IPC the menu item forwards.
 * The channel name is the contract (`shortcut:save`, menu item id `save`).
 */
export async function sendSave(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send('shortcut:save')
  })
}

/** Whether the File menu's own Save item is live — B-16's "availability follows the dirty
 *  flag" half, which the IPC route above deliberately bypasses. */
export async function saveMenuEnabled(app: ElectronApplication): Promise<boolean | null> {
  return app.evaluate(({ Menu }) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById('save')
    return item ? item.enabled : null
  })
}

/**
 * B-26 — how a spec that has been typing must end. THE LAST ACTION IN THE TEST: nothing
 * may follow it, because it does not pre-approve a later quit, it quits right now.
 *
 * Playwright's `app.close()` IS the quit, and the quit guard answers it by putting the
 * unsaved question up and telling main to stand down — `app:quit-held` clears the
 * five-second silence timer too, so nothing ever times out. Nobody presses a button, and
 * the run does not fail: it hangs. What this sends instead is the approval the renderer
 * sends after Discard, which is the product's own channel rather than a test branch.
 *
 * The mechanics live in `quitAndClose` (helpers/app.ts), which the `app` fixture's own
 * teardown also runs — so a test that FAILS mid-edit is covered too, and this call is what
 * covers the passing path and any app a spec launched for itself (a relaunch, whose
 * ElectronApplication the fixture never sees).
 */
export async function closeDiscardingEdits(app: ElectronApplication): Promise<void> {
  await quitAndClose(app)
}

export const editArea = (page: Page): Locator => page.locator(EDIT.area)

/** What the editor currently holds, straight off the DOM node — never off a React prop:
 *  N-02 makes the textarea UNCONTROLLED, so its `value` is the only truth there is. */
export async function editText(page: Page): Promise<string> {
  return editArea(page).inputValue()
}

/**
 * Put the caret at the very end and type — the gesture every save case starts from.
 *
 * The caret is placed through `setSelectionRange` rather than with ⌘↓, which is a
 * macOS-only key binding Chromium interprets differently inside a textarea than in a
 * document. Only the CARET moves that way; every character below still arrives as a real
 * keystroke, so the uncontrolled-textarea path (N-02) is genuinely exercised.
 */
export async function typeAtEnd(page: Page, text: string): Promise<void> {
  const area = editArea(page)
  await area.click()
  await area.evaluate((el) => {
    const t = el as HTMLTextAreaElement
    t.setSelectionRange(t.value.length, t.value.length)
  })
  await page.keyboard.type(text)
}

/** Wait until the editor is really up: the textarea is on screen AND carries the file's
 *  bytes. A build that mounts an empty box would satisfy the first half alone. */
export async function editReady(page: Page, contains: string): Promise<void> {
  await expect(editArea(page)).toBeVisible({ timeout: 25_000 })
  await expect(editArea(page)).toHaveValue(
    new RegExp(contains.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    {
      timeout: 20_000
    }
  )
}
