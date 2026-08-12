import { test, expect, type ElectronApplication } from '@playwright/test'
import { rmSync } from 'node:fs'
import { buildReaderEpub } from '../unit/epub-fixture'
import { installBook, launchApp, makeTempDirs, openBookByTitle, revealChrome } from './helpers'

/**
 * M5 reader shell: chrome auto-hide, typography popover with persistence,
 * scrubber, fullscreen, shortcuts.
 */

let dataDir: string
let booksDir: string
let app: ElectronApplication | undefined

test.beforeAll(async () => {
  ;({ dataDir, booksDir } = makeTempDirs())
  await installBook(dataDir, booksDir, 'shell.epub', buildReaderEpub({ chapters: 4 }))
})

test.afterAll(async () => {
  await app?.close()
  rmSync(dataDir, { recursive: true, force: true })
  rmSync(booksDir, { recursive: true, force: true })
})

test('reader shell: chrome, typography, scrubber, fullscreen, persistence', async () => {
  // Long test: idle-wait for chrome auto-hide + a full reader reopen.
  test.setTimeout(60_000)
  ;({ app } = await launchApp(dataDir))
  const page = await app.firstWindow()
  await page.waitForSelector('.library-screen')
  await openBookByTitle(page, 'Reader Fixture')
  const iframe = page.frameLocator('.reader-iframe')
  await expect(iframe.locator('h1')).toHaveText('Chapter 1', { timeout: 10_000 })

  // --- chrome auto-hides when idle, returns on pointer movement -----------
  await expect(page.locator('.reader-topbar')).toBeVisible()
  await page.waitForTimeout(3000) // idle past the 2.5 s hide delay
  await expect(page.locator('.reader-topbar')).toHaveClass(/chrome-hidden/)
  await revealChrome(page)
  await expect(page.locator('.reader-topbar')).not.toHaveClass(/chrome-hidden/)

  // --- typography popover: font size, columns ------------------------------
  await page.getByRole('button', { name: 'Typography' }).click()
  const popover = page.getByRole('dialog', { name: 'Typography' })
  await expect(popover).toBeVisible()

  // Prefs persist across sessions, so tests must work from any starting state.
  const fontSizeBefore = await iframe.locator('body').evaluate((b) => getComputedStyle(b).fontSize)
  const bump = parseInt(fontSizeBefore, 10) > 10 ? 'Decrease font size' : 'Increase font size'
  await popover.getByRole('button', { name: bump }).click()
  await expect
    .poll(() => iframe.locator('body').evaluate((b) => getComputedStyle(b).fontSize))
    .not.toBe(fontSizeBefore)
  const fontSizeAfter = await iframe.locator('body').evaluate((b) => getComputedStyle(b).fontSize)

  // The page is paper, always: there is no reader theme to switch.
  await expect(popover.locator('.theme-swatch')).toHaveCount(0)
  await expect(iframe.locator('body')).toHaveCSS('background-color', 'rgb(255, 255, 255)')

  // The measure is capped, so a column is the same width in either layout —
  // switching adds a column (and its gutter), it doesn't squeeze the text.
  const colWidthBefore = await iframe
    .locator('body')
    .evaluate((b) => getComputedStyle(b).columnWidth)
  const oneCol = popover.getByRole('radio', { name: '1 column' })
  const twoCols = popover.getByRole('radio', { name: '2 columns' })
  const startedAtOne = (await oneCol.getAttribute('aria-checked')) === 'true'
  await (startedAtOne ? twoCols : oneCol).click()
  await expect
    .poll(() => iframe.locator('body').evaluate((b) => getComputedStyle(b).columnCount))
    .toBe(startedAtOne ? '2' : '1')
  await expect(iframe.locator('body')).toHaveCSS('column-width', colWidthBefore)

  // Escape closes the popover (not the reader).
  await page.keyboard.press('Escape')
  await expect(popover).not.toBeVisible()
  await expect(page.locator('.reader-screen')).toBeVisible()

  // --- scrubber jumps to the end ------------------------------------------
  await revealChrome(page)
  await page.locator('.reader-scrubber').fill('1000')
  await expect(iframe.locator('h1')).toHaveText('Chapter 4', { timeout: 10_000 })

  // --- fullscreen via keyboard ---------------------------------------------
  await page.keyboard.press('f')
  await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(true)
  await page.keyboard.press('Escape') // exits fullscreen, not the reader
  await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(false)
  await expect(page.locator('.reader-screen')).toBeVisible()

  // --- preferences persist across reader sessions ---------------------------
  await page.keyboard.press('Escape') // back to library
  await page.waitForSelector('.library-screen')
  await openBookByTitle(page, 'Reader Fixture')
  await expect(iframe.locator('h1')).toHaveText(/Chapter/, { timeout: 10_000 })
  // Font size from the previous session survives.
  await expect
    .poll(() => iframe.locator('body').evaluate((b) => getComputedStyle(b).fontSize), {
      timeout: 10_000,
    })
    .toBe(fontSizeAfter)
  // And the restored position is chapter 4 (from the scrubber jump).
  await expect(iframe.locator('h1')).toHaveText('Chapter 4', { timeout: 10_000 })
})
