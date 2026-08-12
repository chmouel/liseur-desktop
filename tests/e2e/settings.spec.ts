import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { rmSync } from 'node:fs'
import { buildReaderEpub } from '../unit/epub-fixture'
import { installBook, launchApp, makeTempDirs, openBookByTitle } from './helpers'

/**
 * Settings belong to the application, not to the shelf.
 *
 * They used to be part of the library screen, which is unmounted while a
 * book is open: Ctrl+, did nothing at all once you started reading, and the
 * only way to change anything was to leave the book first.
 */

let app: ElectronApplication
let page: Page
let dataDir: string
let booksDir: string

test.beforeAll(async () => {
  ;({ dataDir, booksDir } = makeTempDirs())
  await installBook(dataDir, booksDir, 'reader.epub', buildReaderEpub())
  ;({ app, page } = await launchApp(dataDir))
})

test.afterAll(async () => {
  await app.close()
  rmSync(dataDir, { recursive: true, force: true })
  rmSync(booksDir, { recursive: true, force: true })
})

const dialog = (): ReturnType<Page['getByRole']> => page.getByRole('dialog', { name: 'Settings' })

test('the settings panel opens over the shelf and closes with Escape', async () => {
  await page.getByRole('button', { name: 'Settings' }).click()
  await expect(dialog()).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog()).not.toBeVisible()
})

test('the settings shortcut answers while a book is open', async () => {
  await openBookByTitle(page, 'Reader Fixture')
  await expect(page.locator('.reader-screen')).toBeVisible()

  // What the menu item does, without going through a menu the window no
  // longer shows: main sends this on Ctrl+, and the shell has to hear it
  // wherever the reader happens to be.
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]!.webContents.send('liseur:menu:settings')
  })
  await expect(dialog()).toBeVisible()

  // The book is still there behind it, not closed and not left behind.
  await expect(page.locator('.reader-screen')).toBeVisible()
})

test('the book underneath does not read the keyboard through the panel', async () => {
  const iframe = page.frameLocator('.reader-iframe')
  await expect(iframe.locator('h1')).toHaveText('Chapter 1')
  const footer = await page.locator('.reader-footer').textContent()

  // Arrows turn pages in the reader and move between fields in a form. With
  // the panel up they belong to the panel. The footer says which page of
  // which chapter is showing, so it moves on any turn, not only on one that
  // crosses a chapter.
  for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowRight')
  await page.waitForTimeout(300)
  expect(await page.locator('.reader-footer').textContent()).toBe(footer)
  await expect(iframe.locator('h1')).toHaveText('Chapter 1')

  // Escape closes the panel and stops there: it must not also close the book.
  await page.keyboard.press('Escape')
  await expect(dialog()).not.toBeVisible()
  await expect(page.locator('.reader-screen')).toBeVisible()
})

test('settings changed in a book are still there on the shelf', async () => {
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]!.webContents.send('liseur:menu:settings')
  })
  const vim = dialog().getByLabel('Vim keys in the library and the reader')
  await vim.check()
  await page.keyboard.press('Escape')

  await page.keyboard.press('Escape') // leave the book
  await expect(page.locator('.library-screen')).toBeVisible()

  await page.getByRole('button', { name: 'Settings' }).click()
  await expect(dialog().getByLabel('Vim keys in the library and the reader')).toBeChecked()
  await page.keyboard.press('Escape')
  await expect(dialog()).not.toBeVisible()
})
