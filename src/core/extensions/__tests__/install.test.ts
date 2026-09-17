import { describe, expect, it } from 'vitest'
import {
  base64Encode,
  extensionIdFromPublicKey,
  extensionIdFromSeed,
  utf8Decode,
  utf8Encode
} from '../bytes'
import { CrxError } from '../crx'
import {
  InstallError,
  checkForUpdate,
  checkForUpdates,
  installFromCrx,
  installFromZip,
  writeExtensionFiles,
  type ExtensionPackage,
  type UpdateSource
} from '../install'
import type { StoreFetch } from '../store'
import { buildCrx, buildZip, generateRsaKey, sampleExtensionZip, type ZipInput } from './helpers'

const developer = generateRsaKey()
const options = { chromiumVersion: '152.0.0.0' }

async function manifestOf(pkg: ExtensionPackage): Promise<Record<string, unknown>> {
  const file = pkg.files.find((f) => f.path === 'manifest.json')
  if (!file) throw new Error('no manifest file in package')
  return JSON.parse(utf8Decode(await file.bytes())) as Record<string, unknown>
}

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    if (error instanceof InstallError || error instanceof CrxError) return error.code
    throw error
  }
  throw new Error('expected rejection')
}

describe('installFromCrx', () => {
  it('verifies, unpacks, validates and injects the developer key into manifest.json', async () => {
    const crx = await buildCrx({ zip: sampleExtensionZip(), rsaKeys: [developer] })
    const pkg = await installFromCrx(crx)
    expect(pkg.id).toBe(await extensionIdFromPublicKey(developer.spki))
    expect(pkg.version).toBe('1.0.0')
    expect(pkg.signed).toBe(true)
    expect(pkg.publisher).toBe('unknown')
    expect(pkg.publicKey).toEqual(developer.spki)
    expect(pkg.manifest.name).toBe('Sample')
    expect(pkg.rawManifest.key).toBeUndefined()
    expect(pkg.files.map((f) => f.path).sort()).toEqual(['background.js', 'manifest.json'])
    expect(pkg.rootPrefix).toBe('')

    const written = await manifestOf(pkg)
    expect(written.key).toBe(base64Encode(developer.spki))
    expect(written.name).toBe('Sample')
    const manifestFile = pkg.files.find((f) => f.path === 'manifest.json')
    expect(manifestFile?.size).toBe((await manifestFile!.bytes()).length)
    expect(pkg.totalSize).toBe(pkg.files.reduce((sum, f) => sum + f.size, 0))

    const sink = new Map<string, Uint8Array>()
    await writeExtensionFiles(pkg, {
      writeFile: async (path, bytes) => {
        sink.set(path, bytes)
      }
    })
    expect([...sink.keys()].sort()).toEqual(['background.js', 'manifest.json'])
    expect(utf8Decode(sink.get('background.js')!)).toBe('console.log("hi")')
  })

  it('enforces the id the user asked for', async () => {
    const crx = await buildCrx({ zip: sampleExtensionZip(), rsaKeys: [developer] })
    const id = await extensionIdFromPublicKey(developer.spki)
    await expect(installFromCrx(crx, { expectedId: id })).resolves.toBeDefined()
    expect(await code(installFromCrx(crx, { expectedId: 'a'.repeat(32) }))).toBe('id-mismatch')
  })

  it('propagates CRX failures before touching the archive', async () => {
    const crx = await buildCrx({ zip: sampleExtensionZip(), rsaKeys: [developer] })
    crx[crx.length - 1] ^= 0xff
    expect(await code(installFromCrx(crx))).toBe('bad-signature')
  })

  it('rejects archives without a root manifest or with an invalid one', async () => {
    const noManifest = await buildCrx({
      zip: buildZip([{ name: 'readme.txt', data: 'x' }]),
      rsaKeys: [developer]
    })
    expect(await code(installFromCrx(noManifest))).toBe('manifest-missing')

    const invalid = await buildCrx({
      zip: buildZip([{ name: 'manifest.json', data: '{"manifest_version":3,"name":"X"}' }]),
      rsaKeys: [developer]
    })
    const failure = await installFromCrx(invalid).catch((e: unknown) => e)
    expect(failure).toBeInstanceOf(InstallError)
    expect((failure as InstallError).code).toBe('manifest-invalid')
    expect((failure as InstallError).issues.some((i) => i.path === 'version')).toBe(true)

    const notJson = await buildCrx({
      zip: buildZip([{ name: 'manifest.json', data: 'not json' }]),
      rsaKeys: [developer]
    })
    expect(await code(installFromCrx(notJson))).toBe('manifest-invalid')
  })

  it('passes zip limits through', async () => {
    const crx = await buildCrx({ zip: sampleExtensionZip(), rsaKeys: [developer] })
    await expect(installFromCrx(crx, { limits: { maxTotalSize: 8 } })).rejects.toThrow(/limit/i)
  })
})

describe('installFromZip', () => {
  it('derives the id from the seed for unsigned archives and leaves manifest.json untouched', async () => {
    const pkg = await installFromZip(sampleExtensionZip(), { idSeed: '/home/user/ext' })
    expect(pkg.id).toBe(await extensionIdFromSeed('/home/user/ext'))
    expect(pkg.signed).toBe(false)
    expect(pkg.publisher).toBe('unknown')
    expect(pkg.publicKey).toBeNull()
    expect((await manifestOf(pkg)).key).toBeUndefined()
    const seedBytes = await installFromZip(sampleExtensionZip(), {
      idSeed: utf8Encode('/home/user/ext')
    })
    expect(seedBytes.id).toBe(pkg.id)
  })

  it('prefers manifest.key over the seed and rejects a corrupt key', async () => {
    const withKey = sampleExtensionZip({ key: base64Encode(developer.spki) })
    const pkg = await installFromZip(withKey, { idSeed: 'ignored' })
    expect(pkg.id).toBe(await extensionIdFromPublicKey(developer.spki))
    expect(pkg.publicKey).toEqual(developer.spki)
    expect(await code(installFromZip(withKey, { idSeed: 'x', expectedId: 'b'.repeat(32) }))).toBe(
      'id-mismatch'
    )
    const corrupt = await installFromZip(sampleExtensionZip({ key: '%%%' }), { idSeed: 'x' }).catch(
      (e: unknown) => e
    )
    expect(corrupt).toBeInstanceOf(InstallError)
    expect((corrupt as InstallError).code).toBe('manifest-invalid')
    expect((corrupt as InstallError).issues.map((i) => i.path)).toEqual(['key'])
  })

  it('unwraps a single top-level folder the way GitHub release archives are laid out', async () => {
    const zip = buildZip([
      { name: 'uBlock0.chromium/' },
      {
        name: 'uBlock0.chromium/manifest.json',
        data: '{"manifest_version":2,"name":"uBO","version":"1.2.3"}'
      },
      { name: 'uBlock0.chromium/js/' },
      { name: 'uBlock0.chromium/js/background.js', data: '1', method: 0 }
    ])
    const pkg = await installFromZip(zip, { idSeed: 'seed' })
    expect(pkg.rootPrefix).toBe('uBlock0.chromium/')
    expect(pkg.version).toBe('1.2.3')
    expect(pkg.files.map((f) => f.path).sort()).toEqual(['js/background.js', 'manifest.json'])
    expect(pkg.directories).toEqual(['js/'])
    expect(utf8Decode(await pkg.files.find((f) => f.path === 'js/background.js')!.bytes())).toBe(
      '1'
    )

    const twoFolders = buildZip([
      { name: 'a/manifest.json', data: '{}' },
      { name: 'b/manifest.json', data: '{}' }
    ])
    expect(await code(installFromZip(twoFolders, { idSeed: 'seed' }))).toBe('manifest-missing')
  })

  it('warns about reserved top-level names', async () => {
    const zip = buildZip([
      { name: 'manifest.json', data: '{"manifest_version":3,"name":"X","version":"1"}' },
      { name: '_private/x.js', data: '1' },
      { name: '_metadata/verified_contents.json', data: '[]' }
    ])
    const pkg = await installFromZip(zip, { idSeed: 'seed' })
    expect(pkg.warnings.map((w) => w.path)).toEqual(['_private/x.js'])
  })
})

describe('localisation', () => {
  const manifest = {
    manifest_version: 3,
    name: '__MSG_appName__',
    description: '__MSG_appDesc__',
    version: '2.0',
    default_locale: 'en',
    action: { default_title: '__MSG_missing__' }
  }
  const en = {
    appName: { message: 'Sample' },
    appDesc: { message: 'Hello $who$', placeholders: { who: { content: 'world' } } }
  }
  const de = { appName: { message: 'Beispiel' } }
  const files = (extra: ZipInput[] = []): Uint8Array =>
    buildZip([
      { name: 'manifest.json', data: JSON.stringify(manifest) },
      { name: '_locales/en/messages.json', data: JSON.stringify(en) },
      { name: '_locales/de/messages.json', data: JSON.stringify(de) },
      ...extra
    ])

  it('resolves __MSG_ references along requested locale, language, default_locale', async () => {
    const defaults = await installFromZip(files(), { idSeed: 's' })
    expect(defaults.manifest.name).toBe('Sample')
    expect(defaults.manifest.description).toBe('Hello world')
    expect(defaults.rawManifest.name).toBe('__MSG_appName__')

    const german = await installFromZip(files(), { idSeed: 's', locale: 'de-AT' })
    expect(german.manifest.name).toBe('Beispiel')
    expect(german.manifest.description).toBe('Hello world')

    const french = await installFromZip(files(), { idSeed: 's', locale: 'fr' })
    expect(french.manifest.name).toBe('Sample')
    expect(french.warnings.some((w) => w.message.includes("'missing'"))).toBe(true)
  })

  it('also localises signed packages, while manifest.json on disk keeps the raw strings', async () => {
    const crx = await buildCrx({ zip: files(), rsaKeys: [developer] })
    const pkg = await installFromCrx(crx, { locale: 'de' })
    expect(pkg.manifest.name).toBe('Beispiel')
    expect((await manifestOf(pkg)).name).toBe('__MSG_appName__')
  })

  it('requires default_locale when _locales exists and the default bundle when declared', async () => {
    const noDefault = buildZip([
      { name: 'manifest.json', data: '{"manifest_version":3,"name":"X","version":"1"}' },
      { name: '_locales/en/messages.json', data: '{}' }
    ])
    expect(await code(installFromZip(noDefault, { idSeed: 's' }))).toBe('locale-missing')

    const missingBundle = buildZip([
      { name: 'manifest.json', data: JSON.stringify({ ...manifest, default_locale: 'fr' }) },
      { name: '_locales/en/messages.json', data: JSON.stringify(en) }
    ])
    expect(await code(installFromZip(missingBundle, { idSeed: 's' }))).toBe('locale-missing')
  })

  it('tolerates a broken secondary bundle with a warning', async () => {
    const zip = buildZip([
      { name: 'manifest.json', data: JSON.stringify(manifest) },
      { name: '_locales/en/messages.json', data: JSON.stringify(en) },
      { name: '_locales/de/messages.json', data: '{ broken' }
    ])
    const pkg = await installFromZip(zip, { idSeed: 's', locale: 'de' })
    expect(pkg.manifest.name).toBe('Sample')
    expect(pkg.warnings.some((w) => w.path === '_locales/de/messages.json')).toBe(true)
  })
})

describe('update checks', () => {
  const A = 'a'.repeat(32)
  const B = 'b'.repeat(32)
  const C = 'c'.repeat(32)
  const D = 'd'.repeat(32)
  const E = 'e'.repeat(32)
  const gupdate = (apps: string): Uint8Array =>
    utf8Encode(`<?xml version="1.0"?><gupdate protocol="2.0">${apps}</gupdate>`)

  it('batches per endpoint, interprets every Omaha status and never throws', async () => {
    const calls: string[] = []
    const fetch: StoreFetch = async (url) => {
      calls.push(url)
      if (url.startsWith('https://clients2.google.com/')) {
        return {
          status: 200,
          url,
          bytes: gupdate(
            `<app appid="${A}" status="ok"><updatecheck status="ok" codebase="https://cdn/a.crx" version="2.0" hash_sha256="${'AB'.repeat(32)}" size="10"/></app>` +
              `<app appid="${B}" status="ok"><updatecheck status="noupdate"/></app>` +
              `<app appid="${C}" status="ok"><updatecheck status="ok" codebase="https://cdn/c.crx" version="1.0"/></app>`
          )
        }
      }
      if (url.startsWith('https://example.com/updates.xml')) {
        return {
          status: 200,
          url,
          bytes: gupdate(`<app appid="${D}" status="error-unknownApplication"/>`)
        }
      }
      return { status: 500, url, bytes: new Uint8Array() }
    }
    const sources: UpdateSource[] = [
      { id: A, version: '1.0', store: 'chrome-web-store' },
      { id: B, version: '1.0', updateUrl: 'https://clients2.google.com/service/update2/crx' },
      { id: C, version: '1.0', store: 'chrome-web-store' },
      { id: D, version: '1.0', updateUrl: 'https://example.com/updates.xml' },
      { id: E, version: '1.0', store: 'edge-add-ons' },
      { id: 'f'.repeat(32), version: '1.0' }
    ]
    const results = await checkForUpdates(fetch, sources, options)
    expect(calls).toHaveLength(3)
    const cws = calls.find((u) => u.startsWith('https://clients2.google.com/'))!
    expect(cws.match(/x=id%3D/g)).toHaveLength(3)
    expect(cws).toContain(`x=id%3D${A}%26v%3D1.0%26uc`)
    expect(results.get(A)).toEqual({
      status: 'update-available',
      version: '2.0',
      codebase: 'https://cdn/a.crx',
      sha256: 'ab'.repeat(32),
      size: 10
    })
    expect(results.get(B)).toEqual({ status: 'up-to-date' })
    expect(results.get(C)).toEqual({ status: 'up-to-date' })
    expect(results.get(D)).toEqual({ status: 'error', reason: 'error-unknownApplication' })
    expect(results.get(E)).toEqual({ status: 'error', reason: 'http' })
    expect(results.get('f'.repeat(32))).toEqual({ status: 'error', reason: 'no-update-source' })
  })

  it('reports extensions the server omitted, malformed XML and thrown fetches as errors', async () => {
    const omitted: StoreFetch = async (url) => ({ status: 200, url, bytes: gupdate('') })
    expect(
      await checkForUpdate(omitted, { id: A, version: '1', store: 'edge-add-ons' }, options)
    ).toEqual({
      status: 'error',
      reason: 'not-in-response'
    })
    const garbage: StoreFetch = async (url) => ({ status: 200, url, bytes: utf8Encode('<html/>') })
    expect(
      await checkForUpdate(garbage, { id: A, version: '1', store: 'edge-add-ons' }, options)
    ).toEqual({
      status: 'error',
      reason: 'bad-response'
    })
    const offline: StoreFetch = async () => {
      throw new TypeError('fetch failed')
    }
    expect(
      await checkForUpdate(offline, { id: A, version: '1', store: 'edge-add-ons' }, options)
    ).toEqual({
      status: 'error',
      reason: 'network'
    })
    const badVersion: StoreFetch = async (url) => ({
      status: 200,
      url,
      bytes: gupdate(
        `<app appid="${A}" status="ok"><updatecheck status="ok" codebase="https://x" version="v2"/></app>`
      )
    })
    expect(
      await checkForUpdate(badVersion, { id: A, version: '1', store: 'edge-add-ons' }, options)
    ).toEqual({
      status: 'error',
      reason: 'bad-version'
    })
  })
})
