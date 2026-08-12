import { describe, expect, it } from 'vitest'
import { isXhtmlChapter } from '../../src/renderer/reader/engine'

/**
 * Chapter markup must be parsed as XML when it is XHTML: the HTML parser
 * turns `<a id="page_42"/>` page markers into open anchors that swallow the
 * rest of the chapter.
 */
describe('isXhtmlChapter', () => {
  it('trusts the manifest media type', () => {
    expect(isXhtmlChapter('<html><body/></html>', 'application/xhtml+xml')).toBe(true)
    expect(isXhtmlChapter('<html><body/></html>', 'text/html')).toBe(false)
  })

  it('detects XHTML that is mislabelled as HTML', () => {
    const xml = '<?xml version="1.0"?><html><body/></html>'
    expect(isXhtmlChapter(xml, 'text/html')).toBe(true)
    const namespaced = '<html xmlns="http://www.w3.org/1999/xhtml"><body/></html>'
    expect(isXhtmlChapter(namespaced, 'text/html')).toBe(true)
  })

  it('only looks at the head of the document', () => {
    const late = `<html><body>${'x'.repeat(2000)}http://www.w3.org/1999/xhtml</body></html>`
    expect(isXhtmlChapter(late, 'text/html')).toBe(false)
  })
})
