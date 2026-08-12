import { ZipReader } from './zip'
import { scanXml, textCollector } from './xml'
import type { SpineItem, TocEntry } from '../../shared/domain/types'

/**
 * EPUB metadata and cover extraction: container.xml → OPF → Dublin Core
 * metadata + manifest. Engine-agnostic — this is plain ZIP + XML, so it
 * stays valid regardless of the reader engine chosen in M4 (Readium or
 * otherwise). Lenient by design: a missing title falls back to the file
 * name, a missing cover yields no cover rather than an error.
 */

export interface EpubMetadata {
  title?: string | undefined
  authors: string[]
  /** dc:identifier — ISBN or UUID when present; used for dedupe. */
  identifier?: string | undefined
}

export interface EpubCover {
  /** Entry path within the archive. */
  entryPath: string
  mediaType: string
}

export class EpubError extends Error {}

/** Posix-style path resolution for OPF-relative hrefs. */
export function resolvePath(baseDir: string, href: string): string {
  const joined = baseDir ? `${baseDir}/${href}` : href
  const parts: string[] = []
  for (const segment of joined.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') parts.pop()
    else parts.push(segment)
  }
  return parts.join('/')
}

function findOpfPath(zip: ZipReader): string {
  const container = zip.readText('META-INF/container.xml')
  if (!container) throw new EpubError('missing META-INF/container.xml')

  let rootfile: string | undefined
  scanXml(container, {
    onStart: (el) => {
      if (el.localName === 'rootfile' && !rootfile) {
        const path = el.attributes['full-path']
        const mediaType = el.attributes['media-type']
        if (path && (!mediaType || mediaType === 'application/oebps-package+xml')) {
          rootfile = path
        }
      }
    },
  })
  if (!rootfile) throw new EpubError('no rootfile in container.xml')
  return rootfile
}

export interface ManifestItem {
  id: string
  href: string
  mediaType: string
  properties: string[]
}

interface Opf {
  metadata: EpubMetadata
  cover?: EpubCover | undefined
  manifest: Map<string, ManifestItem>
  /** itemrefs in document order: manifest id + linear flag. */
  spine: { idref: string; linear: boolean }[]
}

/** Resolves an href (possibly with #fragment) against a base directory. */
export function resolveHref(baseDir: string, href: string): string {
  const hash = href.indexOf('#')
  const path = hash === -1 ? href : href.slice(0, hash)
  const fragment = hash === -1 ? '' : href.slice(hash)
  if (!path) return `${baseDir}${fragment}` // pure fragment
  return `${resolvePath(baseDir, decodeURIComponent(path))}${fragment}`
}

function parseOpf(xml: string, opfDir: string): Opf {
  const titles: string[] = []
  const creators: string[] = []
  const identifiers: { id?: string; value: string }[] = []
  let uniqueIdentifierId: string | undefined
  const manifest = new Map<string, ManifestItem>()
  const spine: { idref: string; linear: boolean }[] = []
  let metaCoverId: string | undefined

  // Depth stack so we only pick up text of the element we're inside.
  const stack: string[] = []
  let collector: ReturnType<typeof textCollector> | undefined
  let collectingId: string | undefined

  scanXml(xml, {
    onStart: (el) => {
      stack.push(el.localName)
      if (el.localName === 'package' && el.attributes['unique-identifier']) {
        uniqueIdentifierId = el.attributes['unique-identifier']
      }
      const inMetadata = stack.includes('metadata')
      if (inMetadata && (el.localName === 'title' || el.localName === 'creator')) {
        collector = textCollector()
      } else if (inMetadata && el.localName === 'identifier') {
        collector = textCollector()
        collectingId = el.attributes['id']
      } else if (inMetadata && el.localName === 'meta') {
        // EPUB 2 cover: <meta name="cover" content="<manifest id>">
        if (el.attributes['name'] === 'cover' && el.attributes['content']) {
          metaCoverId = el.attributes['content']
        }
      } else if (el.localName === 'item') {
        const id = el.attributes['id']
        const href = el.attributes['href']
        const mediaType = el.attributes['media-type'] ?? ''
        if (id && href) {
          manifest.set(id, {
            id,
            href,
            mediaType,
            properties: (el.attributes['properties'] ?? '').split(/\s+/).filter(Boolean),
          })
        }
      } else if (el.localName === 'itemref' && stack.includes('spine')) {
        const idref = el.attributes['idref']
        if (idref) spine.push({ idref, linear: el.attributes['linear'] !== 'no' })
      }
    },
    onText: (text) => collector?.onText(text),
    onEnd: (_name, localName) => {
      stack.pop()
      if (
        collector &&
        (localName === 'title' || localName === 'creator' || localName === 'identifier')
      ) {
        const value = collector.value()
        collector = undefined
        if (!value) return
        if (localName === 'title') titles.push(value)
        else if (localName === 'creator') creators.push(value)
        else {
          identifiers.push(collectingId ? { id: collectingId, value } : { value })
          collectingId = undefined
        }
      }
    },
  })

  // Prefer the identifier the OPF declares as unique, else the first.
  const identifier =
    identifiers.find((i) => i.id !== undefined && i.id === uniqueIdentifierId)?.value ??
    identifiers[0]?.value

  let cover: EpubCover | undefined
  const coverItem =
    // EPUB 3: <item properties="cover-image" …>
    [...manifest.values()].find((item) => item.properties.includes('cover-image')) ??
    // EPUB 2: <meta name="cover" content="id">
    (metaCoverId ? manifest.get(metaCoverId) : undefined) ??
    // Last resort: the first image in the manifest.
    [...manifest.values()].find((item) => item.mediaType.startsWith('image/'))

  if (coverItem) {
    cover = {
      entryPath: resolvePath(opfDir, coverItem.href),
      mediaType: coverItem.mediaType,
    }
  }

  return {
    metadata: {
      title: titles[0],
      authors: creators,
      identifier,
    },
    cover,
    manifest,
    spine,
  }
}

/**
 * Parses an EPUB 3 nav document: the <nav epub:type="toc"> ordered list
 * becomes the TOC tree. Tolerant of missing entries — a book without a nav
 * simply has an empty TOC.
 */
export function parseNav(xml: string, baseDir: string): TocEntry[] {
  const root: TocEntry[] = []
  const listStack: TocEntry[][] = [root]
  let inToc = false
  let pendingHref: string | undefined
  let collector: ReturnType<typeof textCollector> | undefined

  scanXml(xml, {
    onStart: (el) => {
      if (el.localName === 'nav') {
        const type = el.attributes['epub:type'] ?? el.attributes['type']
        if (type === 'toc') inToc = true
        return
      }
      if (!inToc) return
      if (el.localName === 'ol' || el.localName === 'ul') {
        listStack.push([])
      } else if (el.localName === 'a' && el.attributes['href']) {
        pendingHref = resolveHref(baseDir, el.attributes['href'])
        collector = textCollector()
      }
    },
    onText: (text) => {
      if (inToc) collector?.onText(text)
    },
    onEnd: (_name, localName) => {
      if (!inToc) return
      if (localName === 'a' && collector && pendingHref) {
        const label = collector.value()
        collector = undefined
        if (label) listStack[listStack.length - 1]!.push({ label, href: pendingHref, children: [] })
        pendingHref = undefined
      } else if (localName === 'ol' || localName === 'ul') {
        const list = listStack.pop()
        if (!list) return
        if (listStack.length === 0) {
          root.push(...list)
        } else {
          // A nested list belongs to the entry its parent <li> created.
          const parent = listStack[listStack.length - 1]!
          const owner = parent[parent.length - 1]
          if (owner) owner.children = list
          else parent.push(...list)
        }
      } else if (localName === 'nav') {
        inToc = false
      }
    },
  })
  return root
}

/** Parses an EPUB 2 NCX document into the TOC tree. */
export function parseNcx(xml: string, baseDir: string): TocEntry[] {
  const root: TocEntry[] = []
  const stack: TocEntry[] = []
  let collecting = false
  let collector: ReturnType<typeof textCollector> | undefined

  scanXml(xml, {
    onStart: (el) => {
      if (el.localName === 'navpoint') {
        const entry: TocEntry = { label: '', href: '', children: [] }
        const parent = stack[stack.length - 1]
        if (parent) parent.children.push(entry)
        else root.push(entry)
        stack.push(entry)
      } else if (el.localName === 'text' && stack.length > 0) {
        collecting = true
        collector = textCollector()
      } else if (el.localName === 'content') {
        const current = stack[stack.length - 1]
        const src = el.attributes['src']
        if (current && src) current.href = resolveHref(baseDir, src)
      }
    },
    onText: (text) => {
      if (collecting) collector?.onText(text)
    },
    onEnd: (_name, localName) => {
      if (localName === 'navpoint') stack.pop()
      else if (localName === 'text' && collecting) {
        const current = stack[stack.length - 1]
        if (current && collector) current.label = collector.value()
        collecting = false
        collector = undefined
      }
    },
  })
  return root.filter((e) => e.href)
}

/** Human-readable fallback title from a file path (no extension). */
export function titleFromFilename(path: string): string {
  const base = path.split('/').pop() ?? path
  return base.replace(/\.epub$/i, '').trim() || base
}

export class EpubFile {
  readonly zip: ZipReader
  readonly opfPath: string
  private opf: Opf | undefined

  constructor(readonly data: Buffer) {
    this.zip = new ZipReader(data)
    // 'mimetype' must be first per spec, but plenty of real files get it
    // wrong — treat it as informational only.
    this.opfPath = findOpfPath(this.zip)
  }

  /** Directory of the OPF inside the archive ('' for root). */
  get opfDir(): string {
    const slash = this.opfPath.lastIndexOf('/')
    return slash === -1 ? '' : this.opfPath.slice(0, slash)
  }

  private parsedOpf(): Opf {
    if (!this.opf) {
      const xml = this.zip.readText(this.opfPath)
      if (!xml) throw new EpubError(`cannot read ${this.opfPath}`)
      this.opf = parseOpf(xml, this.opfDir)
    }
    return this.opf
  }

  metadata(): EpubMetadata & { cover?: EpubCover | undefined } {
    const opf = this.parsedOpf()
    return { ...opf.metadata, cover: opf.cover }
  }

  /** The reading order, resolved to archive paths. */
  spine(): SpineItem[] {
    const opf = this.parsedOpf()
    const items: SpineItem[] = []
    for (const ref of opf.spine) {
      const item = opf.manifest.get(ref.idref)
      if (!item) continue
      items.push({
        href: resolvePath(this.opfDir, decodeURIComponent(item.href)),
        mediaType: item.mediaType,
        linear: ref.linear,
      })
    }
    return items
  }

  /** The table of contents: EPUB 3 nav document, else EPUB 2 NCX. */
  toc(): TocEntry[] {
    const opf = this.parsedOpf()
    const navItem = [...opf.manifest.values()].find((i) => i.properties.includes('nav'))
    if (navItem) {
      const xml = this.zip.readText(resolvePath(this.opfDir, decodeURIComponent(navItem.href)))
      if (xml) {
        const toc = parseNav(xml, this.opfDir)
        if (toc.length > 0) return toc
      }
    }
    const ncxItem = [...opf.manifest.values()].find(
      (i) => i.mediaType === 'application/x-dtbncx+xml',
    )
    if (ncxItem) {
      const xml = this.zip.readText(resolvePath(this.opfDir, decodeURIComponent(ncxItem.href)))
      if (xml) return parseNcx(xml, this.opfDir)
    }
    return []
  }

  readCover(cover: EpubCover): Buffer | null {
    return this.zip.read(cover.entryPath)
  }
}

/** Extension for a cover media type, used for the cache file name. */
export function coverExtension(mediaType: string, entryPath: string): string {
  switch (mediaType) {
    case 'image/jpeg':
      return 'jpg'
    case 'image/png':
      return 'png'
    case 'image/webp':
      return 'webp'
    case 'image/gif':
      return 'gif'
    case 'image/avif':
      return 'avif'
    default: {
      const dot = entryPath.lastIndexOf('.')
      return dot === -1 ? 'img' : entryPath.slice(dot + 1).toLowerCase()
    }
  }
}
