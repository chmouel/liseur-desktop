import { test, expect, type ElectronApplication } from '@playwright/test'
import { rmSync } from 'node:fs'
import { buildReaderEpub } from '../unit/epub-fixture'
import { installBook, launchApp, makeTempDirs, openBookByTitle, revealChrome } from './helpers'

/**
 * Reader preferences must survive a full application restart, not just a
 * reader reopen: they are written through main into window-state.json and
 * read back before the first layout.
 */

let dataDir: string
let booksDir: string
let app: ElectronApplication | undefined

test.beforeAll(async () => {
  ;({ dataDir, booksDir } = makeTempDirs())
  // publisherStyles pins `p.para { font-size: small }` — an absolute size, the
  // kind real books use, which ignores the page's font size unless the reader
  // deliberately overrides it.
  await installBook(
    dataDir,
    booksDir,
    'prefs.epub',
    buildReaderEpub({ chapters: 2, words: 2000, publisherStyles: true }),
  )
})

test.afterAll(async () => {
  await app?.close()
  rmSync(dataDir, { recursive: true, force: true })
  rmSync(booksDir, { recursive: true, force: true })
})

test('reader preferences survive an application restart', async () => {
  test.setTimeout(60_000)
  ;({ app } = await launchApp(dataDir))
  let page = await app.firstWindow()
  await openBookByTitle(page, 'Reader Fixture')
  let iframe = page.frameLocator('.reader-iframe')
  await expect(iframe.locator('h1')).toHaveText('Chapter 1', { timeout: 10_000 })

  await revealChrome(page)
  await page.getByRole('button', { name: 'Typography' }).click()
  const popover = page.getByRole('dialog', { name: 'Typography' })
  await popover.getByRole('radio', { name: '2 columns' }).click()
  for (let i = 0; i < 3; i++)
    await popover.getByRole('button', { name: 'Increase font size' }).click()
  await expect(popover.locator('.typography-value')).toHaveText('21')
  await expect
    .poll(() => iframe.locator('body').evaluate((b) => getComputedStyle(b).fontSize))
    .toBe('21px')
  await page.keyboard.press('Escape')

  await app.close()
  app = undefined
  ;({ app } = await launchApp(dataDir))
  page = await app.firstWindow()
  await openBookByTitle(page, 'Reader Fixture')
  iframe = page.frameLocator('.reader-iframe')
  await expect(iframe.locator('h1')).toHaveText('Chapter 1', { timeout: 10_000 })

  // Font size and column count come back exactly as they were left.
  await expect
    .poll(() => iframe.locator('body').evaluate((b) => getComputedStyle(b).fontSize), {
      timeout: 10_000,
    })
    .toBe('21px')
  expect(
    await iframe.locator('body').evaluate((b) => {
      // How many columns actually fit in one viewport, as rendered.
      const style = getComputedStyle(b)
      const gap = parseFloat(style.columnGap) || 0
      return Math.round((b.clientWidth + gap) / (parseFloat(style.columnWidth) + gap))
    }),
  ).toBe(2)
  await revealChrome(page)
  await page.getByRole('button', { name: 'Typography' }).click()
  await expect(
    page.getByRole('dialog', { name: 'Typography' }).getByRole('radio', { name: '2 columns' }),
  ).toHaveAttribute('aria-checked', 'true')
})

test('the font size goes well past 40px, and stops at the ceiling', async () => {
  test.setTimeout(90_000)
  // The previous test leaves an app running, and the data dir holds a
  // single-instance lock.
  await app?.close()
  ;({ app } = await launchApp(dataDir))
  const page = await app.firstWindow()
  await openBookByTitle(page, 'Reader Fixture')
  const iframe = page.frameLocator('.reader-iframe')
  await expect(iframe.locator('h1')).toHaveText('Chapter 1', { timeout: 10_000 })

  // What the reader actually renders, measured on the paragraph the
  // publisher pinned at `font-size: small` — not on <body>, which would pass
  // even while every word on screen stayed 13px.
  const renderedSize = () =>
    iframe.locator('p.para').evaluate((el) => parseFloat(getComputedStyle(el).fontSize))

  await revealChrome(page)
  await page.getByRole('button', { name: 'Typography' }).click()
  const popover = page.getByRole('dialog', { name: 'Typography' })
  const bigger = popover.getByRole('button', { name: 'Increase font size' })
  const shown = async () => parseInt(await popover.locator('.typography-value').innerText(), 10)

  // The reader's size wins over the publisher's absolute one from the start.
  await expect.poll(renderedSize).toBe(await shown())

  // Hold '+' well beyond the old 40px cap; the size must keep climbing.
  for (let i = 0; i < 40; i++) await bigger.click()
  const at58 = await shown()
  expect(at58).toBeGreaterThan(40)
  await expect.poll(renderedSize).toBe(at58)

  // Keep going: it settles at the ceiling and the button disables itself.
  for (let i = 0; i < 60; i++) {
    if (await bigger.isDisabled()) break
    await bigger.click()
  }
  await expect(bigger).toBeDisabled()
  const max = await shown()
  expect(max).toBeGreaterThanOrEqual(96)
  await expect.poll(renderedSize).toBe(max)

  // The publisher's own typography survives the override.
  expect(await iframe.locator('p.para').evaluate((el) => getComputedStyle(el).textAlign)).toBe(
    'justify',
  )

  // The text is still paginated, not spilling out of the page.
  expect(await iframe.locator('body').evaluate((b) => b.scrollWidth >= b.clientWidth)).toBe(true)

  // And the floor behaves symmetrically.
  const smaller = popover.getByRole('button', { name: 'Decrease font size' })
  for (let i = 0; i < 120; i++) {
    if (await smaller.isDisabled()) break
    await smaller.click()
  }
  await expect(smaller).toBeDisabled()
  expect(await shown()).toBe(10)
  await expect.poll(renderedSize).toBe(10)
})
