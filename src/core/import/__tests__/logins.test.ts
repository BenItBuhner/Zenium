import { describe, expect, it } from 'vitest'
import {
  LINUX_ITERATIONS,
  MAC_ITERATIONS,
  V10_SECRET,
  chromiumKeys,
  chromiumLogins,
  decryptChromiumPassword
} from '../chromiumLogins'
import { chromiumLoginsSchema, memoryDatabase, sealChromiumPassword } from './helpers'

const NOW = Date.UTC(2026, 8, 20)
const WEBKIT_OFFSET_US = 11_644_473_600_000_000
const webkit = (ms: number): number => ms * 1000 + WEBKIT_OFFSET_US
const T0 = Date.UTC(2024, 0, 17, 21, 20)
const KEYRING_SECRET = 'Zx9k+Q2mB7vT4nL8pR3sW6yD1fH5jK0a'

async function loginData(): Promise<ReturnType<typeof memoryDatabase>> {
  const v10 = await sealChromiumPassword('v10', V10_SECRET, LINUX_ITERATIONS, 'peanut-butter')
  const v11 = await sealChromiumPassword('v11', KEYRING_SECRET, LINUX_ITERATIONS, 'keyring-kept')
  const v11Basic = await sealChromiumPassword('v11', KEYRING_SECRET, LINUX_ITERATIONS, 'realm-pass')
  return memoryDatabase((db) => {
    chromiumLoginsSchema(db)
    const insert = db.prepare(
      `INSERT INTO logins(origin_url, action_url, username_value, password_value, signon_realm, date_created,
        blacklisted_by_user, scheme, date_last_used) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    insert.run(
      'https://accounts.example.com/login',
      'https://accounts.example.com/login',
      'bennett',
      v10,
      'https://accounts.example.com/',
      webkit(T0),
      0,
      0,
      webkit(T0 + 1000)
    )
    insert.run(
      'https://mail.example.org/',
      '',
      'b@example.org',
      v11,
      'https://mail.example.org/',
      webkit(T0 + 2000),
      0,
      0,
      0
    )
    insert.run(
      'https://router.local/',
      '',
      'admin',
      v11Basic,
      'https://router.local/Admin Area',
      webkit(T0 + 3000),
      0,
      1,
      0
    )
    insert.run(
      'https://never.example/',
      '',
      '',
      new Uint8Array(0),
      'https://never.example/',
      webkit(T0),
      1,
      0,
      0
    )
    insert.run(
      'android://hash@com.example.app/',
      '',
      'app',
      v10,
      'android://hash@com.example.app/',
      webkit(T0),
      0,
      0,
      0
    )
    insert.run(
      'https://old.example/',
      '',
      'legacy',
      new TextEncoder().encode('plain-text-row'),
      'https://old.example/',
      webkit(T0),
      0,
      0,
      0
    )
    insert.run(
      'https://dpapi.example/',
      '',
      'win',
      new Uint8Array([0x01, 0x00, 0x00, 0x00, 0xd0, 0x8c, 0x9d, 0xdf, 0x01]),
      'https://dpapi.example/',
      webkit(T0),
      0,
      0,
      0
    )
    insert.run(
      'https://v20.example/',
      '',
      'appbound',
      new TextEncoder().encode('v20garbage-bytes'),
      'https://v20.example/',
      webkit(T0),
      0,
      0,
      0
    )
  })
}

describe('Chrome / Edge Login Data', () => {
  it('opens v10 with peanuts and v11 with the keyring secret on Linux', async () => {
    const db = await loginData()
    const keys = await chromiumKeys('linux', KEYRING_SECRET)
    const result = await chromiumLogins(db, keys, NOW)
    db.close()
    expect(result.logins).toEqual([
      {
        url: 'https://accounts.example.com/login',
        username: 'bennett',
        password: 'peanut-butter',
        notes: '',
        createdAt: T0,
        lastUsedAt: T0 + 1000
      },
      {
        url: 'https://mail.example.org/',
        username: 'b@example.org',
        password: 'keyring-kept',
        notes: '',
        createdAt: T0 + 2000
      },
      {
        url: 'https://router.local/',
        username: 'admin',
        password: 'realm-pass',
        notes: '',
        realm: 'Admin Area',
        createdAt: T0 + 3000
      },
      {
        url: 'https://old.example/',
        username: 'legacy',
        password: 'plain-text-row',
        notes: '',
        createdAt: T0
      }
    ])
    // The DPAPI blob and the v20 row cannot be opened here.
    expect(result.unreadable).toBe(2)
    // The never-save entry and the Android origin.
    expect(result.invalid).toBe(2)
  })

  it('counts v11 rows unreadable when the keyring gave no secret, v10 still opens', async () => {
    const db = await loginData()
    const keys = await chromiumKeys('linux', null)
    const result = await chromiumLogins(db, keys, NOW)
    db.close()
    expect(result.logins.map((l) => l.username)).toEqual(['bennett', 'legacy'])
    expect(result.unreadable).toBe(4)
  })

  it('derives the macOS key with 1003 iterations from the Keychain secret and nothing without it', async () => {
    const sealed = await sealChromiumPassword('v10', KEYRING_SECRET, MAC_ITERATIONS, 'mac-pass')
    expect(
      await decryptChromiumPassword(sealed, await chromiumKeys('darwin', KEYRING_SECRET))
    ).toBe('mac-pass')
    expect(await decryptChromiumPassword(sealed, await chromiumKeys('darwin', null))).toBeNull()
    // The Linux peanuts key does not open a macOS row.
    expect(await decryptChromiumPassword(sealed, await chromiumKeys('linux', null))).toBeNull()
  })

  it('has no keys on Windows: every sealed row is unreadable (the DPAPI limit)', async () => {
    const keys = await chromiumKeys('win32', null)
    expect(keys).toEqual({ v10: null, v11: null })
    const sealed = await sealChromiumPassword('v10', V10_SECRET, LINUX_ITERATIONS, 'x')
    expect(await decryptChromiumPassword(sealed, keys)).toBeNull()
    expect(await decryptChromiumPassword(new Uint8Array(0), keys)).toBe('')
  })

  it('rejects a truncated ciphertext instead of throwing', async () => {
    const keys = await chromiumKeys('linux', null)
    const sealed = await sealChromiumPassword('v10', V10_SECRET, LINUX_ITERATIONS, 'peanut-butter')
    expect(await decryptChromiumPassword(sealed.subarray(0, sealed.length - 3), keys)).toBeNull()
    expect(await decryptChromiumPassword(sealed.subarray(0, 3), keys)).toBeNull()
  })
})
