import { describe, expect, it } from 'vitest'
import {
  FirefoxLoginsError,
  PRIMARY_PASSWORD_NEEDED,
  WRONG_PRIMARY_PASSWORD,
  deriveFirefoxKey,
  firefoxLogins
} from '../firefoxLogins'
import { firefoxLoginsJson, firefoxVault } from './firefoxFixtures'
import { memoryDatabase } from './helpers'

const NOW = Date.UTC(2026, 8, 20)
const CREATED = Date.UTC(2024, 0, 2)
const USED = Date.UTC(2025, 5, 1)
const CHANGED = Date.UTC(2024, 6, 6)

describe('firefoxLogins: key4.db + logins.json', () => {
  it('opens a PBES2/AES-256 store with the empty default primary password', () => {
    const vault = firefoxVault({ algo: 'pbes2' })
    const db = memoryDatabase(vault.key4)
    const master = deriveFirefoxKey(db, '')
    db.close()
    const json = firefoxLoginsJson([
      {
        hostname: 'https://example.com',
        encryptedUsername: vault.seal('bennett'),
        encryptedPassword: vault.seal('hunter2'),
        formSubmitURL: 'https://example.com',
        timeCreated: CREATED,
        timeLastUsed: USED
      },
      {
        hostname: 'https://intranet.example',
        encryptedUsername: vault.seal('admin'),
        encryptedPassword: vault.seal('s3cret'),
        httpRealm: 'Intranet',
        formSubmitURL: null
      }
    ])
    const read = firefoxLogins(json, master, NOW)
    expect(read).toEqual({
      unreadable: 0,
      invalid: 0,
      logins: [
        {
          url: 'https://example.com',
          username: 'bennett',
          password: 'hunter2',
          notes: '',
          createdAt: CREATED,
          lastUsedAt: USED
        },
        {
          url: 'https://intranet.example',
          username: 'admin',
          password: 's3cret',
          notes: '',
          realm: 'Intranet'
        }
      ]
    })
  })

  it('verifies a set primary password and rejects the wrong one with a message', () => {
    const vault = firefoxVault({ algo: 'pbes2', password: 'hunter2' })
    const db = memoryDatabase(vault.key4)
    // No password given where one is set: the message says to enter it; a wrong one says wrong.
    expect(() => deriveFirefoxKey(db, '')).toThrow(FirefoxLoginsError)
    expect(() => deriveFirefoxKey(db, '')).toThrowError(PRIMARY_PASSWORD_NEEDED)
    expect(() => deriveFirefoxKey(db, 'guess')).toThrowError(WRONG_PRIMARY_PASSWORD)
    expect(() => deriveFirefoxKey(db, 'guess')).toThrowError('The primary password is wrong.')
    const master = deriveFirefoxKey(db, 'hunter2')
    db.close()
    const json = firefoxLoginsJson([
      {
        hostname: 'https://a.example',
        encryptedUsername: vault.seal('u'),
        encryptedPassword: vault.seal('p'),
        formSubmitURL: 'https://a.example'
      }
    ])
    expect(firefoxLogins(json, master, NOW).logins[0]).toMatchObject({
      username: 'u',
      password: 'p'
    })
  })

  it('opens the legacy 3DES store shape too', () => {
    const vault = firefoxVault({ algo: '3des', password: 'primary' })
    const db = memoryDatabase(vault.key4)
    expect(() => deriveFirefoxKey(db, 'nope')).toThrowError('The primary password is wrong.')
    const master = deriveFirefoxKey(db, 'primary')
    db.close()
    const json = firefoxLoginsJson([
      {
        hostname: 'https://legacy.example',
        encryptedUsername: vault.seal('old'),
        encryptedPassword: vault.seal('timer'),
        formSubmitURL: 'https://legacy.example'
      }
    ])
    expect(firefoxLogins(json, master, NOW).logins[0]).toMatchObject({
      username: 'old',
      password: 'timer'
    })
  })

  it('falls back to timePasswordChanged when timeCreated is absent', () => {
    const vault = firefoxVault()
    const db = memoryDatabase(vault.key4)
    const master = deriveFirefoxKey(db, '')
    db.close()
    const json = firefoxLoginsJson([
      {
        hostname: 'https://c.example',
        encryptedUsername: vault.seal('u'),
        encryptedPassword: vault.seal('p'),
        formSubmitURL: 'https://c.example',
        timePasswordChanged: CHANGED
      }
    ])
    expect(firefoxLogins(json, master, NOW).logins[0].createdAt).toBe(CHANGED)
  })

  it('counts invalid and unreadable rows instead of throwing', () => {
    const vault = firefoxVault()
    const db = memoryDatabase(vault.key4)
    const master = deriveFirefoxKey(db, '')
    db.close()
    const json = firefoxLoginsJson([
      {
        hostname: 'ftp://nope',
        encryptedUsername: vault.seal('x'),
        encryptedPassword: vault.seal('y')
      },
      {
        hostname: 'https://ok.example',
        encryptedUsername: vault.seal('u'),
        encryptedPassword: '!!!',
        formSubmitURL: 'https://ok.example'
      },
      {
        hostname: 'https://empty.example',
        encryptedUsername: vault.seal('u'),
        encryptedPassword: vault.seal(''),
        formSubmitURL: 'https://empty.example'
      },
      {
        // Sealed under a key this store does not hold (the blob names another key id).
        hostname: 'https://foreign.example',
        encryptedUsername: vault.seal('u'),
        encryptedPassword: vault.sealForeign('p'),
        formSubmitURL: 'https://foreign.example'
      }
    ])
    const read = firefoxLogins(json, master, NOW)
    expect(read.logins).toEqual([])
    expect(read.invalid).toBe(2)
    expect(read.unreadable).toBe(2)
  })

  it('reports a corrupt key store as a typed error', () => {
    const db = memoryDatabase((native) => {
      native.exec('CREATE TABLE metaData (id TEXT, item1 BLOB, item2 BLOB)')
    })
    expect(() => deriveFirefoxKey(db, '')).toThrow(FirefoxLoginsError)
    db.close()
  })

  it('says the profile has no key store when no row carries the SDR key id', () => {
    const vault = firefoxVault()
    const db = memoryDatabase((native) => {
      vault.key4(native)
      // Only the decoy row is left: the password-check still verifies, the key is not there.
      native.exec("DELETE FROM nssPrivate WHERE a102 = X'f8000000000000000000000000000001'")
    })
    expect(() => deriveFirefoxKey(db, '')).toThrowError('Firefox has no key store in this profile.')
    db.close()
  })

  it('says the key store is malformed when the unwrapped key is too short', () => {
    for (const short of [8, 16]) {
      // 16 bytes pad to a whole AES block of 32: the length is judged after the pad is stripped.
      const vault = firefoxVault({ masterKey: new Uint8Array(short) })
      const db = memoryDatabase(vault.key4)
      expect(() => deriveFirefoxKey(db, '')).toThrowError('Firefox’s key store is malformed.')
      db.close()
    }
  })

  it('compares the whole unpadded verifier, as NSS does', () => {
    const vault = firefoxVault({ passwordCheck: 'password-checkXYZ' })
    const db = memoryDatabase(vault.key4)
    expect(() => deriveFirefoxKey(db, '')).toThrowError(PRIMARY_PASSWORD_NEEDED)
    db.close()
  })

  it('reports a ciphertext that is not whole blocks as the store malformed, in its own words', () => {
    for (const algo of ['pbes2', '3des'] as const) {
      const vault = firefoxVault({ algo, clipCipherText: true })
      const db = memoryDatabase(vault.key4)
      let caught: unknown
      try {
        deriveFirefoxKey(db, '')
      } catch (error) {
        caught = error
      }
      db.close()
      expect(caught).toBeInstanceOf(FirefoxLoginsError)
      expect((caught as FirefoxLoginsError).kind).toBe('corrupt')
      expect((caught as Error).message).toBe('Firefox’s key store is malformed.')
    }
  })

  it('refuses a derivation it does not have as unsupported, not as a wrong password', () => {
    const cases = [
      // hmacWithSHA1 as the PBKDF2 PRF: PKCS#5 allows it, NSS never writes it.
      { options: { prf: '1.2.840.113549.2.7' }, kind: 'unsupported' },
      // The legacy PBE with a count other than the one NSS wrote.
      { options: { algo: '3des' as const, legacyIterations: 2 }, kind: 'unsupported' },
      // More PBKDF2 rounds than any NSS store asks for: refused before the derivation runs.
      { options: { iterations: 1_000_001 }, kind: 'unsupported' }
    ]
    for (const { options, kind } of cases) {
      const vault = firefoxVault(options)
      const db = memoryDatabase(vault.key4)
      let caught: unknown
      try {
        deriveFirefoxKey(db, '')
      } catch (error) {
        caught = error
      }
      db.close()
      expect(caught).toBeInstanceOf(FirefoxLoginsError)
      expect((caught as FirefoxLoginsError).kind).toBe(kind)
      expect((caught as Error).message).toMatch(/^key4\.db (uses an unknown|has unexpected)/)
    }
    // The count NSS writes for the empty password opens as any other.
    const one = firefoxVault({ iterations: 1 })
    const db = memoryDatabase(one.key4)
    expect(deriveFirefoxKey(db, '').key).toEqual(one.masterKey)
    db.close()
  })
})
