import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 30_000,
  // Electron app tests must not run in parallel against the same build.
  workers: 1,
  reporter: process.env.CI ? 'github' : 'list',
})
