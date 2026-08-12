import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Shared content-addressed cover cache: write-once files under
 * `$DATA/covers/`, served to the renderer via the `liseur-cover:` scheme.
 * Returns the coverId (hash + extension) or undefined for empty input.
 */
export function storeCoverBytes(
  dataDir: string,
  bytes: Buffer,
  extension = 'png',
): string | undefined {
  if (bytes.length === 0) return undefined
  const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 24)
  const coverId = `${hash}.${extension}`
  const dir = join(dataDir, 'covers')
  mkdirSync(dir, { recursive: true })
  const target = join(dir, coverId)
  if (!existsSync(target)) writeFileSync(target, bytes)
  return coverId
}
