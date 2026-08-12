import { test, expect, type ElectronApplication } from '@playwright/test'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { rmSync } from 'node:fs'
import { buildReaderEpub } from '../unit/epub-fixture'
import { launchApp, makeTempDirs } from './helpers'

/** Collects a request body, so a handler can validate what was posted. */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => resolve(body))
  })
}

/**
 * M7 end to end with a real HTTP mock Komga server (node:http, no mocks in
 * the app): add server via the settings UI, test connection, catalog sync,
 * remote badge, download-on-open into the reader, and a progress push back
 * to the server.
 */

let dataDir: string
let app: ElectronApplication | undefined
let server: Server
let baseUrl: string
let thumbnailRequests = 0
const progressPushes: { locator?: { href?: string }; device?: { id?: string } }[] = []
/** What the mock server currently has on its shelf; the test adds to it. */
let catalog: Record<string, unknown>[] = []

/** A 1x1 PNG — enough for Chromium to decode and for the cache to store. */
const THUMBNAIL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

test.beforeAll(async () => {
  ;({ dataDir } = makeTempDirs())
  const epub = buildReaderEpub({ chapters: 2 })

  catalog = [
    {
      id: 'komga-1',
      name: 'The Remote Tome',
      sizeBytes: epub.length,
      metadata: { title: 'The Remote Tome', authors: [{ name: 'Kay Ohm' }] },
      media: { pagesCount: 10 },
    },
  ]

  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (req.headers['x-api-key'] !== 'e2e-key') {
      res.writeHead(401).end('{}')
      return
    }
    if (url.pathname === '/api/v2/users/me') {
      res.end(JSON.stringify({ roles: ['ROLE_USER', 'FILE_DOWNLOAD'] }))
      return
    }
    if (url.pathname === '/api/v1/books/list' && req.method === 'POST') {
      // Validate the search DSL the way Komga does: every filter leaf has
      // to be an operator object, or the real server answers 400.
      readBody(req).then((raw) => {
        const body = JSON.parse(raw || '{}') as {
          condition?: { allOf?: Record<string, unknown>[] }
        }
        const leaves = body.condition?.allOf ?? []
        const wellFormed =
          leaves.length > 0 &&
          leaves.every((leaf) =>
            Object.values(leaf).every(
              (v) => typeof v === 'object' && v !== null && 'operator' in v && 'value' in v,
            ),
          )
        if (!wellFormed) {
          res.writeHead(400, { 'content-type': 'application/json' }).end('{"error":"Bad Request"}')
          return
        }
        res.end(
          JSON.stringify({
            content: catalog,
            last: true,
          }),
        )
      })
      return
    }
    if (url.pathname === '/api/v1/books/komga-1/file') {
      res.writeHead(200, { 'content-type': 'application/epub+zip' }).end(epub)
      return
    }
    if (url.pathname === '/api/v1/books/komga-1/thumbnail') {
      thumbnailRequests++
      res.writeHead(200, { 'content-type': 'image/png' }).end(THUMBNAIL_PNG)
      return
    }
    if (url.pathname === '/api/v1/books/komga-1/progression') {
      if (req.method === 'PUT') {
        let body = ''
        req.on('data', (c) => (body += c))
        req.on('end', () => {
          progressPushes.push(JSON.parse(body))
          res.writeHead(204).end()
        })
        return
      }
      res.writeHead(204).end()
      return
    }
    res.writeHead(404).end('{}')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

test.afterAll(async () => {
  await app?.close()
  await new Promise((resolve) => server.close(resolve))
  rmSync(dataDir, { recursive: true, force: true })
})

/**
 * Waits until `progressPushes` stops growing for a short window, so a
 * baseline count taken right after isn't confused by a push whose network
 * round trip is still in flight.
 */
async function waitForPushesToSettle(): Promise<void> {
  let last = -1
  await expect
    .poll(
      () => {
        const stable = progressPushes.length === last
        last = progressPushes.length
        return stable
      },
      { timeout: 3_000, intervals: [150] },
    )
    .toBe(true)
}

test('Komga: add server, sync catalog, download on open, push progress', async () => {
  test.setTimeout(60_000)
  // The e2e environment has no OS keychain; the test-only escape hatch keeps
  // the credential path exercisable (still never in SQLite).
  process.env.LISEUR_ALLOW_INSECURE_SECRETS = '1'
  // Treat the catalog as stale immediately, so the refresh-on-focus below
  // is observable without the test sitting idle for fifteen minutes.
  process.env.LISEUR_SYNC_STALE_MS = '0'
  ;({ app } = await launchApp(dataDir))
  const page = await app.firstWindow()
  await page.waitForSelector('.library-screen')

  // --- add the server through the settings UI --------------------------------
  await page.getByRole('button', { name: 'Settings' }).click()
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: '+ Add server' }).click()
  await dialog.locator('#server-type').selectOption('komga')
  await dialog.locator('#server-name').fill('Test Komga')
  await dialog.locator('#server-url').fill(baseUrl)
  await dialog.locator('#server-secret').fill('e2e-key')
  await dialog.getByRole('button', { name: 'Add & test' }).click()

  // The server appears, connection tested as part of setup.
  await expect(dialog.locator('.server-name')).toHaveText('Test Komga', { timeout: 15_000 })

  // --- the catalog arrives on its own ------------------------------------------
  // No "Sync now" click: adding a server that connects has to fill the shelf,
  // or the app looks broken to anyone who does not find that button.
  await page.keyboard.press('Escape') // close settings
  await expect(dialog).not.toBeVisible()

  // The remote book streams into the library with a server badge. (Search:
  // under "Recent" a never-opened remote shell sorts below the seed set.)
  await page.getByRole('button', { name: 'Search' }).click()
  await page.locator('.search-input').fill('Remote Tome')
  const card = page.getByRole('gridcell', { name: /The Remote Tome/ })
  await expect(card).toBeVisible({ timeout: 15_000 })
  await expect(card.locator('.badge-server')).toBeVisible()
  await expect(card.locator('.badge-downloaded')).not.toBeVisible()

  // --- the server's cover art turns up on the card ------------------------------
  // Fetched lazily, per card, and cached: the grid shows the publisher's
  // cover rather than a generated placeholder.
  await expect(card.locator('.book-cover')).toHaveAttribute('src', /^liseur-cover:/, {
    timeout: 15_000,
  })
  const cover = card.locator('.book-cover')
  await expect
    .poll(() => cover.evaluate((el) => (el as HTMLImageElement).naturalWidth), { timeout: 10_000 })
    .toBeGreaterThan(0)
  expect(thumbnailRequests).toBeGreaterThan(0)

  // --- open downloads it on demand ---------------------------------------------
  await card.click()
  await page.waitForSelector('.reader-screen')
  const iframe = page.frameLocator('.reader-iframe')
  await expect(iframe.locator('h1')).toHaveText('Chapter 1', { timeout: 15_000 })

  // --- page turn pushes progress back to the server ----------------------------
  await page.keyboard.press('ArrowRight')
  // Immediate, not the old 2 s debounce: a short bound proves promptness.
  await expect.poll(() => progressPushes.length, { timeout: 3_000 }).toBeGreaterThan(0)
  expect(progressPushes[0]?.device?.id).toBe('liseur-desktop')
  expect(progressPushes[0]?.locator?.href).toContain('ch')

  // --- rapid page turns deliver the latest locator, not one push per turn -------
  const pushesBeforeRapid = progressPushes.length
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight')
  const footerAfterRapid = await page.locator('.reader-footer').textContent()
  await expect
    .poll(() => progressPushes.length, { timeout: 5_000 })
    .toBeGreaterThan(pushesBeforeRapid)
  // Whatever arrived, the LAST push matches where the reader actually
  // settled — a stale mid-sequence locator never wins.
  await expect.poll(() => page.locator('.reader-footer').textContent()).toBe(footerAfterRapid)
  expect(progressPushes.at(-1)?.locator?.href).toBeTruthy()

  // Let every push the rapid sequence started actually land before using the
  // count as a baseline — otherwise a straggler still in flight could be
  // mistaken for one caused by the typography change below.
  await waitForPushesToSettle()

  // --- typography/resize restoration causes no extra push -----------------------
  const pushesBeforeTypography = progressPushes.length
  await page.getByRole('button', { name: 'Typography' }).click()
  await page.getByRole('button', { name: 'Increase font size' }).click()
  await page.keyboard.press('Escape') // close the popover
  await waitForPushesToSettle()
  expect(progressPushes.length).toBe(pushesBeforeTypography)

  // The library card now shows the downloaded badge.
  await page.keyboard.press('Escape')
  await page.waitForSelector('.library-screen')
  // Search is still filtering to the book; the badge updates in place.
  await expect(card.locator('.badge-downloaded')).toBeVisible({ timeout: 10_000 })

  // --- a book added to the server later turns up too ---------------------------
  // The catalog used to be pulled once per process, so a shelf left open
  // never grew. Coming back to the window asks the server again.
  catalog.push({
    id: 'komga-2',
    name: 'The Latecomer',
    sizeBytes: 1024,
    metadata: { title: 'The Latecomer', authors: [{ name: 'Kay Ohm' }] },
    media: { pagesCount: 10 },
  })
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await page.getByRole('button', { name: 'Search' }).click()
  await page.locator('.search-input').fill('Latecomer')
  await expect(page.getByRole('gridcell', { name: /The Latecomer/ })).toBeVisible({
    timeout: 15_000,
  })
})
