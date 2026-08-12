import { test, expect, type ElectronApplication } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { rmSync } from 'node:fs'
import { buildReaderEpub } from '../unit/epub-fixture'
import { launchApp, makeTempDirs } from './helpers'

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
const progressPushes: { locator?: { href?: string }; device?: { id?: string } }[] = []

test.beforeAll(async () => {
  ;({ dataDir } = makeTempDirs())
  const epub = buildReaderEpub({ chapters: 2 })

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
      res.end(
        JSON.stringify({
          content: [
            {
              id: 'komga-1',
              name: 'The Remote Tome',
              sizeBytes: epub.length,
              metadata: { title: 'The Remote Tome', authors: [{ name: 'Kay Ohm' }] },
              media: { pagesCount: 10 },
            },
          ],
          last: true,
        }),
      )
      return
    }
    if (url.pathname === '/api/v1/books/komga-1/file') {
      res.writeHead(200, { 'content-type': 'application/epub+zip' }).end(epub)
      return
    }
    if (url.pathname === '/api/v1/books/komga-1/thumbnail') {
      res.writeHead(404).end()
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

test('Komga: add server, sync catalog, download on open, push progress', async () => {
  test.setTimeout(60_000)
  // The e2e environment has no OS keychain; the test-only escape hatch keeps
  // the credential path exercisable (still never in SQLite).
  process.env.LISEUR_ALLOW_INSECURE_SECRETS = '1'
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

  // --- sync the catalog -------------------------------------------------------
  await dialog.getByRole('button', { name: 'Sync now' }).click()
  await page.keyboard.press('Escape') // close settings
  await expect(dialog).not.toBeVisible()

  // The remote book streams into the library with a server badge. (Search:
  // under "Recent" a never-opened remote shell sorts below the seed set.)
  await page.getByRole('button', { name: 'Search' }).click()
  await page.locator('.search-input').fill('Remote Tome')
  const card = page.getByRole('gridcell', { name: /The Remote Tome/ })
  await expect(card).toBeVisible({ timeout: 10_000 })
  await expect(card.locator('.badge-server')).toBeVisible()
  await expect(card.locator('.badge-downloaded')).not.toBeVisible()

  // --- open downloads it on demand ---------------------------------------------
  await card.dblclick()
  await page.waitForSelector('.reader-screen')
  const iframe = page.frameLocator('.reader-iframe')
  await expect(iframe.locator('h1')).toHaveText('Chapter 1', { timeout: 15_000 })

  // --- page turn pushes progress back to the server ----------------------------
  await page.keyboard.press('ArrowRight')
  await expect.poll(() => progressPushes.length, { timeout: 10_000 }).toBeGreaterThan(0)
  expect(progressPushes[0]?.device?.id).toBe('liseur-desktop')
  expect(progressPushes[0]?.locator?.href).toContain('ch')

  // The library card now shows the downloaded badge.
  await page.keyboard.press('Escape')
  await page.waitForSelector('.library-screen')
  // Search is still filtering to the book; the badge updates in place.
  await expect(card.locator('.badge-downloaded')).toBeVisible({ timeout: 10_000 })
})
