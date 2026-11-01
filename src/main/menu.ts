import { app, Menu, type BaseWindow, type MenuItemConstructorOptions } from 'electron'
import type { BrowserCommand } from '@shared/types'

export type MenuShortcut =
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
  | 'next-waiting-session'
  | 'toggle-sidebar'
  | 'open-settings'
  | 'command-palette'

// PLATFORM§7
export function setupAppMenu(
  onShortcut: (action: MenuShortcut, from?: BaseWindow) => void,
  onBrowserCommand: (cmd: BrowserCommand, from?: BaseWindow) => void,
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
    click: (_item, win) => onBrowserCommand(id, win)
  })

  // PLATFORM§7
  const appMenu: MenuItemConstructorOptions = {
    label: app.name,
    submenu: [
      { role: 'about' },
      { label: 'Check for Updates…', click: (_item, win) => onShortcut('check-update', win) },
      { type: 'separator' },
      {
        id: 'open-settings',
        label: 'Settings…',
        accelerator: 'CmdOrCtrl+,',
        click: (_item, win) => onShortcut('open-settings', win)
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
      {
        id: 'new-session',
        label: 'New Session…',
        accelerator: 'CmdOrCtrl+N',
        click: (_item, win) => onShortcut('new-session', win)
      },
      {
        id: 'new-worktree-session',
        label: 'New Worktree Session…',
        accelerator: 'Shift+CmdOrCtrl+N',
        click: (_item, win) => onShortcut('new-worktree-session', win)
      },
      {
        id: 'add-workspace',
        label: 'Add Workspace…',
        accelerator: 'Shift+CmdOrCtrl+O',
        click: (_item, win) => onShortcut('add-workspace', win)
      },
      { type: 'separator' },
      {
        id: 'save',
        label: 'Save',
        accelerator: 'CmdOrCtrl+S',
        enabled: false,
        click: (_item, win) => onShortcut('save', win)
      },
      { type: 'separator' },
      {
        label: 'Close Tab',
        accelerator: 'CmdOrCtrl+W',
        click: (_item, win) => onShortcut('close-tab', win)
      },
      { type: 'separator' },
      {
        id: 'restart-session',
        label: 'Restart Session',
        accelerator: 'Shift+CmdOrCtrl+R',
        click: (_item, win) => onShortcut('restart-session', win)
      },
      { type: 'separator' },
      isMac
        ? { role: 'close', accelerator: 'Shift+CmdOrCtrl+W', label: 'Close Window' }
        : { role: 'quit' }
    ]
  }

  // PLATFORM§7
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
        click: (_item, win) => onShortcut('find', win)
      },
      {
        id: 'find-files',
        label: 'Search Files',
        accelerator: isMac ? 'Shift+CmdOrCtrl+F' : undefined,
        click: (_item, win) => onShortcut('find-files', win)
      }
    ]
  }

  // PLATFORM§7
  const viewMenu: MenuItemConstructorOptions = {
    label: 'View',
    submenu: [
      {
        id: 'command-palette',
        label: 'Command Palette…',
        accelerator: 'CmdOrCtrl+P',
        click: (_item, win) => onShortcut('command-palette', win)
      },
      { type: 'separator' },
      {
        id: 'new-terminal-tab',
        label: 'New Terminal Tab',
        accelerator: 'Control+`',
        enabled: false,
        click: (_item, win) => onShortcut('new-terminal-tab', win)
      },
      {
        id: 'toggle-sidebar',
        label: 'Toggle Sidebar',
        accelerator: 'CmdOrCtrl+B',
        click: (_item, win) => onShortcut('toggle-sidebar', win)
      },
      browserItem('toggle-browser', 'Toggle Workbench', 'Shift+CmdOrCtrl+B'),
      {
        id: 'focus-notes',
        label: 'Notes',
        accelerator: 'Alt+CmdOrCtrl+N',
        click: (_item, win) => onShortcut('focus-notes', win)
      },
      {
        id: 'next-waiting-session',
        label: 'Next Waiting Session',
        accelerator: 'CmdOrCtrl+J',
        click: (_item, win) => onShortcut('next-waiting-session', win)
      },
      { type: 'separator' },
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
      { ...browserItem('toggle-focus-mode', 'Focus Mode', 'CmdOrCtrl+Return'), enabled: false },
      { role: 'togglefullscreen' },
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

  // PLATFORM§7
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

export function setWorkbenchAvailable(available: boolean, terminal: boolean): void {
  const item = Menu.getApplicationMenu()?.getMenuItemById('toggle-focus-mode')
  if (item) item.enabled = available
  const term = Menu.getApplicationMenu()?.getMenuItemById('new-terminal-tab')
  if (term) term.enabled = terminal
}

export function setFindAvailable(available: boolean): void {
  const item = Menu.getApplicationMenu()?.getMenuItemById('find-in-page')
  if (item) item.enabled = available
}

export function setSaveAvailable(available: boolean): void {
  const item = Menu.getApplicationMenu()?.getMenuItemById('save')
  if (item) item.enabled = available
}

export function setKeepAwakeChecked(on: boolean): void {
  const item = Menu.getApplicationMenu()?.getMenuItemById('keep-awake')
  if (item) item.checked = on
}
