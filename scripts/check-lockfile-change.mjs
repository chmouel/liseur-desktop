// Guards the one moment a supply-chain attack can enter this repository: a
// change to pnpm-lock.yaml.
//
// pnpm's fourteen-day cooldown applies when a version is first resolved, but
// installs trust the committed lockfile rather than re-checking every entry in
// it (see pnpm-workspace.yaml). That trust has to be earned somewhere, and
// this is where. Given the lockfile as it stood before the change, this:
//
//   - lists what was added and removed, so a reviewer reads a summary instead
//     of four thousand lines of YAML;
//   - asks the registry how old every newly added version is, and fails on
//     anything published inside the cooldown;
//   - fails on any added entry that does not come from the registry.
//
// Usage: node scripts/check-lockfile-change.mjs <old-lockfile> <new-lockfile>

import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export const COOLDOWN_DAYS = 14

const REGISTRY = 'https://registry.npmjs.org'

/**
 * Pulls the package entries out of a pnpm lockfile.
 *
 * The lockfile is YAML, and parsing it properly would mean adding a YAML
 * dependency to a script whose entire job is to be suspicious of
 * dependencies. The shape needed here is narrow enough to read directly:
 * under the top-level `packages:` map every entry is a two-space-indented key
 * of the form `name@version`, quoted when it contains characters YAML
 * dislikes, with an indented `resolution:` line beneath it.
 *
 * @param {string} text contents of a pnpm-lock.yaml
 * @returns {Map<string, { name: string, version: string, resolution: string }>}
 */
export function parseLockfile(text) {
  const entries = new Map()
  let inPackages = false
  let current = null

  for (const line of text.split('\n')) {
    if (/^[a-zA-Z]/.test(line)) {
      inPackages = line.startsWith('packages:')
      current = null
      continue
    }
    if (!inPackages) continue

    const key = line.match(/^ {2}'?([^'\s][^']*?)'?:\s*$/)
    if (key) {
      const spec = key[1]
      // A version may carry a peer-dependency suffix in parentheses, which
      // has @ signs of its own — strip it before looking for the separator.
      const bare = spec.replace(/\(.*\)$/, '')
      const at = bare.lastIndexOf('@')
      if (at <= 0) {
        current = null
        continue
      }
      current = {
        name: bare.slice(0, at),
        version: bare.slice(at + 1),
        resolution: '',
      }
      entries.set(spec, current)
      continue
    }

    const resolution = line.match(/^\s+resolution:\s*\{(.*)\}\s*$/)
    if (resolution && current) current.resolution = resolution[1]
  }

  return entries
}

/**
 * A resolution without an integrity hash did not come from the registry: it is
 * a git URL or a bare tarball, neither of which has been through any of the
 * registry's checks, and neither of which any dependency here has a reason to
 * want. pnpm's blockExoticSubdeps refuses these too; this is the second lock
 * on the same door.
 *
 * @param {string} resolution the contents of the resolution braces
 */
export function isFromRegistry(resolution) {
  return /\bintegrity:/.test(resolution)
}

/**
 * Asks the registry when a version was published.
 *
 * @param {string} name
 * @param {string} version
 * @returns {Promise<Date | null>} null when the registry will not say
 */
async function publishedAt(name, version) {
  // The abbreviated metadata document is smaller but carries no publish
  // times, so the full packument is the only source for this.
  const response = await fetch(`${REGISTRY}/${name.replace('/', '%2f')}`)
  if (!response.ok) return null
  const time = (await response.json()).time?.[version]
  return time ? new Date(time) : null
}

async function main(oldPath, newPath) {
  const before = parseLockfile(readFileSync(oldPath, 'utf8'))
  const after = parseLockfile(readFileSync(newPath, 'utf8'))

  const added = [...after.keys()].filter((spec) => !before.has(spec)).sort()
  const removed = [...before.keys()].filter((spec) => !after.has(spec)).sort()

  if (!added.length && !removed.length) {
    console.log('The lockfile lists exactly the same packages as before.')
    return 0
  }

  console.log('## Lockfile change\n')
  console.log(`${added.length} added, ${removed.length} removed.\n`)
  if (added.length) console.log(`### Added\n\n${added.map((s) => `  + ${s}`).join('\n')}\n`)
  if (removed.length) console.log(`### Removed\n\n${removed.map((s) => `  - ${s}`).join('\n')}\n`)

  const problems = []

  for (const spec of added) {
    const { resolution } = after.get(spec)
    if (resolution && !isFromRegistry(resolution)) {
      problems.push(`${spec} does not come from the registry: {${resolution}}`)
    }
  }

  // The cooldown, applied to what the change actually introduces. Versions
  // already in the lockfile are left alone: they were checked when they
  // arrived, and they do not grow more dangerous with age.
  const cutoff = new Date(Date.now() - COOLDOWN_DAYS * 24 * 60 * 60 * 1000)
  const versions = new Map()
  for (const spec of added) {
    const { name, version } = after.get(spec)
    versions.set(`${name}@${version}`, { name, version })
  }

  if (versions.size) {
    console.log('### Age of added versions\n')
    console.log(`Anything published after ${cutoff.toISOString().slice(0, 10)} is too new.\n`)
  }

  for (const { name, version } of versions.values()) {
    const published = await publishedAt(name, version)
    if (!published) {
      // Failing closed. A version the registry will not date is a version
      // whose age cannot be vouched for, and age is the whole point here.
      console.log(`  ✗ ${name}@${version} — the registry does not say when this was published`)
      problems.push(`${name}@${version} could not be dated against the registry`)
      continue
    }
    const days = Math.floor((Date.now() - published.getTime()) / 86400000)
    const plural = days === 1 ? '' : 's'
    const tooNew = published > cutoff
    console.log(`  ${tooNew ? '✗' : '✓'} ${name}@${version} — ${days} day${plural} old`)
    if (tooNew) {
      problems.push(
        `${name}@${version} was published ${days} day${plural} ago, ` +
          `inside the ${COOLDOWN_DAYS}-day cooldown`,
      )
    }
  }

  if (problems.length) {
    console.log('')
    for (const problem of problems) console.log(`::error::${problem}`)
    console.log(
      '\nThe cooldown exists because malicious releases are usually found and removed ' +
        'within days. If this update is a security fix that genuinely cannot wait, name ' +
        'the package in minimumReleaseAgeExclude in pnpm-workspace.yaml, and empty that ' +
        'list again in the same pull request.',
    )
    return 1
  }

  console.log('\nEverything the lockfile adds has aged past the cooldown.')
  return 0
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [oldPath, newPath] = process.argv.slice(2)
  if (!oldPath || !newPath) {
    console.error('usage: check-lockfile-change.mjs <old-lockfile> <new-lockfile>')
    process.exit(2)
  }
  process.exit(await main(oldPath, newPath))
}
