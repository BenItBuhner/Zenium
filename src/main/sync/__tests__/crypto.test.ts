import { describe, expect, it } from 'vitest'
import { decryptJson, deriveKey, encryptJson, isEnvelope, newSalt } from '../crypto'

describe('sync crypto', () => {
  it('round-trips JSON with the same passphrase and salt', () => {
    const salt = newSalt()
    const key = deriveKey('correct horse battery staple', salt)
    const env = encryptJson(key, salt, { records: [{ id: 'a', modified: 1 }], v: 1 })
    expect(isEnvelope(env)).toBe(true)
    expect(env.ciphertext).not.toContain('records')
    expect(decryptJson(deriveKey('correct horse battery staple', salt), env)).toEqual({
      records: [{ id: 'a', modified: 1 }],
      v: 1
    })
  })

  it('rejects a wrong passphrase and tampered ciphertext', () => {
    const salt = newSalt()
    const env = encryptJson(deriveKey('one', salt), salt, { hello: 'world' })
    expect(() => decryptJson(deriveKey('two', salt), env)).toThrow()
    const tampered = {
      ...env,
      ciphertext: env.ciphertext.replace(/^./, (c) => (c === 'A' ? 'B' : 'A'))
    }
    expect(() => decryptJson(deriveKey('one', salt), tampered)).toThrow()
  })

  it('normalises the passphrase so composed / decomposed unicode derive the same key', () => {
    const salt = newSalt()
    expect(deriveKey('caf\u00e9', salt).equals(deriveKey('cafe\u0301', salt))).toBe(true)
  })
})
