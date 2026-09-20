import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from 'node:crypto'
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { fromBase64, toBase64 } from '../../../core/credentials/crypto'
import {
  SCRYPT_PARAMS,
  decryptJson,
  deriveKey,
  deriveWithScryptJs,
  encryptJson,
  passphraseBytes,
  type EncryptedEnvelope
} from '../../../core/sync/crypto'
import { sha1Hex } from '../../../core/sync/sha1'
import { isFolderLost } from '../../../core/sync/transport'
import legacy from '../../../core/sync/__tests__/fixtures/legacy-device-file.json'
import { nodeScrypt } from '../scrypt'
import { FolderTransport, LEGACY_SYNC_DIR_NAME, SYNC_DIR_NAME } from '../transport'

/**
 * The desktop keeps node's primitives (scrypt, AES-GCM, sha1 before the move); the shared core
 * runs scrypt-js, Web Crypto and a TypeScript sha1. These tests hold the two sides together:
 * a key or a file from either host must be the other's too.
 */

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex')

function nodeScryptSync(password: Uint8Array, salt: Uint8Array): Uint8Array {
  return new Uint8Array(
    scryptSync(password, salt, SCRYPT_PARAMS.dkLen, {
      N: SCRYPT_PARAMS.N,
      r: SCRYPT_PARAMS.r,
      p: SCRYPT_PARAMS.p,
      maxmem: 128 * SCRYPT_PARAMS.N * SCRYPT_PARAMS.r * 2
    })
  )
}

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

describe('scrypt: scrypt-js (Android) against node:crypto (desktop)', () => {
  it('reproduces node scryptSync bit for bit for the engine parameters', async () => {
    for (const passphrase of ['correct horse battery staple', 'pässwörd 🔐', 'a']) {
      const salt = randomBytes(16)
      const password = passphraseBytes(passphrase)
      const js = await deriveWithScryptJs(password, salt, SCRYPT_PARAMS)
      expect(hex(js)).toBe(hex(nodeScryptSync(password, salt)))
    }
  }, 60_000)

  it("the desktop host's nodeScrypt and the shared path agree through deriveKey", async () => {
    const salt = toBase64(randomBytes(16))
    const viaNode = await deriveKey('correct horse battery staple', salt, nodeScrypt)
    const viaJs = await deriveKey('correct horse battery staple', salt)
    expect(hex(viaNode)).toBe(hex(viaJs))
    expect(viaJs.length).toBe(32)
  }, 60_000)

  it('the legacy fixture key is what node derives today (the fixture is not stale)', () => {
    const key = nodeScryptSync(passphraseBytes(legacy.passphrase), fromBase64(legacy.salt))
    expect(hex(key)).toBe(legacy.keyHex)
  })
})

describe('AES-256-GCM: Web Crypto against node:crypto', () => {
  const salt = toBase64(randomBytes(16))
  const key = new Uint8Array(scryptSync('shared', fromBase64(salt), 32, { N: 1024, r: 8, p: 1 }))

  it('node-written envelopes (the desktop before the move) decrypt over Web Crypto', async () => {
    const env = nodeEncrypt(key, salt, { v: 1, records: [{ id: 'x', modified: 3 }] })
    await expect(decryptJson(key, env)).resolves.toEqual({
      v: 1,
      records: [{ id: 'x', modified: 3 }]
    })
  })

  it('Web Crypto envelopes (the phone) decrypt with node:crypto, tag split as before', async () => {
    const env = await encryptJson(key, salt, { hello: 'from the phone', n: [1, 2, 3] })
    expect(fromBase64(env.tag).length).toBe(16)
    expect(fromBase64(env.iv).length).toBe(12)
    expect(nodeDecrypt(key, env)).toEqual({ hello: 'from the phone', n: [1, 2, 3] })
  })

  it('the legacy device file decrypts with node too (both hosts read the same folder)', () => {
    const key = new Uint8Array(Buffer.from(legacy.keyHex, 'hex'))
    const payload = nodeDecrypt<unknown>(key, legacy.deviceFile.envelope as EncryptedEnvelope)
    expect(JSON.stringify(payload)).toBe(legacy.plaintext)
  })
})

describe('sha1: the TypeScript implementation against node:crypto', () => {
  it('agrees on every length class and on unicode', () => {
    for (const text of [
      '',
      'abc',
      'a'.repeat(55),
      'a'.repeat(56),
      'a'.repeat(63),
      'a'.repeat(64),
      'a'.repeat(65),
      'a'.repeat(1000),
      '💼 émoji and ünïcode ✓',
      legacy.plaintext
    ]) {
      expect(sha1Hex(text)).toBe(createHash('sha1').update(text, 'utf8').digest('hex'))
    }
  })
})

describe('FolderTransport (node:fs)', () => {
  const roots: string[] = []
  const root = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'zenium-sync-'))
    roots.push(dir)
    return dir
  }
  afterEach(() => {
    for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('lists, reads, writes atomically, removes and wipes under <root>/zenium-sync', async () => {
    const dir = root()
    const t = new FolderTransport(dir)
    expect(await t.list()).toEqual([])
    expect(await t.read('a.zensync')).toBeNull()
    await t.write('a.zensync', '{"a":1}')
    await t.write('README.txt', 'hello')
    expect(readdirSync(join(dir, SYNC_DIR_NAME)).sort()).toEqual(['README.txt', 'a.zensync'])
    expect((await t.list()).sort()).toEqual(['README.txt', 'a.zensync'])
    expect(await t.read('a.zensync')).toBe('{"a":1}')
    await t.write('a.zensync', '{"a":2}')
    expect(await t.read('a.zensync')).toBe('{"a":2}')
    // No temp file survives a write.
    expect(readdirSync(join(dir, SYNC_DIR_NAME)).some((n) => n.includes('.tmp-'))).toBe(false)
    await t.remove('a.zensync')
    expect(await t.list()).toEqual(['README.txt'])
    await t.remove('missing.zensync')
    await t.removeAll()
    expect(await t.list()).toEqual([])
  })

  it('refuses names that escape the directory', async () => {
    const t = new FolderTransport(root())
    await expect(t.read('../x')).rejects.toThrow(/invalid sync document name/)
    await expect(t.write('a/b', 'x')).rejects.toThrow(/invalid sync document name/)
  })

  it('takes over a zen-sync folder from before the rename', async () => {
    const dir = root()
    mkdirSync(join(dir, LEGACY_SYNC_DIR_NAME))
    writeFileSync(join(dir, LEGACY_SYNC_DIR_NAME, 'old.zensync'), '{"old":true}')
    const t = new FolderTransport(dir)
    expect(await t.read('old.zensync')).toBe('{"old":true}')
    expect(readdirSync(dir)).toEqual([SYNC_DIR_NAME])
  })

  it('reports a root that went away as the folder being lost', async () => {
    const dir = root()
    const t = new FolderTransport(dir)
    await t.write('a.zensync', '1')
    rmSync(dir, { recursive: true, force: true })
    await expect(t.list()).rejects.toSatisfy(isFolderLost)
    await expect(t.write('a.zensync', '2')).rejects.toSatisfy(isFolderLost)
    await expect(t.read('a.zensync')).rejects.toSatisfy(isFolderLost)
  })

  it('notifies a watcher when another device writes a file', async () => {
    const dir = root()
    const t = new FolderTransport(dir)
    await t.write('README.txt', 'x')
    let fired = 0
    const stop = t.watch(() => fired++)
    writeFileSync(join(dir, SYNC_DIR_NAME, 'peer.zensync'), '{"peer":1}')
    await new Promise((r) => setTimeout(r, 2200))
    stop()
    expect(fired).toBeGreaterThanOrEqual(1)
  }, 10_000)
})
