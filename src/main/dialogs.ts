import { dialog, BrowserWindow } from 'electron'
import { getWorker } from './worker-host'

/**
 * Native file/folder pickers for library ingestion. Main's only job here is
 * showing the dialog and forwarding the chosen paths to the worker — it
 * never opens or parses the files itself.
 */

const EPUB_FILTERS = [{ name: 'EPUB books', extensions: ['epub'] }]

export async function openEpubDialog(): Promise<void> {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  if (!win) return
  const result = await dialog.showOpenDialog(win, {
    title: 'Open EPUB',
    properties: ['openFile', 'multiSelections'],
    filters: EPUB_FILTERS,
  })
  if (result.canceled || result.filePaths.length === 0) return
  getWorker()?.postMessage({ kind: 'ingest-files', paths: result.filePaths })
}

export async function addFolderDialog(): Promise<void> {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  if (!win) return
  const result = await dialog.showOpenDialog(win, {
    title: 'Add library folder',
    properties: ['openDirectory', 'createDirectory'],
  })
  const path = result.filePaths[0]
  if (result.canceled || !path) return
  getWorker()?.postMessage({ kind: 'add-folder', path })
}
