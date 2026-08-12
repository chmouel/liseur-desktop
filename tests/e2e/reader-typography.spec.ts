import { test, expect, type ElectronApplication } from '@playwright/test'
import { rmSync } from 'node:fs'
import { buildReaderEpub } from '../unit/epub-fixture'
import { installBook, launchApp, makeTempDirs, openBookByTitle, revealChrome } from './helpers'

/**
 * How the book actually *renders*. Four regressions this pins down:
 *
 *  1. XHTML is not HTML. `<a id="page_1"/>` is a self-closing page marker in
 *     every real EPUB; fed to the HTML parser it becomes an open anchor that
 *     swallows the chapter and underlines all of it.
 *  2. The publisher's stylesheet must load inside the reader iframe (the
 *     renderer CSP is inherited by srcdoc documents and used to block it).
 *  3. Text is capped at a readable measure: a maximised window must not
 *     produce lines running from edge to edge.
 *  4. Two-column layout needs a gutter, and the page-turn arithmetic has to
 *     account for it or pages drift.
 */

let dataDir: string
let booksDir: string
let app: ElectronApplication | undefined

test.beforeAll(async () => {
  ;({ dataDir, booksDir } = makeTempDirs())
  await installBook(
    dataDir,
    booksDir,
    'typo.epub',
    buildReaderEpub({ chapters: 3, publisherStyles: true, words: 20000 }),
  )
})

test.afterAll(async () => {
  await app?.close()
  rmSync(dataDir, { recursive: true, force: true })
  rmSync(booksDir, { recursive: true, force: true })
})

test('book rendering: XHTML fidelity, publisher CSS, column gutter', async () => {
  test.setTimeout(60_000)
  ;({ app } = await launchApp(dataDir))
  const page = await app.firstWindow()
  await openBookByTitle(page, 'Reader Fixture')
  const iframe = page.frameLocator('.reader-iframe')
  await expect(iframe.locator('h1')).toHaveText('Chapter 1', { timeout: 10_000 })

  // 1. The page marker stays an empty anchor: the chapter is NOT inside it.
  await expect(iframe.locator('#page_1')).toBeAttached()
  expect(await iframe.locator('#page_1').evaluate((a) => a.childElementCount)).toBe(0)
  expect(await iframe.locator('p.para').evaluate((p) => !!p.closest('a'))).toBe(false)

  // 2. The publisher's stylesheet applies inside the sandboxed iframe.
  await expect
    .poll(() => iframe.locator('p.para').evaluate((p) => getComputedStyle(p).textAlign), {
      timeout: 10_000,
    })
    .toBe('justify')

  // 3. The measure is capped: a wide window gives margins, not a line of
  //    text stretching from edge to edge.
  const widths = await page.evaluate(() => ({
    viewport: document.querySelector('.reader-viewport')!.clientWidth,
    screen: document.querySelector('.reader-screen')!.clientWidth,
  }))
  expect(widths.viewport).toBeLessThan(widths.screen)

  // 4. Two columns get a gutter, and turning pages lands on exact multiples
  //    of one page step (viewport + gutter).
  await revealChrome(page)
  await page.getByRole('button', { name: 'Typography' }).click()
  const popover = page.getByRole('dialog', { name: 'Typography' })
  await popover.getByRole('radio', { name: '2 columns' }).click()
  await expect
    .poll(() => iframe.locator('body').evaluate((b) => parseFloat(getComputedStyle(b).columnGap)))
    .toBeGreaterThan(0)
  await page.keyboard.press('Escape')

  const step = await page
    .locator('.reader-iframe')
    .evaluate(
      (f) =>
        (f as HTMLIFrameElement).clientWidth +
        parseFloat(getComputedStyle((f as HTMLIFrameElement).contentDocument!.body).columnGap),
    )
  const offset = () =>
    iframe
      .locator('body')
      .evaluate((b) => new DOMMatrixReadOnly(getComputedStyle(b).transform).m41)

  await expect.poll(offset).toBeCloseTo(0, 0)
  await page.keyboard.press('ArrowRight')
  await expect.poll(offset).toBeCloseTo(-step, 0)
  await page.keyboard.press('ArrowRight')
  await expect.poll(offset).toBeCloseTo(-2 * step, 0)
  await page.keyboard.press('ArrowLeft')
  await expect.poll(offset).toBeCloseTo(-step, 0)

  // 5. No word is ever sliced by the edge of the page. The fixture puts a
  //    margin on <body> the way Calibre does on every EPUB it converts; if
  //    that inset is allowed to narrow the column box while the reader still
  //    steps by the full iframe width, every turn overshoots by the margin
  //    and the drift compounds until text is cut in half at both edges.
  //    A correctly paginated page never has a line straddling either edge:
  //    text is either wholly on this page or wholly on another.
  const slicedText = () =>
    iframe.locator('body').evaluate((b) => {
      const doc = b.ownerDocument
      const width = doc.documentElement.clientWidth
      const walker = doc.createTreeWalker(b, NodeFilter.SHOW_TEXT)
      const offenders: string[] = []
      while (walker.nextNode()) {
        const node = walker.currentNode
        if (!node.nodeValue?.trim()) continue
        const range = doc.createRange()
        range.selectNodeContents(node)
        for (const rect of Array.from(range.getClientRects())) {
          if (rect.width < 1) continue
          const straddlesLeft = rect.left < -1 && rect.right > 1
          const straddlesRight = rect.left < width - 1 && rect.right > width + 1
          if (straddlesLeft || straddlesRight) {
            offenders.push(`[${Math.round(rect.left)}, ${Math.round(rect.right)}] of ${width}`)
          }
        }
      }
      return offenders
    })

  const expectNothingSliced = async (label: string) => {
    for (let turn = 0; turn < 5; turn++) {
      expect(await slicedText(), `${label}, ${turn} turns in`).toEqual([])
      await page.keyboard.press('ArrowRight')
      await page.waitForTimeout(120)
    }
  }

  await expectNothingSliced('two columns')

  await revealChrome(page)
  await page.getByRole('button', { name: 'Typography' }).click()
  await popover.getByRole('radio', { name: '1 column' }).click()
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
  await expectNothingSliced('one column')
})
