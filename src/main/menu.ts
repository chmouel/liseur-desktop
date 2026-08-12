import { app, Menu, shell, BrowserWindow } from 'electron'
import { openEpubDialog, addFolderDialog } from './dialogs'

const isMac = process.platform === 'darwin'

function send(channel: string): void {
  BrowserWindow.getFocusedWindow()?.webContents.send(channel)
}

export function setupMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'Open EPUB…',
          accelerator: 'CmdOrCtrl+O',
          // The dialog runs in main; chosen paths go straight to the worker.
          click: () => void openEpubDialog(),
        },
        {
          label: 'Add Folder…',
          accelerator: 'CmdOrCtrl+Shift+O',
          click: () => void addFolderDialog(),
        },
        { type: 'separator' },
        {
          label: 'Settings…',
          accelerator: 'CmdOrCtrl+,',
          click: () => send('liseur:menu:settings'),
        },
        { type: 'separator' },
        isMac ? { role: 'close' as const } : { role: 'quit' as const },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        {
          label: 'Search Library',
          accelerator: 'CmdOrCtrl+F',
          click: () => send('liseur:menu:search'),
        },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(!app.isPackaged
          ? [
              { type: 'separator' as const },
              { role: 'toggleDevTools' as const },
              { role: 'reload' as const },
            ]
          : []),
      ],
    },
    {
      role: 'help',
      submenu: [
        {
          label: 'Liseur on GitHub',
          click: () => void shell.openExternal('https://github.com/chmouel/liseur'),
        },
      ],
    },
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
