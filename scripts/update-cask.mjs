// Points the Homebrew cask at a release that has just been published.
//
// The cask in Casks/liseur.rb is what `brew install` and `brew upgrade` read,
// and Homebrew reads it from the default branch rather than from a tag, so it
// has to be rewritten in place after every release or the tap keeps serving
// the previous version for ever.
//
// Only the version and the four checksums move. The rest of the cask — the
// URL, the artifacts, the caveats — is written by hand and is left alone.
// Every substitution is checked, and anything that does not match is an error
// rather than a silent no-op: a cask carrying last release's checksums would
// fail to install for everybody, and would do so long after the release that
// caused it.
//
// Usage: node scripts/update-cask.mjs <version> <SHA256SUMS> [cask]

import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export const CASK_PATH = 'Casks/liseur.rb'

/**
 * Which downloaded file each checksum in the cask stands for.
 *
 * The keys are Homebrew's names for the four platform/architecture pairs; the
 * values build the file names electron-builder produces. Note that macOS says
 * `x64` where the AppImage says `x86_64` for the same processor.
 *
 * @type {Record<string, (version: string) => string>}
 */
export const ASSETS = {
  arm: (version) => `liseur-desktop-${version}-mac-arm64.dmg`,
  intel: (version) => `liseur-desktop-${version}-mac-x64.dmg`,
  arm64_linux: (version) => `liseur-desktop-${version}-linux-arm64.AppImage`,
  x86_64_linux: (version) => `liseur-desktop-${version}-linux-x86_64.AppImage`,
}

/**
 * Reads a `sha256sum` file: one line per file, checksum first, then the name.
 *
 * @param {string} text contents of a SHA256SUMS file
 * @returns {Map<string, string>} file name to checksum
 */
export function parseChecksums(text) {
  const sums = new Map()
  for (const line of text.split('\n')) {
    // The separator is two spaces, or a space and a mode character, and the
    // name may itself contain spaces.
    const match = line.match(/^([0-9a-f]{64}) [ *](.+)$/)
    if (match) sums.set(match[2].trim(), match[1])
  }
  return sums
}

/**
 * Rewrites the version and the checksums of a cask.
 *
 * @param {string} cask contents of Casks/liseur.rb
 * @param {string} version the released version, without a leading v
 * @param {Map<string, string>} sums file name to checksum, from parseChecksums
 * @returns {string} the rewritten cask
 * @throws when the cask does not have the shape this expects, or when the
 *   release is missing one of the four downloads
 */
export function updateCask(cask, version, sums) {
  if (!/^[0-9]+\.[0-9]+\.[0-9]+/.test(version)) {
    throw new Error(`'${version}' is not a version number`)
  }

  // Each stanza is looked for before it is replaced. Comparing the text
  // before and after would not do: rerunning this on an already-current cask
  // changes nothing, and that is success rather than a missing stanza.
  const versionStanza = /^(\s*version\s+)"[^"]*"/m
  if (!versionStanza.test(cask)) throw new Error('no version stanza in the cask')
  let updated = cask.replace(versionStanza, `$1"${version}"`)

  for (const [key, asset] of Object.entries(ASSETS)) {
    const name = asset(version)
    const sum = sums.get(name)
    if (!sum) throw new Error(`the release has no ${name}`)

    // The checksum being 64 hex characters is what tells this line apart from
    // `arch arm: "arm64"`, which mentions the same key.
    const stanza = new RegExp(`(\\b${key}:\\s+)"[0-9a-f]{64}"`)
    if (!stanza.test(updated)) throw new Error(`no ${key} checksum in the cask`)
    updated = updated.replace(stanza, `$1"${sum}"`)
  }

  return updated
}

function main(version, sumsPath, caskPath) {
  const cask = readFileSync(caskPath, 'utf8')
  const sums = parseChecksums(readFileSync(sumsPath, 'utf8'))
  const updated = updateCask(cask, version, sums)

  if (updated === cask) {
    console.log(`${caskPath} already describes ${version}.`)
    return 0
  }

  writeFileSync(caskPath, updated)
  console.log(`${caskPath} now describes ${version}:`)
  for (const [key, asset] of Object.entries(ASSETS)) {
    console.log(`  ${key.padEnd(12)} ${sums.get(asset(version))}  ${asset(version)}`)
  }
  return 0
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [version, sumsPath, caskPath = CASK_PATH] = process.argv.slice(2)
  if (!version || !sumsPath) {
    console.error('usage: update-cask.mjs <version> <SHA256SUMS> [cask]')
    process.exit(2)
  }
  process.exit(main(version.replace(/^v/, ''), sumsPath, caskPath))
}
