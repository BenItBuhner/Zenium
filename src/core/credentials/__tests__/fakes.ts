import type { Credential } from '../../../shared/types'
import { emptyLeakFields } from '../../../shared/types'
import { KeyWrapError } from '../../platform'
import type { KdfParams, KeyWrapFailure, KeyWrapHost, StoreIO } from '../../platform'
import { fromBase64, open, seal, toBase64 } from '../crypto'
import { pbkdf2Sha256 } from '../kdf'

/** Few enough PBKDF2 rounds to keep the suite fast; the vault records whatever the host says. */
export const TEST_KDF: KdfParams = { kdf: 'pbkdf2-sha256', iterations: 1_000 }

/** In-memory documents with the same contract as the hosts' atomic file writers. */
export class MemoryIO implements StoreIO {
  readonly documents = new Map<string, string>()
  writes = 0
  /** When set, `write` and `writeSync` fail with it (a full disk, a read-only profile). */
  failure: Error | null = null
  /** When true, `write` never settles (a stalled disk); `hung` counts such writes. */
  hang = false
  hung = 0

  readSync(name: string): string | null {
    return this.documents.get(name) ?? null
  }

  async write(name: string, text: string): Promise<void> {
    if (this.failure) throw this.failure
    if (this.hang) {
      this.hung++
      return new Promise<void>(() => {})
    }
    this.writes++
    this.documents.set(name, text)
  }

  writeSync(name: string, text: string): void {
    if (this.failure) throw this.failure
    this.writes++
    this.documents.set(name, text)
  }
}

/**
 * A stand-in for the OS keystore: wraps under a random device key held in memory, so a blob only
 * unwraps on the "device" that wrote it, and refuses when `available` is false or when the key
 * demands an interactive authentication.
 */
export class FakeKeyWrap implements KeyWrapHost {
  private readonly deviceKey = crypto.getRandomValues(new Uint8Array(32))
  available = true
  /** When true, silent unwraps fail like an authentication-bound Keystore key would. */
  requiresInteraction = false
  /** When set, every interactive `wrap` / `unwrap` refuses with this failure (a dismissed prompt…). */
  refuse: KeyWrapFailure | null = null
  wraps = 0
  unwraps = 0

  async osAvailable(): Promise<boolean> {
    return this.available
  }

  async wrap(dataKey: Uint8Array): Promise<string> {
    if (!this.available) throw new KeyWrapError('unavailable', 'keystore unavailable')
    if (this.refuse) throw new KeyWrapError(this.refuse, `refused: ${this.refuse}`)
    this.wraps++
    const box = await seal(this.deviceKey, dataKey, 'fake-keystore')
    return `fake:${box.nonce}:${box.data}`
  }

  async unwrap(blob: string, interactive: boolean): Promise<Uint8Array> {
    if (!this.available) throw new KeyWrapError('unavailable', 'keystore unavailable')
    if (this.requiresInteraction && !interactive)
      throw new KeyWrapError('unavailable', 'authentication required')
    if (this.refuse) throw new KeyWrapError(this.refuse, `refused: ${this.refuse}`)
    this.unwraps++
    const [tag, nonce, data] = blob.split(':')
    if (tag !== 'fake' || !nonce || !data)
      throw new KeyWrapError('invalidated', 'not a blob from this device')
    return open(this.deviceKey, { nonce, data }, 'fake-keystore')
  }

  kdfParams(): KdfParams {
    return TEST_KDF
  }

  async deriveKey(passphrase: string, salt: Uint8Array, params: KdfParams): Promise<Uint8Array> {
    if (params.kdf !== 'pbkdf2-sha256') throw new Error('this host only derives PBKDF2 keys')
    return pbkdf2Sha256(passphrase, salt, params.iterations)
  }
}

let counter = 0

export function credential(overrides: Partial<Credential> = {}): Credential {
  counter++
  return {
    id: overrides.id ?? `login_${counter}`,
    origin: 'https://example.com',
    url: 'https://example.com/login',
    username: `user${counter}`,
    password: `secret-${counter}`,
    realm: null,
    notes: '',
    createdAt: 1_700_000_000_000 + counter,
    updatedAt: 1_700_000_000_000 + counter,
    lastUsedAt: null,
    ...emptyLeakFields(),
    ...overrides
  }
}

/** Flip one bit inside a base64 string's payload. */
export function corruptBase64(text: string): string {
  const bytes = fromBase64(text)
  bytes[Math.floor(bytes.length / 2)] ^= 0x01
  return toBase64(bytes)
}
