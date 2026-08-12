import { describe, expect, it } from 'vitest'
// @ts-expect-error — a plain .mjs script, deliberately dependency-free
import { isFromRegistry, parseLockfile } from '../../scripts/check-lockfile-change.mjs'

const lockfile = [
  "lockfileVersion: '9.0'",
  '',
  'importers:',
  '',
  '  .:',
  '    devDependencies:',
  '      vite:',
  '        specifier: ^7.3.6',
  '        version: 7.3.6',
  '',
  'packages:',
  '',
  '  vite@7.3.6:',
  '    resolution: {integrity: sha512-aaa}',
  '    engines: {node: ^20.19.0}',
  '',
  "  '@babel/core@7.29.7':",
  '    resolution: {integrity: sha512-bbb}',
  '',
  '  smuggled@1.0.0:',
  '    resolution: {tarball: https://example.com/smuggled.tgz}',
  '',
  'snapshots:',
  '',
  '  vite@7.3.6:',
  '    dependencies:',
  '      esbuild: 0.28.2',
  '',
].join('\n')

describe('parseLockfile', () => {
  const entries = parseLockfile(lockfile)

  it('reads only the packages section, not importers or snapshots', () => {
    expect([...entries.keys()]).toEqual(['vite@7.3.6', '@babel/core@7.29.7', 'smuggled@1.0.0'])
  })

  it('splits scoped names from versions on the last @', () => {
    expect(entries.get('@babel/core@7.29.7')).toMatchObject({
      name: '@babel/core',
      version: '7.29.7',
    })
  })

  it('captures the resolution', () => {
    expect(entries.get('vite@7.3.6')?.resolution).toBe('integrity: sha512-aaa')
  })

  it('strips peer-dependency suffixes from versions', () => {
    const withPeers = parseLockfile(
      ["lockfileVersion: '9.0'", 'packages:', '  vite-plugin-solid@2.11.14(solid-js@1.9.14):', '']
        .join('\n')
        .concat('    resolution: {integrity: sha512-ccc}\n'),
    )
    expect(withPeers.get('vite-plugin-solid@2.11.14(solid-js@1.9.14)')?.version).toBe('2.11.14')
  })

  it('finds nothing in a lockfile with no packages', () => {
    expect(parseLockfile("lockfileVersion: '9.0'\n").size).toBe(0)
  })
})

describe('isFromRegistry', () => {
  it('accepts a resolution carrying an integrity hash', () => {
    expect(isFromRegistry('integrity: sha512-aaa')).toBe(true)
  })

  it('rejects a tarball smuggled in from elsewhere', () => {
    expect(isFromRegistry('tarball: https://example.com/smuggled.tgz')).toBe(false)
  })

  it('rejects a git checkout', () => {
    expect(isFromRegistry('type: git, repo: git@github.com:someone/thing.git')).toBe(false)
  })
})
