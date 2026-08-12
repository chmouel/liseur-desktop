import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
// @ts-expect-error — a plain .mjs script, deliberately dependency-free
import { parseChecksums, updateCask } from '../../scripts/update-cask.mjs'

const cask = readFileSync(new URL('../../Casks/liseur.rb', import.meta.url), 'utf8')

// Hexadecimal, because a checksum that is not is invisible to the cask.
const sum = (seed: string) => seed.repeat(64)

// Spelled out rather than derived from the script, so that renaming a
// downloaded file has to be agreed to in two places.
const checksums = (version: string) =>
  new Map([
    [`liseur-desktop-${version}-mac-arm64.dmg`, sum('a')],
    [`liseur-desktop-${version}-mac-x64.dmg`, sum('b')],
    [`liseur-desktop-${version}-linux-arm64.AppImage`, sum('c')],
    [`liseur-desktop-${version}-linux-x86_64.AppImage`, sum('d')],
  ])

describe('parseChecksums', () => {
  it('reads the output of sha256sum', () => {
    const sums = parseChecksums(
      `${sum('a')}  liseur-desktop-1.2.3-mac-arm64.dmg\n${sum('b')} *binary-mode.zip\n`,
    )

    expect(sums.get('liseur-desktop-1.2.3-mac-arm64.dmg')).toBe(sum('a'))
    expect(sums.get('binary-mode.zip')).toBe(sum('b'))
  })

  it('ignores anything that is not a checksum line', () => {
    expect(parseChecksums('## Checksums\n\nnot a checksum at all\n').size).toBe(0)
  })
})

describe('updateCask', () => {
  it('moves the version and every checksum', () => {
    const updated = updateCask(cask, '9.9.9', checksums('9.9.9'))

    expect(updated).toContain('version "9.9.9"')
    expect(updated).toContain(`arm:          "${sum('a')}"`)
    expect(updated).toContain(`intel:        "${sum('b')}"`)
    expect(updated).toContain(`arm64_linux:  "${sum('c')}"`)
    expect(updated).toContain(`x86_64_linux: "${sum('d')}"`)
  })

  it('leaves the hand-written parts of the cask alone', () => {
    const updated = updateCask(cask, '9.9.9', checksums('9.9.9'))

    // The URL and the AppImage name interpolate the version, so they follow
    // on their own; nothing else in the cask may move.
    expect(updated.replace(/"[0-9a-f]{64}"/g, '""').replace(/9\.9\.9/g, '0.2.0')).toBe(
      cask.replace(/"[0-9a-f]{64}"/g, '""'),
    )
  })

  it('leaves the checksums aligned under one another', () => {
    const updated = updateCask(cask, '9.9.9', checksums('9.9.9'))
    const columns = [
      ...updated.matchAll(/^(.*?\b(?:arm|intel|arm64_linux|x86_64_linux):\s+)"[0-9a-f]{64}"/gm),
    ].map((match) => match[1].length)

    expect(columns).toHaveLength(4)
    expect(new Set(columns).size).toBe(1)
  })

  it('is unchanged when it is run twice', () => {
    const once = updateCask(cask, '9.9.9', checksums('9.9.9'))

    expect(updateCask(once, '9.9.9', checksums('9.9.9'))).toBe(once)
  })

  it('refuses a release that is missing a download', () => {
    const incomplete = checksums('9.9.9')
    incomplete.delete('liseur-desktop-9.9.9-linux-arm64.AppImage')

    expect(() => updateCask(cask, '9.9.9', incomplete)).toThrow(
      'the release has no liseur-desktop-9.9.9-linux-arm64.AppImage',
    )
  })

  it('refuses a version that is not one', () => {
    expect(() => updateCask(cask, 'nightly', checksums('nightly'))).toThrow('not a version number')
  })

  it('refuses a cask it does not recognise', () => {
    expect(() => updateCask('cask "liseur" do\nend\n', '9.9.9', checksums('9.9.9'))).toThrow(
      'no version stanza in the cask',
    )
  })

  it('refuses a cask that has lost a checksum', () => {
    const mutilated = cask.replace(/^\s*x86_64_linux:.*$/m, '')

    expect(() => updateCask(mutilated, '9.9.9', checksums('9.9.9'))).toThrow(
      'no x86_64_linux checksum in the cask',
    )
  })
})
