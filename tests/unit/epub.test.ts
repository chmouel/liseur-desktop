import { describe, expect, it } from 'vitest'
import { EpubFile, EpubError, resolvePath, titleFromFilename } from '../../src/worker/epub/epub'
import { buildEpub, buildZip, FAKE_PNG } from './epub-fixture'

describe('EpubFile', () => {
  it('extracts EPUB 3 metadata and cover', () => {
    const epub = new EpubFile(buildEpub({ title: 'Glass &amp; Ember', creators: ['A', 'B'] }))
    const meta = epub.metadata()
    expect(meta.title).toBe('Glass & Ember')
    expect(meta.authors).toEqual(['A', 'B'])
    expect(meta.identifier).toBe('urn:isbn:9780000000001')
    expect(meta.cover).toMatchObject({
      entryPath: 'OEBPS/images/cover.png',
      mediaType: 'image/png',
    })
    expect(epub.readCover(meta.cover!)).toEqual(FAKE_PNG)
  })

  it('resolves EPUB 2 covers via <meta name="cover">', () => {
    const epub = new EpubFile(buildEpub({ epub2Cover: true }))
    const meta = epub.metadata()
    expect(meta.cover?.entryPath).toBe('OEBPS/images/cover.png')
  })

  it('reads deflated archives', () => {
    const epub = new EpubFile(buildEpub({ deflate: true, title: 'Deflated' }))
    expect(epub.metadata().title).toBe('Deflated')
  })

  it('handles missing covers gracefully', () => {
    const epub = new EpubFile(buildEpub({ noCover: true }))
    expect(epub.metadata().cover).toBeUndefined()
  })

  it('rejects files without a container', () => {
    const zip = buildZip([{ name: 'random.txt', data: 'nope' }])
    expect(() => new EpubFile(zip)).toThrow(EpubError)
  })

  it('rejects containers without a rootfile', () => {
    const zip = buildZip([
      { name: 'META-INF/container.xml', data: '<container><rootfiles/></container>' },
    ])
    expect(() => new EpubFile(zip)).toThrow(/rootfile/)
  })
})

describe('resolvePath', () => {
  it('resolves OPF-relative hrefs', () => {
    expect(resolvePath('OEBPS', 'images/cover.png')).toBe('OEBPS/images/cover.png')
    expect(resolvePath('OEBPS', '../shared/font.ttf')).toBe('shared/font.ttf')
    expect(resolvePath('', 'content.opf')).toBe('content.opf')
    expect(resolvePath('OEBPS', './a/./b.xhtml')).toBe('OEBPS/a/b.xhtml')
  })
})

describe('titleFromFilename', () => {
  it('strips the extension and directories', () => {
    expect(titleFromFilename('/books/My Great Book.epub')).toBe('My Great Book')
    expect(titleFromFilename('plain.EPUB')).toBe('plain')
  })
})
