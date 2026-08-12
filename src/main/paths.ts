import { app } from 'electron'
import { join } from 'node:path'

/**
 * Single source of truth for the app's data directory in the main process.
 * The worker receives it as LISEUR_DATA_DIR (it cannot reach `app` itself);
 * the e2e suite overrides it for hermetic, throwaway libraries.
 */
export function dataDir(): string {
  return process.env.LISEUR_DATA_DIR ?? app.getPath('userData')
}

export function coversDir(): string {
  return join(dataDir(), 'covers')
}
