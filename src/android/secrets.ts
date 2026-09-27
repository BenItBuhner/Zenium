import type { SecretStore } from '../core/platform'
import type { Bridge } from './bridge'

/** Kotlin's rejection prefix for a store that cannot seal (`Secrets.kt`, `UNAVAILABLE_PREFIX`); the words after it name the reason. */
export const SECRETS_UNAVAILABLE_PREFIX = 'secrets-unavailable:'

/**
 * The core's `platform.secrets` on Android (the desktop's `SafeStorageSecrets`): `secrets.get /
 * set / delete` over the bridge, answered by `Secrets.kt` – each value sealed with an AES-256-GCM
 * key in the Android Keystore, the sealed texts in a private preferences file. Always present on
 * the phone, so `webdavAvailable()` reads a field at boot and nothing is opened until the engine's
 * first call. A value that does not open any more, and a Keystore that cannot be used, both read
 * as `null` (the engine then asks for the password again); only a write into an unusable Keystore
 * refuses – rethrown here with the prefix stripped, and the engine turns any refused `secrets.set`
 * into its typed `{ reason: 'secrets' }` (`SyncSetupRefusal`, no toast) for the chrome to word,
 * so the words themselves reach no one.
 */
export class AndroidSecrets implements SecretStore {
  constructor(private readonly bridge: Bridge) {}

  async get(key: string): Promise<string | null> {
    const value = await this.bridge.call<unknown>('secrets.get', { key })
    return typeof value === 'string' ? value : null
  }

  async set(key: string, value: string): Promise<void> {
    try {
      await this.bridge.call<void>('secrets.set', { key, value })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.startsWith(SECRETS_UNAVAILABLE_PREFIX))
        throw new Error(
          message.slice(SECRETS_UNAVAILABLE_PREFIX.length).trim() ||
            'The password cannot be kept on this device'
        )
      throw error
    }
  }

  delete(key: string): Promise<void> {
    return this.bridge.call<void>('secrets.delete', { key })
  }
}
