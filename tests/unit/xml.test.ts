import { describe, expect, it } from 'vitest'
import { scanXml, decodeEntities, type XmlStartElement } from '../../src/worker/epub/xml'

function collect(xml: string) {
  const starts: XmlStartElement[] = []
  const ends: string[] = []
  let text = ''
  scanXml(xml, {
    onStart: (el) => starts.push(el),
    onEnd: (name) => ends.push(name),
    onText: (t) => {
      text += t
    },
  })
  return { starts, ends, text }
}

describe('scanXml', () => {
  it('parses elements, attributes and text', () => {
    const { starts, text } = collect('<root a="1" b=\'two\'>hi<child/>there</root>')
    expect(starts.map((s) => s.name)).toEqual(['root', 'child'])
    expect(starts[0]?.attributes).toMatchObject({ a: '1', b: 'two' })
    expect(starts[1]?.selfClosing).toBe(true)
    expect(text).toBe('hithere')
  })

  it('is namespace-tolerant via localName', () => {
    const { starts } = collect('<opf:meta opf:name="cover" content="c1"/>')
    expect(starts[0]?.localName).toBe('meta')
    expect(starts[0]?.attributes['opf:name']).toBe('cover')
    expect(starts[0]?.attributes['name']).toBe('cover')
  })

  it('decodes entities in text and attributes', () => {
    const { text, starts } = collect('<a t="x &amp; y">Tom &amp; Jerry &lt;3 &#65;&#x42;</a>')
    expect(text).toBe('Tom & Jerry <3 AB')
    expect(starts[0]?.attributes['t']).toBe('x & y')
  })

  it('passes CDATA through undecoded', () => {
    const { text } = collect('<a><![CDATA[<b>&amp;</b>]]></a>')
    expect(text).toBe('<b>&amp;</b>')
  })

  it('skips comments, doctype and processing instructions', () => {
    const { starts, text } = collect('<?xml version="1.0"?><!DOCTYPE x><!-- <ignored> --><a>ok</a>')
    expect(starts.map((s) => s.name)).toEqual(['a'])
    expect(text).toBe('ok')
  })

  it('recovers from malformed input instead of throwing', () => {
    expect(() => collect('<a><b>oops')).not.toThrow()
    expect(() => collect('plain text, no tags')).not.toThrow()
    expect(() => collect('<a href="unterminated')).not.toThrow()
  })

  it('reports end events for explicit and self-closing tags', () => {
    const { ends } = collect('<a><b/><c></c></a>')
    expect(ends).toEqual(['b', 'c', 'a'])
  })
})

describe('decodeEntities', () => {
  it('leaves unknown entities untouched', () => {
    expect(decodeEntities('&bogus; &amp;')).toBe('&bogus; &')
  })
})
