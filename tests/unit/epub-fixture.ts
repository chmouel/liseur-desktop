import { deflateRawSync } from 'node:zlib'

/**
 * Builds minimal in-memory ZIP/EPUB files for tests — stored or deflated
 * entries, no data descriptors, no ZIP64. Producing fixtures in code keeps
 * the suite free of binary blobs and makes corruption cases easy.
 */

export interface FixtureEntry {
  name: string
  data: Buffer | string
  /** Deflate instead of storing (default: store). */
  deflate?: boolean
}

export function buildZip(entries: FixtureEntry[]): Buffer {
  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let offset = 0

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf8')
    const content = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8')
    const stored = entry.deflate ? deflateRawSync(content) : content
    const method = entry.deflate ? 8 : 0

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(0, 6) // flags
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(0, 10) // mod time
    local.writeUInt16LE(0, 12) // mod date
    local.writeUInt32LE(crc32(content), 14)
    local.writeUInt32LE(stored.length, 18)
    local.writeUInt32LE(content.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    local.writeUInt16LE(0, 28) // extra length
    localParts.push(local, nameBytes, stored)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4) // version made by
    central.writeUInt16LE(20, 6) // version needed
    central.writeUInt16LE(0, 8) // flags
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(0, 12) // mod time
    central.writeUInt16LE(0, 14) // mod date
    central.writeUInt32LE(crc32(content), 16)
    central.writeUInt32LE(stored.length, 20)
    central.writeUInt32LE(content.length, 24)
    central.writeUInt16LE(nameBytes.length, 28)
    central.writeUInt32LE(offset, 42) // local header offset
    centralParts.push(central, nameBytes)

    offset += 30 + nameBytes.length + stored.length
  }

  const centralStart = offset
  const centralSize = centralParts.reduce((n, b) => n + b.length, 0)

  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralSize, 12)
  eocd.writeUInt32LE(centralStart, 16)
  eocd.writeUInt16LE(0, 20) // comment length

  return Buffer.concat([...localParts, ...centralParts, eocd])
}

/** Tiny PNG (1×1 red pixel) — enough for cover extraction tests. */
export const FAKE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

export interface FixtureEpubOptions {
  title?: string
  creators?: string[]
  identifier?: string
  /** Emit EPUB2-style <meta name="cover"> instead of properties="cover-image". */
  epub2Cover?: boolean
  /** Omit the cover entirely. */
  noCover?: boolean
  /** Deflate the large entries to exercise the inflate path. */
  deflate?: boolean
}

export function buildEpub(options: FixtureEpubOptions = {}): Buffer {
  const {
    title = 'The Test Book',
    creators = ['Jane Writer'],
    identifier = 'urn:isbn:9780000000001',
    epub2Cover = false,
    noCover = false,
    deflate = false,
  } = options

  const coverMeta = epub2Cover ? '<meta name="cover" content="cover-img"/>' : ''
  const coverProps = epub2Cover ? '' : ' properties="cover-image"'
  const coverItem = noCover
    ? ''
    : `<item id="cover-img" href="images/cover.png" media-type="image/png"${coverProps}/>`

  const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="bookid" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    ${title ? `<dc:title>${title}</dc:title>` : ''}
    ${creators.map((c) => `<dc:creator>${c}</dc:creator>`).join('\n    ')}
    <dc:identifier id="bookid">${identifier}</dc:identifier>
    <dc:language>en</dc:language>
    ${coverMeta}
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ch1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>
    ${coverItem}
  </manifest>
  <spine>
    <itemref idref="ch1"/>
  </spine>
</package>`

  const entries: FixtureEntry[] = [
    { name: 'mimetype', data: 'application/epub+zip' },
    {
      name: 'META-INF/container.xml',
      data: `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`,
      deflate,
    },
    { name: 'OEBPS/content.opf', data: opf, deflate },
    { name: 'OEBPS/text/ch1.xhtml', data: '<html><body><p>Hello</p></body></html>', deflate },
  ]
  if (!noCover) entries.push({ name: 'OEBPS/images/cover.png', data: FAKE_PNG, deflate })
  return buildZip(entries)
}

/** Multi-chapter EPUB for reader tests: nav (EPUB 3) or NCX (EPUB 2). */
export function buildReaderEpub(options: { chapters?: number; ncx?: boolean } = {}): Buffer {
  const { chapters = 3, ncx = false } = options

  const chapterEntries: FixtureEntry[] = []
  const manifestItems: string[] = []
  const spineRefs: string[] = []
  const navItems: string[] = []
  const ncxPoints: string[] = []

  for (let i = 1; i <= chapters; i++) {
    const body = `Chapter ${i} `.concat(`word${i} `.repeat(200))
    chapterEntries.push({
      name: `OEBPS/text/ch${i}.xhtml`,
      data: `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Chapter ${i}</title></head><body><h1 id="ch${i}">Chapter ${i}</h1><p>${body}</p></body></html>`,
      deflate: true,
    })
    manifestItems.push(
      `<item id="ch${i}" href="text/ch${i}.xhtml" media-type="application/xhtml+xml"/>`,
    )
    spineRefs.push(`<itemref idref="ch${i}"/>`)
    navItems.push(`<li><a href="text/ch${i}.xhtml">Chapter ${i}</a></li>`)
    ncxPoints.push(
      `<navPoint id="np${i}" playOrder="${i}"><navLabel><text>Chapter ${i}</text></navLabel><content src="text/ch${i}.xhtml"/></navPoint>`,
    )
  }

  const opf = ncx
    ? `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="bookid" version="2.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Reader Fixture (NCX)</dc:title>
    <dc:creator id="a">Fixture Author</dc:creator>
    <dc:identifier id="bookid">fixture-ncx-1</dc:identifier>
  </metadata>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    ${manifestItems.join('\n    ')}
  </manifest>
  <spine toc="ncx">
    ${spineRefs.join('\n    ')}
  </spine>
</package>`
    : `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="bookid" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Reader Fixture</dc:title>
    <dc:creator id="a">Fixture Author</dc:creator>
    <dc:identifier id="bookid">fixture-nav-1</dc:identifier>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    ${manifestItems.join('\n    ')}
  </manifest>
  <spine>
    ${spineRefs.join('\n    ')}
  </spine>
</package>`

  const nav = `<?xml version="1.0"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<body><nav epub:type="toc"><ol>${navItems.join('')}</ol></nav></body>
</html>`

  const ncxDoc = `<?xml version="1.0"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/"><navMap>${ncxPoints.join('')}</navMap></ncx>`

  return buildZip([
    { name: 'mimetype', data: 'application/epub+zip' },
    {
      name: 'META-INF/container.xml',
      data: `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`,
    },
    { name: 'OEBPS/content.opf', data: opf, deflate: true },
    ...(ncx
      ? [{ name: 'OEBPS/toc.ncx', data: ncxDoc, deflate: true }]
      : [{ name: 'OEBPS/nav.xhtml', data: nav, deflate: true }]),
    ...chapterEntries,
  ])
}

function crc32(buf: Buffer): number {
  let crc = ~0
  for (const byte of buf) {
    crc ^= byte
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return ~crc >>> 0
}
