import { describe, expect, it } from 'vitest'
import { ZipReader, ZipError } from '../../src/worker/epub/zip'
import { buildZip } from './epub-fixture'

describe('ZipReader', () => {
  it('lists entries and reads stored content', () => {
    const zip = new ZipReader(
      buildZip([
        { name: 'hello.txt', data: 'hello world' },
        { name: 'dir/nested.txt', data: 'nested' },
      ]),
    )
    expect(zip.entries()).toEqual(['hello.txt', 'dir/nested.txt'])
    expect(zip.readText('hello.txt')).toBe('hello world')
    expect(zip.readText('dir/nested.txt')).toBe('nested')
  })

  it('reads deflated entries', () => {
    const content = 'deflate me '.repeat(500)
    const zip = new ZipReader(buildZip([{ name: 'big.txt', data: content, deflate: true }]))
    expect(zip.readText('big.txt')).toBe(content)
  })

  it('handles binary content', () => {
    const bytes = Buffer.from([0, 1, 2, 255, 254, 128])
    const zip = new ZipReader(buildZip([{ name: 'bin', data: bytes }]))
    expect(zip.read('bin')).toEqual(bytes)
  })

  it('returns null for missing entries', () => {
    const zip = new ZipReader(buildZip([{ name: 'a', data: 'a' }]))
    expect(zip.read('nope')).toBeNull()
    expect(zip.has('nope')).toBe(false)
    expect(zip.has('a')).toBe(true)
  })

  it('rejects non-ZIP data', () => {
    expect(() => new ZipReader(Buffer.from('this is not a zip file at all......'))).toThrow(
      ZipError,
    )
  })

  it('handles an empty archive', () => {
    const zip = new ZipReader(buildZip([]))
    expect(zip.entries()).toEqual([])
  })
})
