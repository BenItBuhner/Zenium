import { describe, expect, it } from 'vitest'
import { newDataKey } from '../crypto'
import {
  VAULT_FORMAT,
  VAULT_VERSION,
  VaultError,
  decodeVault,
  encodeVault,
  encryptEntry,
  newVaultId,
  parseVaultFile,
  sealManifest,
  unwrapWithPassphrase,
  wrapWithPassphrase,
  type VaultFile
} from '../vault'
import { FakeKeyWrap, TEST_KDF, corruptBase64, credential } from './fakes'

async function sampleVault(): Promise<{
  key: Uint8Array
  file: VaultFile
  logins: ReturnType<typeof credential>[]
}> {
  const key = newDataKey()
  const logins = [
    credential({ id: 'a', origin: 'https://one.example', username: 'ada.lovelace' }),
    credential({ id: 'b', origin: 'https://two.example', username: 'bob', notes: 'work' }),
    credential({
      id: 'c',
      origin: 'https://one.example',
      username: 'ada.lovelace',
      realm: 'Admin',
      lastUsedAt: 5
    })
  ]
  const file = await encodeVault(
    key,
    {
      vaultId: newVaultId(),
      createdAt: 1_700_000_000_000,
      keyWrap: { os: 'blob', passphrase: null }
    },
    logins,
    ['ads.example'],
    1_700_000_000_500
  )
  return { key, file, logins }
}

async function expectVaultError(
  promise: Promise<unknown>,
  code: VaultError['code']
): Promise<void> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e
  )
  expect(error).toBeInstanceOf(VaultError)
  expect((error as VaultError).code).toBe(code)
}

describe('vault format', () => {
  it('encodes and decodes every login and the never-save list', async () => {
    const { key, file, logins } = await sampleVault()
    expect(file.format).toBe(VAULT_FORMAT)
    expect(file.version).toBe(VAULT_VERSION)
    expect(file.entries.map((e) => e.id)).toEqual(['a', 'b', 'c'])
    expect(file.updatedAt).toBe(1_700_000_000_500)
    const decoded = await decodeVault(key, file)
    expect(decoded.credentials).toEqual(logins)
    expect(decoded.neverSave).toEqual(['ads.example'])
  })

  it('keeps no plaintext anywhere in the document', async () => {
    const { file } = await sampleVault()
    const text = JSON.stringify(file)
    // Every probe contains a '.' or '-', which base64 never emits, so a random
    // ciphertext can never match one by chance.
    expect(text).not.toContain('secret-')
    expect(text).not.toContain('ada.lovelace')
    expect(text).not.toContain('one.example')
    expect(text).not.toContain('ads.example')
  })

  it('survives a JSON round trip through the parser', async () => {
    const { key, file } = await sampleVault()
    const parsed = parseVaultFile(JSON.stringify(file))
    expect(parsed).toEqual(file)
    expect((await decodeVault(key, parsed)).credentials).toHaveLength(3)
  })

  it('reports a wrong key without guessing', async () => {
    const { file } = await sampleVault()
    await expectVaultError(decodeVault(newDataKey(), file), 'wrong-key')
  })

  it('detects a tampered entry', async () => {
    const { key, file } = await sampleVault()
    const tampered = structuredClone(file)
    tampered.entries[1].data = corruptBase64(tampered.entries[1].data)
    await expectVaultError(decodeVault(key, tampered), 'tampered')
  })

  it('detects an entry moved to another id', async () => {
    const { key, file } = await sampleVault()
    const swapped = structuredClone(file)
    const [a, b] = swapped.entries
    swapped.entries[0] = { ...b, id: a.id }
    swapped.entries[1] = { ...a, id: b.id }
    await expectVaultError(decodeVault(key, swapped), 'tampered')
  })

  it('detects a removed, a duplicated and a foreign entry', async () => {
    const { key, file } = await sampleVault()
    const removed = structuredClone(file)
    removed.entries.splice(1, 1)
    await expectVaultError(decodeVault(key, removed), 'tampered')

    const duplicated = structuredClone(file)
    duplicated.entries.push({ ...duplicated.entries[0] })
    await expectVaultError(decodeVault(key, duplicated), 'tampered')

    const foreign = structuredClone(file)
    foreign.entries.push(await encryptEntry(key, 'another-vault', credential({ id: 'z' })))
    await expectVaultError(decodeVault(key, foreign), 'tampered')
  })

  it('detects an entry copied from another vault under the same key', async () => {
    const { key, file } = await sampleVault()
    const other = await encryptEntry(key, newVaultId(), credential({ id: 'a' }))
    const grafted = structuredClone(file)
    grafted.entries[0] = other
    await expectVaultError(decodeVault(key, grafted), 'tampered')
  })

  it('detects a stale manifest', async () => {
    const { key, file } = await sampleVault()
    const stale = structuredClone(file)
    stale.manifest = await sealManifest(key, file.vaultId, ['a', 'b'], [])
    await expectVaultError(decodeVault(key, stale), 'tampered')
  })

  it('re-seals with fresh nonces on every encode', async () => {
    const key = newDataKey()
    const meta = { vaultId: newVaultId(), createdAt: 1, keyWrap: { os: 'blob', passphrase: null } }
    const logins = [credential({ id: 'a' })]
    const first = await encodeVault(key, meta, logins, [])
    const second = await encodeVault(key, meta, logins, [])
    expect(first.entries[0].nonce).not.toBe(second.entries[0].nonce)
    expect(first.manifest.nonce).not.toBe(second.manifest.nonce)
  })
})

describe('vault document parsing', () => {
  const corrupt = (text: string, message?: string): void => {
    let error: unknown = null
    try {
      parseVaultFile(text)
    } catch (e) {
      error = e
    }
    expect(error).toBeInstanceOf(VaultError)
    expect((error as VaultError).code).toBe('corrupt')
    if (message) expect((error as VaultError).message).toContain(message)
  }

  it('rejects everything that is not a Zenium vault', async () => {
    corrupt('', 'not valid JSON')
    corrupt('{not json', 'not valid JSON')
    corrupt('null')
    corrupt('[]', 'Not a Zenium')
    corrupt(JSON.stringify({ format: 'other' }), 'Not a Zenium')
    corrupt(JSON.stringify({ format: VAULT_FORMAT, version: 99 }), 'Unsupported vault version')
    const { file } = await sampleVault()
    const drop = (key: keyof VaultFile): string => {
      const copy: Record<string, unknown> = { ...file }
      delete copy[key]
      return JSON.stringify(copy)
    }
    corrupt(drop('vaultId'), 'no id')
    corrupt(drop('keyWrap'), 'no key wrapping')
    corrupt(drop('manifest'), 'manifest is missing')
    corrupt(drop('entries'), 'entries are missing')
    corrupt(
      JSON.stringify({ ...file, keyWrap: { os: null, passphrase: null } }),
      'not wrapped at all'
    )
    corrupt(JSON.stringify({ ...file, keyWrap: { os: 42, passphrase: null } }), 'OS key wrapping')
    corrupt(
      JSON.stringify({ ...file, keyWrap: { os: null, passphrase: { salt: 'x' } } }),
      'passphrase key wrapping'
    )
    corrupt(JSON.stringify({ ...file, entries: [{ id: 'a' }] }), 'entry is malformed')
    corrupt(JSON.stringify({ ...file, entries: [{ nonce: 'a', data: 'b' }] }), 'entry is malformed')
  })

  it('tolerates missing timestamps and an unset passphrase wrapping', async () => {
    const { file } = await sampleVault()
    const loose: Record<string, unknown> = { ...file, keyWrap: { os: 'blob' } }
    delete loose.createdAt
    delete loose.updatedAt
    const parsed = parseVaultFile(JSON.stringify(loose))
    expect(parsed.createdAt).toBe(0)
    expect(parsed.updatedAt).toBe(0)
    expect(parsed.keyWrap).toEqual({ os: 'blob', passphrase: null })
  })
})

describe('passphrase key wrapping', () => {
  it('wraps and unwraps the data key with the right passphrase only', async () => {
    const host = new FakeKeyWrap()
    const vaultId = newVaultId()
    const dataKey = newDataKey()
    const wrap = await wrapWithPassphrase(host, vaultId, dataKey, 'correct horse battery staple')
    expect(wrap.params).toEqual(TEST_KDF)
    expect(atob(wrap.salt)).toHaveLength(16)
    expect(await unwrapWithPassphrase(host, vaultId, wrap, 'correct horse battery staple')).toEqual(
      dataKey
    )
    await expectVaultError(
      unwrapWithPassphrase(host, vaultId, wrap, 'Correct horse battery staple'),
      'wrong-key'
    )
    await expectVaultError(
      unwrapWithPassphrase(host, newVaultId(), wrap, 'correct horse battery staple'),
      'wrong-key'
    )
    await expectVaultError(
      unwrapWithPassphrase(
        host,
        vaultId,
        { ...wrap, box: { ...wrap.box, data: corruptBase64(wrap.box.data) } },
        'correct horse battery staple'
      ),
      'wrong-key'
    )
  })

  it('normalises the passphrase so composed and decomposed unicode both open the vault', async () => {
    const host = new FakeKeyWrap()
    const vaultId = newVaultId()
    const dataKey = newDataKey()
    const wrap = await wrapWithPassphrase(host, vaultId, dataKey, 'caf\u00e9 au lait')
    expect(await unwrapWithPassphrase(host, vaultId, wrap, 'cafe\u0301 au lait')).toEqual(dataKey)
  })

  it('salts every wrapping differently', async () => {
    const host = new FakeKeyWrap()
    const vaultId = newVaultId()
    const dataKey = newDataKey()
    const a = await wrapWithPassphrase(host, vaultId, dataKey, 'pw')
    const b = await wrapWithPassphrase(host, vaultId, dataKey, 'pw')
    expect(a.salt).not.toBe(b.salt)
    expect(a.box.data).not.toBe(b.box.data)
  })
})
