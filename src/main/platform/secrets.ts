import { safeStorage } from 'electron'
import type { SecretStore, StoreIO } from '../../core/platform'

/**
 * The few secrets the core asks the host to keep and read back silently (a sync server's app
 * password, ID-32), each encrypted by Electron's `safeStorage` – Keychain on macOS, DPAPI on
 * Windows, the secret service on Linux – and kept together as one JSON document under the
 * profile.
 *
 * A Linux without a secret service has Electron on its `basic_text` backend, whose
 * `encryptString` / `decryptString` throw until `safeStorage.setUsePlainTextEncryption(true)` is
 * called: this store calls it once, before its first encrypt or decrypt, and keeps a revocable
 * app password behind Chrome's basic obfuscation on such a machine – what Chrome does with its
 * own Linux passwords when no keyring is offered – so the transport works there at all. The
 * password vault's key wrap is stricter and its own (`passwords.ts`, `osAvailable` says no on
 * that backend): a vault key is not an app password the user can revoke from the server.
 */

const DOCUMENT = 'secrets.json'
const BLOB_PREFIX = 'safeStorage:'

let plainTextConsidered = false

/** Once: the `basic_text` backend on Linux is told to go ahead (see the header); elsewhere nothing to set. */
function allowBasicTextOnLinux(): void {
  if (plainTextConsidered) return
  plainTextConsidered = true
  try {
    if (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')
      safeStorage.setUsePlainTextEncryption(true)
  } catch {
    // Not offered by this Electron or platform: the encrypt below says what it can do.
  }
}

async function asyncEncryption(): Promise<boolean> {
  try {
    return await safeStorage.isAsyncEncryptionAvailable()
  } catch {
    return false
  }
}

async function encrypt(value: string): Promise<string> {
  allowBasicTextOnLinux()
  const encrypted = (await asyncEncryption())
    ? await safeStorage.encryptStringAsync(value)
    : safeStorage.encryptString(value)
  return BLOB_PREFIX + encrypted.toString('base64')
}

/** `null` for a blob this device cannot read (another machine's profile, a rotated key): the secret is gone. */
async function decrypt(blob: string): Promise<string | null> {
  if (!blob.startsWith(BLOB_PREFIX)) return null
  allowBasicTextOnLinux()
  const encrypted = Buffer.from(blob.slice(BLOB_PREFIX.length), 'base64')
  try {
    if (await asyncEncryption()) {
      const { result } = await safeStorage.decryptStringAsync(encrypted)
      return result
    }
    return safeStorage.decryptString(encrypted)
  } catch {
    return null
  }
}

export class SafeStorageSecrets implements SecretStore {
  /** Writes run one after another: two `set`s in flight must not lose each other's key. */
  private queue: Promise<void> = Promise.resolve()

  constructor(private readonly io: StoreIO) {}

  async get(key: string): Promise<string | null> {
    const blob = this.load()[key]
    return typeof blob === 'string' ? decrypt(blob) : null
  }

  async set(key: string, value: string): Promise<void> {
    const blob = await encrypt(value)
    await this.update((doc) => {
      doc[key] = blob
    })
  }

  async delete(key: string): Promise<void> {
    await this.update((doc) => {
      delete doc[key]
    })
  }

  private load(): Record<string, unknown> {
    try {
      const parsed: unknown = JSON.parse(this.io.readSync(DOCUMENT) ?? '{}')
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {}
    } catch {
      return {}
    }
  }

  private update(mutate: (doc: Record<string, unknown>) => void): Promise<void> {
    const next = this.queue.then(async () => {
      const doc = this.load()
      mutate(doc)
      await this.io.write(DOCUMENT, JSON.stringify(doc))
    })
    this.queue = next.catch(() => undefined)
    return next
  }
}
