import { inflateRawSync } from 'node:zlib'

/**
 * Minimal read-only ZIP reader, just enough for EPUB (which is a ZIP of
 * XML/XHTML/images). Node's zlib handles deflate; the container format is
 * simple enough to parse directly, which keeps the app free of a native or
 * large zip dependency.
 *
 * Supported: stored and deflated entries, data descriptors, UTF-8 names.
 * Rejected: encrypted entries, multi-disk archives, ZIP64 (EPUBs that large
 * are vanishingly rare; revisit if one shows up).
 */

export interface ZipEntry {
  name: string
  compressedSize: number
  uncompressedSize: number
  /** Offset of the local file header. */
  localHeaderOffset: number
  method: number
}

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50
const MAX_EOCD_SEARCH = 65_536 + 22 // max comment length + EOCD size

const METHOD_STORED = 0
const METHOD_DEFLATE = 8

/** Untrusted-input guard: no single EPUB entry may exceed this (256 MiB). */
export const MAX_ENTRY_BYTES = 256 * 1024 * 1024

export class ZipError extends Error {}

export class ZipReader {
  private readonly entriesMap = new Map<string, ZipEntry>()

  constructor(private readonly data: Buffer) {
    const eocd = this.findEocd()
    const disk = eocd.readUInt16LE(4)
    const entries = eocd.readUInt16LE(10)
    const centralOffset = eocd.readUInt32LE(16)
    if (disk !== 0 || eocd.readUInt16LE(6) !== 0) {
      throw new ZipError('multi-disk archives are not supported')
    }
    if (entries === 0xffff || centralOffset === 0xffffffff) {
      throw new ZipError('ZIP64 archives are not supported')
    }

    let offset = centralOffset
    for (let i = 0; i < entries; i++) {
      if (offset + 46 > data.length || data.readUInt32LE(offset) !== CENTRAL_SIGNATURE) {
        throw new ZipError('corrupt central directory')
      }
      const flags = data.readUInt16LE(offset + 8)
      const method = data.readUInt16LE(offset + 10)
      const compressedSize = data.readUInt32LE(offset + 20)
      const uncompressedSize = data.readUInt32LE(offset + 24)
      const nameLength = data.readUInt16LE(offset + 28)
      const extraLength = data.readUInt16LE(offset + 30)
      const commentLength = data.readUInt16LE(offset + 32)
      const localHeaderOffset = data.readUInt32LE(offset + 42)
      if (flags & 0x1) throw new ZipError('encrypted entries are not supported')

      const name = data.toString('utf8', offset + 46, offset + 46 + nameLength)
      this.entriesMap.set(name, {
        name,
        compressedSize,
        uncompressedSize,
        localHeaderOffset,
        method,
      })
      offset += 46 + nameLength + extraLength + commentLength
    }
  }

  private findEocd(): Buffer {
    const start = Math.max(0, this.data.length - MAX_EOCD_SEARCH)
    for (let i = this.data.length - 22; i >= start; i--) {
      if (this.data.readUInt32LE(i) === EOCD_SIGNATURE) {
        return this.data.subarray(i, i + 22)
      }
    }
    throw new ZipError('not a ZIP file (no end of central directory)')
  }

  /** Entry names in archive order. */
  entries(): string[] {
    return [...this.entriesMap.keys()]
  }

  has(name: string): boolean {
    return this.entriesMap.has(name)
  }

  read(name: string): Buffer | null {
    const entry = this.entriesMap.get(name)
    if (!entry) return null
    // Declared sizes are untrusted: refuse implausible entries up front, and
    // let zlib enforce the cap again at inflation time (zip-bomb guard).
    if (entry.uncompressedSize > MAX_ENTRY_BYTES || entry.compressedSize > MAX_ENTRY_BYTES) {
      throw new ZipError(`entry ${name} exceeds size limit`)
    }

    const offset = entry.localHeaderOffset
    if (offset + 30 > this.data.length || this.data.readUInt32LE(offset) !== LOCAL_SIGNATURE) {
      throw new ZipError(`corrupt local header for ${name}`)
    }
    // Local header name/extra lengths can differ from the central directory.
    const nameLength = this.data.readUInt16LE(offset + 26)
    const extraLength = this.data.readUInt16LE(offset + 28)
    const start = offset + 30 + nameLength + extraLength
    const raw = this.data.subarray(start, start + entry.compressedSize)

    switch (entry.method) {
      case METHOD_STORED:
        if (entry.compressedSize !== entry.uncompressedSize) {
          throw new ZipError(`stored entry ${name} has mismatched sizes`)
        }
        return Buffer.from(raw)
      case METHOD_DEFLATE:
        try {
          // maxOutputLength catches archives whose real content exceeds the
          // declared size — the classic zip-bomb shape.
          return inflateRawSync(raw, { maxOutputLength: entry.uncompressedSize })
        } catch (err) {
          throw new ZipError(`failed to inflate ${name}`, { cause: err })
        }
      default:
        throw new ZipError(`unsupported compression method ${entry.method} for ${name}`)
    }
  }

  readText(name: string): string | null {
    const buf = this.read(name)
    return buf ? buf.toString('utf8') : null
  }
}
