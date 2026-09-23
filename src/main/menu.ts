import { app, Menu, type MenuItemConstructorOptions } from 'electron'
import type { BrowserCommand } from '@shared/types'

// PLATFORM§7
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

  // PLATFORM§7
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
      {
        id: 'new-session',
        label: 'New Session…',
        accelerator: 'CmdOrCtrl+N',
        click: () => onShortcut('new-session')
      },
      {
        id: 'new-worktree-session',
        label: 'New Worktree Session…',
        accelerator: 'Shift+CmdOrCtrl+N',
        click: () => onShortcut('new-worktree-session')
      },
      {
        id: 'add-workspace',
        label: 'Add Workspace…',
        accelerator: 'Shift+CmdOrCtrl+O',
        click: () => onShortcut('add-workspace')
      },
      { type: 'separator' },
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
        click: () => onShortcut('find')
      },
      {
        id: 'find-files',
        label: 'Search Files',
        accelerator: isMac ? 'Shift+CmdOrCtrl+F' : undefined,
        click: () => onShortcut('find-files')
      }
    ]
  }

  // PLATFORM§7
  const viewMenu: MenuItemConstructorOptions = {
    label: 'View',
    submenu: [
      {
        id: 'new-terminal-tab',
        label: 'New Terminal Tab',
        accelerator: 'Control+`',
        enabled: false,
        click: () => onShortcut('new-terminal-tab')
      },
      browserItem('toggle-browser', 'Toggle Workbench', 'Shift+CmdOrCtrl+B'),
      {
        id: 'focus-notes',
        label: 'Notes',
        accelerator: 'Alt+CmdOrCtrl+N',
        click: () => onShortcut('focus-notes')
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
