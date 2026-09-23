import { app, Menu, type MenuItemConstructorOptions } from 'electron'
import type { BrowserCommand } from '@shared/types'

/**
 * Install the application menu. Tabs live entirely in the renderer's store, so a
 * shortcut like Close Tab ⌘W can't act in the main process — its menu item just
 * forwards to the renderer via `onShortcut`. Menu accelerators are handled at the
 * native level, so they fire reliably even while xterm has focus (a plain renderer
 * keydown listener would be swallowed by the terminal).
 *
 * ⌘T is deliberately bound NOWHERE: the free terminal is retired (agent-centric §9)
 * and the key is arbitrated in the renderer by FOCUS (R6), which claims it as a
 * keydown while focused (§03B). A native accelerator here would swallow it app-wide.
 *
 * We also remap the default ⌘W (Electron's File menu binds it to Close Window) to
 * Close Tab, moving Close Window to ⇧⌘W — the standard terminal/browser convention.
 * The Window submenu is built explicitly (not via the `windowMenu` role) so no
 * stray Close item re-binds ⌘W and clashes with our File menu.
 */
export function setupAppMenu(
  onShortcut: (
    action:
      | 'new-session'
      | 'new-worktree-session'
      | 'close-tab'
      | 'find'
      | 'find-files'
      | 'check-update'
      | 'restart-session'
      | 'add-workspace'
      | 'new-terminal-tab'
      | 'save'
      | 'toggle-keep-awake'
      | 'focus-notes'
      | 'open-settings'
  ) => void,
  onBrowserCommand: (cmd: BrowserCommand) => void,
  /** the keepAwake setting as it stands when the menu is built (the checkbox's
   *  initial state; later flips arrive through `setKeepAwakeChecked`) */
  keepAwake = false
): void {
  const isMac = process.platform === 'darwin'
  const browserItem = (
    id: BrowserCommand,
    label: string,
    accelerator?: string
  ): MenuItemConstructorOptions => ({
    id,
    label,
    accelerator,
    click: () => onBrowserCommand(id)
  })

  // Built explicitly (not via the `appMenu` role) so we can slot "Check for Updates…"
  // right under About — a role-generated submenu can't be edited. Mirrors the role's
  // standard items otherwise. macOS only; the item forwards to the renderer, which
  // drives the (unsigned-safe) DIY update flow via the update IPC.
  const appMenu: MenuItemConstructorOptions = {
    label: app.name,
    submenu: [
      { role: 'about' },
      { label: 'Check for Updates…', click: () => onShortcut('check-update') },
      { type: 'separator' },
      {
        id: 'open-settings',
        label: 'Settings…',
        accelerator: 'CmdOrCtrl+,',
        click: () => onShortcut('open-settings')
      },
      { type: 'separator' },
      { role: 'services' },
      { type: 'separator' },
      { role: 'hide' },
      { role: 'hideOthers' },
      { role: 'unhide' },
      { type: 'separator' },
      { role: 'quit' }
    ]
  }

  const fileMenu: MenuItemConstructorOptions = {
    label: 'File',
    submenu: [
      // ⌘N starts a Claude session in the main checkout — through C10, which is what
      // the ellipsis promises (D12). Stable id for e2e.
      {
        id: 'new-session',
        label: 'New Session…',
        accelerator: 'CmdOrCtrl+N',
        click: () => onShortcut('new-session')
      },
      // ⇧⌘N is the second creation action (new-session-entrances D8): same gesture
      // family, worktree instead of the main checkout. Stable id for e2e.
      {
        id: 'new-worktree-session',
        label: 'New Worktree Session…',
        accelerator: 'Shift+CmdOrCtrl+N',
        click: () => onShortcut('new-worktree-session')
      },
      // ⇧⌘O pins a workspace (C1's ⊞ is the same action). Stable id for e2e.
      {
        id: 'add-workspace',
        label: 'Add Workspace…',
        accelerator: 'Shift+CmdOrCtrl+O',
        click: () => onShortcut('add-workspace')
      },
      { type: 'separator' },
      // file-edit B-16: ⌘S saves the file being edited in the Workbench. It is a native
      // accelerator for the reason named at the top of this file — a plain renderer
      // keydown would be eaten while xterm has the focus.
      //
      // Unlike ⇧⌘B and ⌘⇧F it IS gated (`setSaveAvailable`), following the unsaved flag.
      // Those two are the panel's front door, where greying would read as "this build has
      // no Workbench"; a greyed Save instead reads as "nothing to save", which is both
      // true and what every other Mac app does. Disabling the item also stops the
      // accelerator, which is B-15's "do nothing when nothing changed" arriving one step
      // earlier than the renderer. Stable id for e2e.
      // starts off: nothing can be unsaved before the renderer has even mounted
      {
        id: 'save',
        label: 'Save',
        accelerator: 'CmdOrCtrl+S',
        enabled: false,
        click: () => onShortcut('save')
      },
      { type: 'separator' },
      { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: () => onShortcut('close-tab') },
      { type: 'separator' },
      // ⇧⌘R restarts the active tab's claude session in place (kill the pty, respawn it
      // with --resume). The id is a stable contract the e2e suite triggers by.
      {
        id: 'restart-session',
        label: 'Restart Session',
        accelerator: 'Shift+CmdOrCtrl+R',
        click: () => onShortcut('restart-session')
      },
      { type: 'separator' },
      isMac
        ? { role: 'close', accelerator: 'Shift+CmdOrCtrl+W', label: 'Close Window' }
        : { role: 'quit' }
    ]
  }

  // explicit Edit menu (not the `editMenu` role) so we can append Find while still
  // supplying the platform-standard items the role would (Paste and Match Style, Speech,
  // etc.). Find forwards to the renderer like the tab shortcuts. Its accelerator is
  // macOS-only: ⌘F is free there, but on Linux/Windows Ctrl+F is a core terminal/readline
  // key we must not steal app-wide (the menu item stays clickable, and a focused html
  // preview still opens find via the guest's before-input-event hook in index.ts).
  const editMenu: MenuItemConstructorOptions = {
    label: 'Edit',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      ...(isMac
        ? ([
            { role: 'pasteAndMatchStyle' },
            { role: 'delete' },
            { role: 'selectAll' },
            { type: 'separator' },
            { label: 'Speech', submenu: [{ role: 'startSpeaking' }, { role: 'stopSpeaking' }] }
          ] as MenuItemConstructorOptions[])
        : ([
            { role: 'delete' },
            { type: 'separator' },
            { role: 'selectAll' }
          ] as MenuItemConstructorOptions[])),
      { type: 'separator' },
      {
        id: 'find-in-page',
        label: 'Find',
        accelerator: isMac ? 'CmdOrCtrl+F' : undefined,
        click: () => onShortcut('find')
      },
      // ⌘⇧F expands the Files island's search row (C3); ⌘F stays the preview
      // pane's find-in-page. Same macOS-only accelerator caveat as Find.
      {
        id: 'find-files',
        label: 'Search Files',
        accelerator: isMac ? 'Shift+CmdOrCtrl+F' : undefined,
        click: () => onShortcut('find-files')
      }
    ]
  }

  // Built explicitly (not via the `viewMenu` role) for two reasons: Force Reload binds
  // ⇧⌘R, which now restarts the claude session; and since the Browser (D9/IMPL-4/5)
  // Reload, zoom and DevTools can no longer be roles at all — a role acts on the whole
  // Koloft renderer, so ⌘R pressed inside a web page would reload the app and destroy every
  // terminal. They are custom items now, always enabled and carrying their standard
  // accelerators, dispatched in the renderer against whichever aux surface is active
  // (Q2): on the guest while the Browser holds the aux column, and on the whole window
  // otherwise — DevTools and the three zoom items keep exactly the meaning their roles
  // had. Reload is the deliberate exception with no whole-window branch at all: a
  // keystroke must never reload the Koloft renderer, so outside the Browser ⌘R does
  // nothing. That is the safety this rework exists for, not a gap to fill in later.
  // ⌘T is deliberately still unbound here (§08 P1⑩) so it can reach the guest through
  // main's before-input-event hook instead.
  const viewMenu: MenuItemConstructorOptions = {
    label: 'View',
    submenu: [
      // D3/R5: ⌃` opens ONE terminal tab in the selected session's Workbench panel.
      // It has to be a native accelerator — a session's TUI or one of the panel's own
      // shells holds the focus whenever the user reaches for it, and xterm swallows
      // renderer keydowns (A1). "Control+`" is the spelling Electron parses everywhere.
      //
      // Built DISABLED, like Focus Mode below and for the same reason: only the renderer
      // knows whether a session is selected, bound and still alive, and a live accelerator
      // that silently does nothing is a worse answer than a greyed item. Both flip
      // through `setWorkbenchAvailable`.
      {
        id: 'new-terminal-tab',
        label: 'New Terminal Tab',
        accelerator: 'Control+`',
        enabled: false,
        click: () => onShortcut('new-terminal-tab')
      },
      // FR-06/55: the same accelerator, retargeted. ⇧⌘B used to light the Globe on a
      // two-surface aux column; it now toggles the whole panel — T1→T2, T2→T1, and from
      // T3 straight to T1 in one step. The command id is deliberately NOT renamed: it is
      // the wire word `commandTarget` arbitrates on, and churning it would touch the
      // guest-forward path, the renderer dispatch and every test for a label change.
      browserItem('toggle-browser', 'Toggle Workbench', 'Shift+CmdOrCtrl+B'),
      // ⌥⌘N puts the caret in the workspace's note. Native accelerator for the
      // reason named at the top of this file — xterm eats plain renderer keydowns. The
      // key stays in the ⌘N family (⌘N session, ⇧⌘N worktree session, ⌥⌘N note).
      // Always enabled: the renderer knows whether a workspace is pinned, and decides
      // what the key does when none is.
      {
        id: 'focus-notes',
        label: 'Notes',
        accelerator: 'Alt+CmdOrCtrl+N',
        click: () => onShortcut('focus-notes')
      },
      { type: 'separator' },
      // "New Browser Tab", not "New Tab": ⌘T is arbitrated in the renderer by focus
      // (FR-52 / R6), and the free-terminal retirement (§9) pins the absence of a
      // global New Tab item.
      browserItem('browser-new-tab', 'New Browser Tab'),
      browserItem('browser-close-tab', 'Close Browser Tab'),
      browserItem('browser-focus-address', 'Focus Address Bar', 'CmdOrCtrl+L'),
      browserItem('browser-back', 'Back', 'CmdOrCtrl+['),
      browserItem('browser-forward', 'Forward', 'CmdOrCtrl+]'),
      { type: 'separator' },
      browserItem('browser-reload', 'Reload', 'CmdOrCtrl+R'),
      browserItem(
        'browser-devtools',
        'Toggle Developer Tools',
        isMac ? 'Alt+Command+I' : 'Ctrl+Shift+I'
      ),
      { type: 'separator' },
      browserItem('browser-zoom-reset', 'Actual Size', 'CmdOrCtrl+0'),
      browserItem('browser-zoom-in', 'Zoom In', 'CmdOrCtrl+Plus'),
      browserItem('browser-zoom-out', 'Zoom Out', 'CmdOrCtrl+-'),
      { type: 'separator' },
      // FR-05: T3 reuses this key rather than adding one. It is the ONE item here that
      // is not always-enabled — with no session selected there is no panel to give the
      // centre row to, and a live-but-inert accelerator would be a worse answer than a
      // greyed item (FR-04). `setWorkbenchAvailable` drives the flag.
      { ...browserItem('toggle-focus-mode', 'Focus Mode', 'CmdOrCtrl+Return'), enabled: false },
      { role: 'togglefullscreen' },
      // keepAwake: a checkbox that mirrors the setting (main flips it and echoes the new
      // settings to the renderer, like every other settings write). macOS only — the
      // mechanism is `caffeinate`, which exists nowhere else. No accelerator: it is a
      // switch, not a gesture, and every free key is worth more to a session.
      ...(isMac
        ? [
            { type: 'separator' as const },
            {
              id: 'keep-awake',
              label: 'Keep Mac Awake',
              type: 'checkbox' as const,
              checked: keepAwake,
              click: () => onShortcut('toggle-keep-awake')
            }
          ]
        : [])
    ]
  }

  const windowMenu: MenuItemConstructorOptions = {
    label: 'Window',
    submenu: [
      { role: 'minimize' },
      { role: 'zoom' },
      ...(isMac ? [{ type: 'separator' as const }, { role: 'front' as const }] : [])
    ]
  }

  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [appMenu] : []),
    fileMenu,
    editMenu,
    viewMenu,
    windowMenu
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

/**
 * FR-04/05 + R5 — the renderer is the only place that knows whether a session is
 * SELECTED (main tracks ptys and bindings, not the sidebar's selection), so it reports the
 * answer and this flips the two View items that depend on it.
 *
 * They take SEPARATE flags because they ask different questions. Focus Mode only needs a
 * panel to give the row to, so a cold session still counts; a shell needs a claude that is
 * alive to belong to (D2), which is one state stricter. One channel, so the two can never
 * drift out of step with each other.
 *
 * ⇧⌘B and ⌘⇧F stay enabled and no-op in the renderer instead: they are the panel's own
 * front door, and a greyed "Toggle Workbench" would read as "this build has no
 * Workbench" rather than "select a session first". (Find is gated too, but on a
 * different fact — see `setFindAvailable`.)
 */
export function setWorkbenchAvailable(available: boolean, terminal: boolean): void {
  const item = Menu.getApplicationMenu()?.getMenuItemById('toggle-focus-mode')
  if (item) item.enabled = available
  const term = Menu.getApplicationMenu()?.getMenuItemById('new-terminal-tab')
  if (term) term.enabled = terminal
}

/**
 * file-edit B-12 — Find goes dark while an editor is on screen.
 *
 * This is the one gate that is NOT "no-op in the renderer instead". Koloft's find paints
 * highlights over rendered text (`useDomFind`), which does nothing at all to a textarea:
 * a live ⌘F would open a find bar that can only ever report zero matches, and that reads
 * as broken rather than as absent. Greying the item is the honest answer.
 */
export function setFindAvailable(available: boolean): void {
  const item = Menu.getApplicationMenu()?.getMenuItemById('find-in-page')
  if (item) item.enabled = available
}

/** file-edit B-15/B-16 — Save follows the unsaved flag; see the File menu item above for
 *  why this one is gated where ⇧⌘B and ⌘⇧F are not. */
export function setSaveAvailable(available: boolean): void {
  const item = Menu.getApplicationMenu()?.getMenuItemById('save')
  if (item) item.enabled = available
}

/** keepAwake — the View checkbox follows the setting, whichever surface flipped it (the
 *  titlebar button, the menu item itself, or a reset). */
export function setKeepAwakeChecked(on: boolean): void {
  const item = Menu.getApplicationMenu()?.getMenuItemById('keep-awake')
  if (item) item.checked = on
}
