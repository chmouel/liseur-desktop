import { safeStorage } from 'electron'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { dataDir } from './paths'

/**
 * Server credential store, backed by the OS keychain (Electron safeStorage:
 * Keychain on macOS, DPAPI on Windows, libsecret on Linux). Ciphertext lives
 * in `secrets.json` in the data dir — never in SQLite, never plaintext, and
 * never exposed to the renderer. Decrypted headers are forwarded to the
 * worker in memory only.
 *
 * On Linux without a keyring, Electron falls back to a hardcoded key
 * ("basic" encryption) — documented in ARCHITECTURE.md's threat model.
 */

export interface StoredCredential {
  headers: Record<string, string>
  extra?: Record<string, string> | undefined
}

interface SecretsFile {
  version: 1
  secrets: Record<string, { cipher: string; plain?: boolean }>
}

export class SecretStore {
  private cache: SecretsFile | undefined

  private file(): string {
    return join(dataDir(), 'secrets.json')
  }

  private load(): SecretsFile {
    if (this.cache) return this.cache
    try {
      this.cache = JSON.parse(readFileSync(this.file(), 'utf8')) as SecretsFile
    } catch {
      this.cache = { version: 1, secrets: {} }
    }
    return this.cache
  }

  private persist(): void {
    mkdirSync(dataDir(), { recursive: true })
    writeFileSync(this.file(), JSON.stringify(this.load()), { mode: 0o600 })
  }

  set(serverId: string, credential: StoredCredential): void {
    // Threat model: never plaintext. On a system without a keychain we
    // refuse to persist rather than fall back to obfuscation — the user gets
    // a clear error from the setup flow instead of silent weak storage. The
    // LISEUR_ALLOW_INSECURE_SECRETS escape hatch exists for tests/CI only.
    const insecureOk = process.env.LISEUR_ALLOW_INSECURE_SECRETS === '1'
    const store = this.load()
    if (safeStorage.isEncryptionAvailable()) {
      store.secrets[serverId] = {
        cipher: safeStorage.encryptString(JSON.stringify(credential)).toString('base64'),
      }
    } else if (insecureOk) {
      store.secrets[serverId] = {
        cipher: Buffer.from(JSON.stringify(credential), 'utf8').toString('base64'),
        plain: true,
      }
    } else {
      throw new Error('secure credential storage is unavailable on this system')
    }
    this.persist()
  }

  get(serverId: string): StoredCredential | null {
    const entry = this.load().secrets[serverId]
    if (!entry) return null
    try {
      const raw = Buffer.from(entry.cipher, 'base64')
      const text = entry.plain ? raw.toString('utf8') : safeStorage.decryptString(raw)
      return JSON.parse(text) as StoredCredential
    } catch {
      return null
    }
  }

  delete(serverId: string): void {
    const store = this.load()
    if (store.secrets[serverId]) {
      delete store.secrets[serverId]
      this.persist()
    }
  }

  has(serverId: string): boolean {
    return this.load().secrets[serverId] !== undefined
  }

  /** All credentials, for pushing to a freshly spawned worker. */
  all(): Record<string, StoredCredential> {
    const out: Record<string, StoredCredential> = {}
    for (const serverId of Object.keys(this.load().secrets)) {
      const credential = this.get(serverId)
      if (credential) out[serverId] = credential
    }
    return out
  }
}

export const secretStore = new SecretStore()
