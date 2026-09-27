import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoreIO } from '../../../core/platform'

/**
 * The desktop's secret store (ID-32) over a fake `safeStorage`, on the one platform where the
 * store has a stance of its own: a Linux without a secret service, whose `basic_text` backend
 * throws on every encrypt until `setUsePlainTextEncryption(true)` is called. The store calls it
 * once, before its first encrypt, and the app password is kept (Chrome's basic obfuscation for a
 * revocable app password); a backend with a keyring is left alone.
 */

interface FakeSafeStorage {
  backend: 'basic_text' | 'gnome_libsecret'
  plainText: boolean
  plainTextCalls: number
  isAsyncEncryptionAvailable(): Promise<boolean>
  isEncryptionAvailable(): boolean
  encryptString(text: string): Buffer
  decryptString(buffer: Buffer): string
  getSelectedStorageBackend(): string
  setUsePlainTextEncryption(value: boolean): void
}

const fake = vi.hoisted((): FakeSafeStorage => ({
  backend: 'basic_text',
  plainText: false,
  plainTextCalls: 0,
  async isAsyncEncryptionAvailable() {
    return false
  },
  isEncryptionAvailable() {
    return this.backend !== 'basic_text' || this.plainText
  },
  encryptString(text) {
    if (this.backend === 'basic_text' && !this.plainText)
      throw new Error('Error while encrypting the text provided to safeStorage.encryptString.')
    return Buffer.from(`enc:${text}`, 'utf8')
  },
  decryptString(buffer) {
    if (this.backend === 'basic_text' && !this.plainText)
      throw new Error(
        'Error while decrypting the ciphertext provided to safeStorage.decryptString.'
      )
    return buffer.toString('utf8').replace(/^enc:/, '')
  },
  getSelectedStorageBackend() {
    return this.backend
  },
  setUsePlainTextEncryption(value) {
    this.plainTextCalls += 1
    this.plainText = value
  }
}))

vi.mock('electron', () => ({ safeStorage: fake }))

function memoryIo(): StoreIO & { files: Map<string, string> } {
  const files = new Map<string, string>()
  return {
    files,
    readSync: (name) => files.get(name) ?? null,
    write: async (name, text) => {
      files.set(name, text)
    },
    writeSync: (name, text) => {
      files.set(name, text)
    }
  }
}

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!

function onPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value, configurable: true })
}

async function freshStore(io: StoreIO): Promise<import('../secrets').SafeStorageSecrets> {
  // The "once" lives with the module: every test starts it over.
  vi.resetModules()
  const { SafeStorageSecrets } = await import('../secrets')
  return new SafeStorageSecrets(io)
}

beforeEach(() => {
  fake.backend = 'basic_text'
  fake.plainText = false
  fake.plainTextCalls = 0
})

afterEach(() => {
  Object.defineProperty(process, 'platform', platform)
})

describe('SafeStorageSecrets on a Linux without a secret service', () => {
  it('turns the basic_text backend on once, before the first encrypt, and the app password is kept', async () => {
    onPlatform('linux')
    const io = memoryIo()
    const store = await freshStore(io)
    await store.set('sync.webdav.password', 'app-pass')
    await store.set('other', 'value')
    expect(fake.plainTextCalls).toBe(1)
    expect(fake.plainText).toBe(true)
    expect(await store.get('sync.webdav.password')).toBe('app-pass')
    expect(await store.get('other')).toBe('value')
    // Encrypted through safeStorage, never the value itself in the document.
    const document = io.files.get('secrets.json')!
    expect(document).not.toContain('app-pass')
    expect(document).toContain('safeStorage:')

    // A read on a fresh start (the module over again, the document as written) turns it on too.
    const again = await freshStore(io)
    expect(fake.plainTextCalls).toBe(1)
    fake.plainText = false
    expect(await again.get('sync.webdav.password')).toBe('app-pass')
    expect(fake.plainTextCalls).toBe(2)
  })

  it('leaves a keyring backend alone, and is not asked off Linux', async () => {
    onPlatform('linux')
    fake.backend = 'gnome_libsecret'
    const store = await freshStore(memoryIo())
    await store.set('sync.webdav.password', 'app-pass')
    expect(fake.plainTextCalls).toBe(0)
    expect(await store.get('sync.webdav.password')).toBe('app-pass')

    onPlatform('darwin')
    fake.backend = 'basic_text'
    fake.plainText = true
    const mac = await freshStore(memoryIo())
    await mac.set('sync.webdav.password', 'app-pass')
    expect(fake.plainTextCalls).toBe(0)
  })

  it('a store that still cannot encrypt rejects the set, for the engine to turn into its typed refusal', async () => {
    onPlatform('linux')
    fake.setUsePlainTextEncryption = () => {
      throw new Error('not offered')
    }
    try {
      const store = await freshStore(memoryIo())
      await expect(store.set('sync.webdav.password', 'app-pass')).rejects.toThrow(
        'Error while encrypting'
      )
      expect(await store.get('sync.webdav.password')).toBeNull()
    } finally {
      fake.setUsePlainTextEncryption = function (value) {
        this.plainTextCalls += 1
        this.plainText = value
      }
    }
  })
})
