import { describe, expect, it, vi } from 'vitest'
// The release pipeline signs manifests with Node's crypto; this proves tweetnacl accepts them.
// eslint-disable-next-line no-restricted-imports
import { generateKeyPairSync, sign } from 'node:crypto'
import { UpdateService, verifyManifestSignature } from '../updates'
import type { UpdateHost } from '../platform'
import type { Browser } from '../browser'
import {
  UPDATE_REPOSITORY,
  sanitizeUpdateSettings,
  type UpdateProgress,
  type UpdateSettings,
  type UpdateTarget
} from '../../shared/updates'

const BASE = `https://github.com/${UPDATE_REPOSITORY}/releases/download/v0.2.0`
const LATEST = `https://github.com/${UPDATE_REPOSITORY}/releases/latest/download`

function manifestFor(version: string, extra: Record<string, unknown> = {}): string {
  const base = `https://github.com/${UPDATE_REPOSITORY}/releases/download/v${version}`
  return JSON.stringify({
    schemaVersion: 1,
    name: 'Zen on Chromium',
    version,
    tag: `v${version}`,
    prerelease: version.includes('-'),
    publishedAt: '2026-09-16T10:00:00Z',
    commit: 'abc',
    releaseUrl: `https://github.com/${UPDATE_REPOSITORY}/releases/tag/v${version}`,
    notesUrl: `https://github.com/${UPDATE_REPOSITORY}/releases/tag/v${version}`,
    checksumsUrl: `${base}/SHA256SUMS.txt`,
    assets: [
      {
        os: 'windows',
        arch: 'x64',
        kind: 'nsis',
        name: `zen-chromium-${version}-x64-setup.exe`,
        url: `${base}/zen-chromium-${version}-x64-setup.exe`,
        size: 1000,
        sha256: 'c'.repeat(64),
        signed: false
      },
      {
        os: 'android',
        arch: 'universal',
        kind: 'apk',
        name: `zen-chromium-${version}.apk`,
        url: `${base}/zen-chromium-${version}.apk`,
        size: 2000,
        sha256: 'd'.repeat(64),
        signed: true,
        signer: 'e'.repeat(64)
      }
    ],
    feeds: {},
    ...extra
  })
}

/** Ed25519 key pair the way the release pipeline makes one (Node crypto, raw key for the app). */
function keyPair(): { privateKeyPem: string; publicKeyBase64: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const spki = publicKey.export({ type: 'spki', format: 'der' })
  return {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKeyBase64: spki.subarray(spki.length - 32).toString('base64')
  }
}

function signManifest(text: string, privateKeyPem: string, publicKeyBase64: string): string {
  return JSON.stringify({
    algorithm: 'ed25519',
    publicKey: publicKeyBase64,
    signature: sign(null, Buffer.from(text, 'utf8'), privateKeyPem).toString('base64')
  })
}

describe('verifyManifestSignature', () => {
  const { privateKeyPem, publicKeyBase64 } = keyPair()
  const text = manifestFor('0.2.0')
  const envelope = JSON.parse(signManifest(text, privateKeyPem, publicKeyBase64))

  it('accepts a signature made with a pinned key', () => {
    expect(verifyManifestSignature(text, envelope, [publicKeyBase64])).toBe(true)
    // Rotation: several pinned keys, any of them may have signed.
    expect(
      verifyManifestSignature(text, envelope, [keyPair().publicKeyBase64, publicKeyBase64])
    ).toBe(true)
  })

  it('rejects tampering, foreign keys and malformed envelopes', () => {
    expect(
      verifyManifestSignature(text.replace('0.2.0', '0.2.1'), envelope, [publicKeyBase64])
    ).toBe(false)
    expect(verifyManifestSignature(text, envelope, [keyPair().publicKeyBase64])).toBe(false)
    expect(verifyManifestSignature(text, envelope, [])).toBe(false)
    expect(
      verifyManifestSignature(text, { ...envelope, algorithm: 'rsa' }, [publicKeyBase64])
    ).toBe(false)
    expect(
      verifyManifestSignature(text, { ...envelope, signature: 'AAAA' }, [publicKeyBase64])
    ).toBe(false)
    expect(verifyManifestSignature(text, null, [publicKeyBase64])).toBe(false)
    // An envelope naming another key than ours is not even tried against ours.
    expect(
      verifyManifestSignature(text, { ...envelope, publicKey: keyPair().publicKeyBase64 }, [
        publicKeyBase64
      ])
    ).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

type Responses = Record<string, { ok: boolean; status: number; text: string } | (() => never)>

class FakeHost implements UpdateHost {
  keys: string[] = []
  installedSigner: string | null = null
  installedPackage: string | null = null
  downloads = 0
  installs: Array<string | null> = []
  cancelled = false
  private reject: ((error: Error) => void) | null = null

  constructor(private readonly kind: UpdateTarget) {}

  target(): UpdateTarget {
    return this.kind
  }

  publicKeys(): string[] {
    return this.keys
  }

  signer(): string | null {
    return this.installedSigner
  }

  packageName(): string | null {
    return this.installedPackage
  }

  download(
    _r: unknown,
    _a: unknown,
    onProgress: (p: UpdateProgress) => void
  ): Promise<string | null> {
    this.downloads++
    onProgress({ percent: 50, transferred: 500, total: 1000, bytesPerSecond: 100 })
    return new Promise((resolve, reject) => {
      this.reject = reject
      setTimeout(() => {
        this.reject = null
        resolve(this.kind.kind === 'apk' ? '/cache/updates/zen.apk' : null)
      }, 5)
    })
  }

  async install(_r: unknown, path: string | null): Promise<void> {
    this.installs.push(path)
  }

  cancel(): void {
    this.cancelled = true
    const error = new Error('cancelled')
    error.name = 'AbortError'
    this.reject?.(error)
  }
}

function fakeBrowser(
  version: string,
  responses: Responses,
  settings: Partial<UpdateSettings> = {}
): { browser: Browser; toasts: string[]; opened: string[]; fetched: string[] } {
  const toasts: string[] = []
  const opened: string[] = []
  const fetched: string[] = []
  const browser = {
    platform: {
      info: { os: 'win32', version },
      net: {
        fetchText: async (url: string) => {
          fetched.push(url)
          const response = responses[url]
          if (!response) return { ok: false, status: 404, text: '' }
          if (typeof response === 'function') return response()
          return response
        }
      }
    },
    state: {
      settings: { updates: sanitizeUpdateSettings(settings) },
      commitVolatile: vi.fn()
    },
    toast: (message: string) => {
      toasts.push(message)
    },
    openExternalUrl: (url: string) => {
      opened.push(url)
    },
    flushSync: vi.fn()
  }
  return { browser: browser as unknown as Browser, toasts, opened, fetched }
}

async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !predicate(); i++) await new Promise((r) => setTimeout(r, 2))
  expect(predicate()).toBe(true)
}

const NSIS: UpdateTarget = { os: 'windows', arch: 'x64', kind: 'nsis' }

describe('UpdateService', () => {
  it('finds a newer release on stable, downloads it in the background and stages it', async () => {
    const host = new FakeHost(NSIS)
    const { browser, toasts, fetched } = fakeBrowser('0.1.0', {
      [`${LATEST}/update-manifest.json`]: { ok: true, status: 200, text: manifestFor('0.2.0') }
    })
    const service = new UpdateService(browser, host)
    expect(service.status().mode).toBe('in-place')
    await service.check({ manual: false })
    expect(fetched).toEqual([`${LATEST}/update-manifest.json`])
    const found = service.status()
    expect(['available', 'downloading', 'ready']).toContain(found.phase)
    expect(found.release?.version).toBe('0.2.0')
    expect(found.release?.asset?.url).toBe(`${BASE}/zen-chromium-0.2.0-x64-setup.exe`)
    expect(found.signature).toBe('unenforced')
    await until(() => service.status().phase === 'ready')
    expect(host.downloads).toBe(1)
    expect(service.status().progress?.percent).toBe(100)
    expect(toasts.at(-1)).toMatch(/ready – restart/)
    await service.install()
    expect(host.installs).toEqual([null])
    expect(browser.flushSync).toHaveBeenCalled()
  })

  it('reports up to date and a friendly error when nothing was released yet', async () => {
    const host = new FakeHost(NSIS)
    const same = fakeBrowser('0.2.0', {
      [`${LATEST}/update-manifest.json`]: { ok: true, status: 200, text: manifestFor('0.2.0') }
    })
    const service = new UpdateService(same.browser, host)
    await service.check({ manual: true })
    expect(service.status().phase).toBe('up-to-date')
    expect(same.toasts).toEqual(['Zenium 0.2.0 is up to date.'])

    const none = fakeBrowser('0.1.0', {})
    const service2 = new UpdateService(none.browser, host)
    await service2.check({ manual: true })
    expect(service2.status().phase).toBe('error')
    expect(service2.status().error).toBe('no release has been published yet')
    expect(none.toasts[0]).toMatch(/Could not check/)
  })

  it('uses the release list on the beta channel and takes pre-releases', async () => {
    const host = new FakeHost(NSIS)
    const list = JSON.stringify([
      {
        tag_name: 'v0.2.0-beta.1',
        prerelease: true,
        assets: [
          {
            name: 'update-manifest.json',
            browser_download_url: `https://github.com/${UPDATE_REPOSITORY}/releases/download/v0.2.0-beta.1/update-manifest.json`
          }
        ]
      },
      { tag_name: 'v0.1.0', prerelease: false, assets: [] }
    ])
    const { browser } = fakeBrowser(
      '0.1.0',
      {
        [`https://api.github.com/repos/${UPDATE_REPOSITORY}/releases?per_page=30`]: {
          ok: true,
          status: 200,
          text: list
        },
        [`https://github.com/${UPDATE_REPOSITORY}/releases/download/v0.2.0-beta.1/update-manifest.json`]:
          { ok: true, status: 200, text: manifestFor('0.2.0-beta.1') }
      },
      { channel: 'beta', autoDownload: false }
    )
    const service = new UpdateService(browser, host)
    await service.check({ manual: false })
    expect(service.status().phase).toBe('available')
    expect(service.status().release?.tag).toBe('v0.2.0-beta.1')
    expect(host.downloads).toBe(0)
    // The list had no entry for the running 0.1.0: nothing for What's new.
    expect(service.status().notes).toBeNull()
  })

  it('keeps the running version’s notes from the beta list – the highlights alone – for What’s new, on the same request (SET-54)', async () => {
    const host = new FakeHost(NSIS)
    const list = JSON.stringify([
      {
        tag_name: 'v0.2.0-beta.1',
        prerelease: true,
        body: '## Highlights\n\n- Newer things.\n\n## Downloads\n\n| a |',
        assets: [
          {
            name: 'update-manifest.json',
            browser_download_url: `https://github.com/${UPDATE_REPOSITORY}/releases/download/v0.2.0-beta.1/update-manifest.json`
          }
        ]
      },
      {
        tag_name: 'v0.1.0',
        prerelease: false,
        body: '## Highlights\n\n- **Spaces** arrived.\n\n## Downloads\n\n| a |',
        assets: []
      }
    ])
    const { browser, fetched } = fakeBrowser(
      '0.1.0',
      {
        [`https://api.github.com/repos/${UPDATE_REPOSITORY}/releases?per_page=30`]: {
          ok: true,
          status: 200,
          text: list
        },
        [`https://github.com/${UPDATE_REPOSITORY}/releases/download/v0.2.0-beta.1/update-manifest.json`]:
          { ok: true, status: 200, text: manifestFor('0.2.0-beta.1') }
      },
      { channel: 'beta', autoDownload: false }
    )
    const service = new UpdateService(browser, host)
    expect(service.status().notes).toBeNull()
    await service.check({ manual: false })
    expect(service.status().phase).toBe('available')
    expect(service.status().notes).toEqual({ version: '0.1.0', text: '- **Spaces** arrived.' })
    // Two requests, the check's own: the list and the manifest – none for the notes.
    expect(fetched).toHaveLength(2)
  })

  it('reads the notes off the stable manifest when it is the running version’s and carries them, and keeps them across a check that brings none', async () => {
    const host = new FakeHost(NSIS)
    const withNotes = JSON.parse(manifestFor('0.1.0')) as Record<string, unknown>
    withNotes.notes = '## Highlights\n\n- Here.\n\n## Downloads'
    const responses: Responses = {
      [`${LATEST}/update-manifest.json`]: { ok: true, status: 200, text: JSON.stringify(withNotes) }
    }
    const noted = fakeBrowser('0.1.0', responses, { autoDownload: false })
    const service = new UpdateService(noted.browser, host)
    await service.check({ manual: false })
    expect(service.status().phase).toBe('up-to-date')
    expect(service.status().notes).toEqual({ version: '0.1.0', text: '- Here.' })
    // The next check finds a manifest without notes (a newer release's): the running version's stay.
    responses[`${LATEST}/update-manifest.json`] = {
      ok: true,
      status: 200,
      text: manifestFor('0.2.0')
    }
    await service.check({ manual: false })
    expect(service.status().phase).toBe('available')
    expect(service.status().notes).toEqual({ version: '0.1.0', text: '- Here.' })
  })

  it('refuses unsigned or badly signed manifests when a key is built in', async () => {
    const { privateKeyPem, publicKeyBase64 } = keyPair()
    const text = manifestFor('0.2.0')
    const host = new FakeHost(NSIS)
    host.keys = [publicKeyBase64]

    const unsigned = fakeBrowser('0.1.0', {
      [`${LATEST}/update-manifest.json`]: { ok: true, status: 200, text }
    })
    const s1 = new UpdateService(unsigned.browser, host)
    await s1.check({ manual: false })
    expect(s1.status().phase).toBe('error')
    expect(s1.status().error).toMatch(/not signed/)

    const forged = fakeBrowser('0.1.0', {
      [`${LATEST}/update-manifest.json`]: { ok: true, status: 200, text },
      [`${LATEST}/update-manifest.json.sig`]: {
        ok: true,
        status: 200,
        text: signManifest(text, keyPair().privateKeyPem, publicKeyBase64)
      }
    })
    const s2 = new UpdateService(forged.browser, host)
    await s2.check({ manual: false })
    expect(s2.status().phase).toBe('error')
    expect(s2.status().error).toMatch(/does not match/)

    const good = fakeBrowser(
      '0.1.0',
      {
        [`${LATEST}/update-manifest.json`]: { ok: true, status: 200, text },
        [`${LATEST}/update-manifest.json.sig`]: {
          ok: true,
          status: 200,
          text: signManifest(text, privateKeyPem, publicKeyBase64)
        }
      },
      { autoDownload: false }
    )
    const s3 = new UpdateService(good.browser, host)
    await s3.check({ manual: false })
    expect(s3.status().phase).toBe('available')
    expect(s3.status().signature).toBe('verified')
  })

  it('rejects a manifest whose packages live outside the repository', async () => {
    const host = new FakeHost(NSIS)
    const text = manifestFor('0.2.0').replace(
      `${BASE}/zen-chromium-0.2.0-x64-setup.exe`,
      'https://cdn.example.com/zen-chromium-0.2.0-x64-setup.exe'
    )
    const { browser } = fakeBrowser('0.1.0', {
      [`${LATEST}/update-manifest.json`]: { ok: true, status: 200, text }
    })
    const service = new UpdateService(browser, host)
    await service.check({ manual: false })
    expect(service.status().phase).toBe('error')
    expect(service.status().error).toMatch(/not a download of release/)
  })

  it('returns to "available" when a download is cancelled', async () => {
    const host = new FakeHost(NSIS)
    const { browser } = fakeBrowser(
      '0.1.0',
      { [`${LATEST}/update-manifest.json`]: { ok: true, status: 200, text: manifestFor('0.2.0') } },
      { autoDownload: false }
    )
    const service = new UpdateService(browser, host)
    await service.check({ manual: true })
    expect(service.status().phase).toBe('available')
    const download = service.download()
    expect(service.status().phase).toBe('downloading')
    service.cancel()
    await download
    expect(host.cancelled).toBe(true)
    expect(service.status().phase).toBe('available')
    expect(service.status().error).toBeNull()
  })

  it('flags an Android release signed with another key and never downloads it', async () => {
    const host = new FakeHost({ os: 'android', arch: 'universal', kind: 'apk' })
    host.installedSigner = 'f'.repeat(64)
    const { browser, toasts } = fakeBrowser('0.1.0', {
      [`${LATEST}/update-manifest.json`]: { ok: true, status: 200, text: manifestFor('0.2.0') }
    })
    const service = new UpdateService(browser, host)
    await service.check({ manual: false })
    expect(service.status().phase).toBe('available')
    expect(service.status().mode).toBe('installer')
    expect(service.status().signerMismatch).toBe(true)
    await service.download()
    expect(host.downloads).toBe(0)
    expect(toasts.at(-1)).toMatch(/different key/)

    host.installedSigner = 'e'.repeat(64)
    const matching = new UpdateService(browser, host)
    await matching.check({ manual: false })
    expect(matching.status().signerMismatch).toBe(false)
    await matching.download()
    expect(matching.status().phase).toBe('ready')
    expect(matching.status().downloadedPath).toBe('/cache/updates/zen.apk')
    await matching.install()
    expect(host.installs).toEqual(['/cache/updates/zen.apk'])
  })

  it('treats an APK with another applicationId as a new app, whatever its key', async () => {
    const host = new FakeHost({ os: 'android', arch: 'universal', kind: 'apk' })
    host.installedSigner = 'f'.repeat(64) // not the release's 'e' key
    host.installedPackage = 'app.zen.chromium'
    const renamed = manifestFor('0.2.0').replace(
      '"signer":"eeee',
      '"packageName":"io.github.benitbuhner.zenium","signer":"eeee'
    )
    expect(renamed).toContain('io.github.benitbuhner.zenium')
    const { browser, toasts } = fakeBrowser('0.1.0', {
      [`${LATEST}/update-manifest.json`]: { ok: true, status: 200, text: renamed }
    })
    const service = new UpdateService(browser, host)
    await service.check({ manual: false })
    expect(service.status().phase).toBe('available')
    expect(service.status().release?.asset?.packageName).toBe('io.github.benitbuhner.zenium')
    expect(service.status().packageChange).toBe(true)
    // The key comparison is meaningless for a different package: it must not block the download.
    expect(service.status().signerMismatch).toBe(false)
    expect(toasts.at(-1)).toMatch(/new app/)
    await service.download()
    expect(host.downloads).toBe(1)
    expect(service.status().phase).toBe('ready')
    expect(toasts.at(-1)).toMatch(/alongside/)

    // Same applicationId: the signer check applies as before.
    host.installedPackage = 'io.github.benitbuhner.zenium'
    const same = new UpdateService(browser, host)
    await same.check({ manual: false })
    expect(same.status().packageChange).toBe(false)
    expect(same.status().signerMismatch).toBe(true)

    // Manifests from before the field existed carry no packageName: only the key decides.
    host.installedSigner = 'e'.repeat(64)
    const { browser: browser2 } = fakeBrowser('0.1.0', {
      [`${LATEST}/update-manifest.json`]: { ok: true, status: 200, text: manifestFor('0.2.0') }
    })
    const old = new UpdateService(browser2, host)
    await old.check({ manual: false })
    expect(old.status().packageChange).toBe(false)
    expect(old.status().signerMismatch).toBe(false)
  })

  it('opens the release page for builds that cannot update themselves', async () => {
    const host = new FakeHost({ os: 'linux', arch: 'x64', kind: 'unpacked' })
    const { browser, opened } = fakeBrowser('0.1.0', {
      [`${LATEST}/update-manifest.json`]: { ok: true, status: 200, text: manifestFor('0.2.0') }
    })
    const service = new UpdateService(browser, host)
    await service.check({ manual: false })
    expect(service.status().mode).toBe('manual')
    expect(service.status().phase).toBe('available')
    await service.download()
    expect(host.downloads).toBe(0)
    expect(opened).toEqual([`https://github.com/${UPDATE_REPOSITORY}/releases/tag/v0.2.0`])
  })

  it('forgets the previous result when the channel changes', async () => {
    const host = new FakeHost(NSIS)
    const { browser } = fakeBrowser(
      '0.1.0',
      { [`${LATEST}/update-manifest.json`]: { ok: true, status: 200, text: manifestFor('0.2.0') } },
      { autoDownload: false, autoCheck: false }
    )
    const service = new UpdateService(browser, host)
    await service.check({ manual: true })
    expect(service.status().phase).toBe('available')
    browser.state.settings.updates.channel = 'beta'
    service.onSettingsChanged()
    expect(service.status().phase).toBe('idle')
    expect(service.status().channel).toBe('beta')
    expect(service.status().release).toBeNull()
    service.stop()
  })
})
