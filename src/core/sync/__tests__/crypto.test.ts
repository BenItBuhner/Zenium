import { describe, expect, it } from 'vitest'
import { toBase64 } from '../../credentials/crypto'
import {
  SCRYPT_PARAMS,
  decryptJson,
  deriveKey,
  encryptJson,
  isEnvelope,
  newSalt,
  passphraseBytes
} from '../crypto'

const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i])

describe('sync crypto (Web Crypto + scrypt-js, the code both hosts run)', () => {
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
  }, 60_000)

  it('rejects a wrong passphrase and tampered ciphertext', async () => {
    const salt = newSalt()
    const env = await encryptJson(await deriveKey('one', salt), salt, { hello: 'world' })
    await expect(decryptJson(await deriveKey('two', salt), env)).rejects.toThrow()
    const tampered = {
      ...env,
      ciphertext: env.ciphertext.replace(/^./, (c) => (c === 'A' ? 'B' : 'A'))
    }
    await expect(decryptJson(await deriveKey('one', salt), tampered)).rejects.toThrow()
  }, 60_000)

  it('normalises the passphrase so composed / decomposed unicode derive the same key', async () => {
    const salt = newSalt()
    expect(
      bytesEqual(await deriveKey('caf\u00e9', salt), await deriveKey('cafe\u0301', salt))
    ).toBe(true)
    expect(passphraseBytes('cafe\u0301')).toEqual(passphraseBytes('caf\u00e9'))
  }, 60_000)

  it('rejects a malformed envelope before touching the cipher', async () => {
    const salt = newSalt()
    const key = await deriveKey('one', salt)
    const env = await encryptJson(key, salt, { a: 1 })
    await expect(decryptJson(key, { ...env, iv: toBase64(new Uint8Array(4)) })).rejects.toThrow(
      /malformed/
    )
    await expect(decryptJson(new Uint8Array(16), env)).rejects.toThrow(/32-byte/)
  }, 60_000)

  it("uses a host's own scrypt when given, with the engine's parameters", async () => {
    const salt = newSalt()
    const calls: Array<{ N: number; r: number; p: number; dkLen: number; salt: string }> = []
    const fixed = new Uint8Array(32).fill(7)
    const hostScrypt = async (
      _password: Uint8Array,
      saltBytes: Uint8Array,
      params: typeof SCRYPT_PARAMS
    ): Promise<Uint8Array> => {
      calls.push({ ...params, salt: toBase64(saltBytes) })
      return fixed
    }
    const key = await deriveKey('anything', salt, hostScrypt)
    expect(calls).toEqual([{ N: 32768, r: 8, p: 1, dkLen: 32, salt }])
    expect(key).toBe(fixed)
    // A key from one path opens what the other sealed: the cipher does not care who derived it.
    const env = await encryptJson(key, salt, { via: 'host' })
    await expect(decryptJson(fixed, env)).resolves.toEqual({ via: 'host' })
  })

  it('writes 12-byte IVs and 16-byte tags as separate fields (the pre-move envelope)', async () => {
    const salt = newSalt()
    const key = new Uint8Array(32).fill(1)
    const env = await encryptJson(key, salt, { n: 1 })
    expect(env.v).toBe(1)
    expect(env.salt).toBe(salt)
    expect(Buffer.from(env.iv, 'base64').length).toBe(12)
    expect(Buffer.from(env.tag, 'base64').length).toBe(16)
    expect(Object.keys(env).sort()).toEqual(['ciphertext', 'iv', 'salt', 'tag', 'v'])
  })
})
