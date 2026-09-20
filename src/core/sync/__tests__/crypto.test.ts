import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { fromBase64, toBase64 } from '../../credentials/crypto'
import {
  SCRYPT_PARAMS,
  decryptJson,
  deriveKey,
  deriveWithScryptJs,
  encryptJson,
  isEnvelope,
  newSalt,
  passphraseBytes,
  type EncryptedEnvelope
} from '../crypto'

const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i])

/** What the pre-move Electron engine did with node:crypto, kept here as the reference. */
function nodeEncrypt(key: Uint8Array, salt: string, value: unknown): EncryptedEnvelope {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(value), 'utf8')),
    cipher.final()
  ])
  return {
    v: 1,
    salt,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64')
  }
}

function nodeDecrypt<T>(key: Uint8Array, env: EncryptedEnvelope): T {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(env.iv, 'base64'))
  decipher.setAuthTag(Buffer.from(env.tag, 'base64'))
  const text = Buffer.concat([
    decipher.update(Buffer.from(env.ciphertext, 'base64')),
    decipher.final()
  ]).toString('utf8')
  return JSON.parse(text) as T
}

describe('sync crypto', () => {
  it('round-trips JSON with the same passphrase and salt', async () => {
    const salt = newSalt()
    const key = await deriveKey('correct horse battery staple', salt)
    const env = await encryptJson(key, salt, { records: [{ id: 'a', modified: 1 }], v: 1 })
    expect(isEnvelope(env)).toBe(true)
    expect(env.ciphertext).not.toContain('records')
    await expect(
      decryptJson(await deriveKey('correct horse battery staple', salt), env)
    ).resolves.toEqual({
      records: [{ id: 'a', modified: 1 }],
      v: 1
    })
  })

  it('rejects a wrong passphrase and tampered ciphertext', async () => {
    const salt = newSalt()
    const env = await encryptJson(await deriveKey('one', salt), salt, { hello: 'world' })
    await expect(decryptJson(await deriveKey('two', salt), env)).rejects.toThrow()
    const tampered = {
      ...env,
      ciphertext: env.ciphertext.replace(/^./, (c) => (c === 'A' ? 'B' : 'A'))
    }
    await expect(decryptJson(await deriveKey('one', salt), tampered)).rejects.toThrow()
  })

  it('normalises the passphrase so composed / decomposed unicode derive the same key', async () => {
    const salt = newSalt()
    expect(bytesEqual(await deriveKey('caf\u00e9', salt), await deriveKey('cafe\u0301', salt))).toBe(
      true
    )
  })

  it('rejects a malformed envelope before touching the cipher', async () => {
    const salt = newSalt()
    const key = await deriveKey('one', salt)
    const env = await encryptJson(key, salt, { a: 1 })
    await expect(decryptJson(key, { ...env, iv: toBase64(new Uint8Array(4)) })).rejects.toThrow(
      /malformed/
    )
    await expect(decryptJson(new Uint8Array(16), env)).rejects.toThrow(/32-byte/)
  })
})

describe('cross-host key derivation (scrypt-js vs node:crypto)', () => {
  it('scrypt-js reproduces node scryptSync bit for bit for the engine parameters', async () => {
    for (const passphrase of ['correct horse battery staple', 'pässwörd 🔐', 'a']) {
      const salt = randomBytes(16)
      const password = passphraseBytes(passphrase)
      const js = await deriveWithScryptJs(password, salt, SCRYPT_PARAMS)
      const node = new Uint8Array(
        scryptSync(password, salt, SCRYPT_PARAMS.dkLen, {
          N: SCRYPT_PARAMS.N,
          r: SCRYPT_PARAMS.r,
          p: SCRYPT_PARAMS.p,
          maxmem: 128 * SCRYPT_PARAMS.N * SCRYPT_PARAMS.r * 2
        })
      )
      expect(toBase64(js)).toBe(toBase64(node))
    }
  }, 60_000)

  it("a host's own scrypt is used when given, the shared one otherwise", async () => {
    const salt = newSalt()
    const calls: Array<{ N: number; r: number; p: number; dkLen: number }> = []
    const hostScrypt = async (
      password: Uint8Array,
      saltBytes: Uint8Array,
      params: typeof SCRYPT_PARAMS
    ): Promise<Uint8Array> => {
      calls.push({ ...params })
      return new Uint8Array(
        scryptSync(password, saltBytes, params.dkLen, {
          N: params.N,
          r: params.r,
          p: params.p,
          maxmem: 128 * params.N * params.r * 2
        })
      )
    }
    const viaHost = await deriveKey('correct horse battery staple', salt, hostScrypt)
    const viaJs = await deriveKey('correct horse battery staple', salt)
    expect(calls).toEqual([{ N: 32768, r: 8, p: 1, dkLen: 32 }])
    expect(toBase64(viaHost)).toBe(toBase64(viaJs))
    expect(viaJs.length).toBe(32)
  }, 60_000)
})

describe('cross-host AES-GCM (Web Crypto vs node:crypto)', () => {
  const salt = newSalt()
  const key = new Uint8Array(scryptSync('shared', fromBase64(salt), 32, { N: 1024, r: 8, p: 1 }))

  it('node-written envelopes (the desktop before the move) decrypt over Web Crypto', async () => {
    const env = nodeEncrypt(key, salt, { v: 1, records: [{ id: 'x', modified: 3 }] })
    await expect(decryptJson(key, env)).resolves.toEqual({
      v: 1,
      records: [{ id: 'x', modified: 3 }]
    })
  })

  it('Web Crypto envelopes (Android) decrypt with node:crypto, tag split as before', async () => {
    const env = await encryptJson(key, salt, { hello: 'from the phone', n: [1, 2, 3] })
    expect(fromBase64(env.tag).length).toBe(16)
    expect(fromBase64(env.iv).length).toBe(12)
    expect(nodeDecrypt(key, env)).toEqual({ hello: 'from the phone', n: [1, 2, 3] })
  })
})
