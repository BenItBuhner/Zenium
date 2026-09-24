import { describe, expect, it } from 'vitest'
import {
  ANDROID_DEBUG_ID_SUFFIX,
  compareVersions,
  effectiveChannel,
  isDebugApplicationId,
  isNewerVersion,
  manifestSource,
  parseUpdateManifest,
  parseVersion,
  pickUpdateAsset,
  RELEASE_HIGHLIGHTS_MAX,
  releaseHighlights,
  releaseNotesFromList,
  sanitizeUpdateSettings,
  selectReleaseFromList,
  updateModeFor,
  UpdateManifestError,
  type UpdateTarget
} from '../updates'

const REPO = 'BenItBuhner/Zenium'
const BASE = `https://github.com/${REPO}/releases/download/v0.2.0`
const SHA = 'a'.repeat(64)

function asset(over: Record<string, unknown>): Record<string, unknown> {
  return {
    os: 'windows',
    arch: 'x64',
    kind: 'nsis',
    name: 'zen-chromium-0.2.0-x64-setup.exe',
    url: `${BASE}/zen-chromium-0.2.0-x64-setup.exe`,
    size: 100,
    sha256: SHA,
    signed: false,
    ...over
  }
}

function manifest(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    name: 'Zen on Chromium',
    version: '0.2.0',
    tag: 'v0.2.0',
    prerelease: false,
    publishedAt: '2026-09-16T10:00:00Z',
    commit: 'abc',
    releaseUrl: `https://github.com/${REPO}/releases/tag/v0.2.0`,
    notesUrl: `https://github.com/${REPO}/releases/tag/v0.2.0`,
    checksumsUrl: `${BASE}/SHA256SUMS.txt`,
    assets: [
      asset({}),
      asset({ arch: 'arm64', name: 'zen-chromium-0.2.0-arm64-setup.exe', url: `${BASE}/a.exe` }),
      asset({ os: 'macos', arch: 'arm64', kind: 'dmg', name: 'z.dmg', url: `${BASE}/z.dmg` }),
      asset({ os: 'macos', arch: 'arm64', kind: 'zip', name: 'z.zip', url: `${BASE}/z.zip` }),
      asset({
        os: 'linux',
        arch: 'x64',
        kind: 'appimage',
        name: 'z.AppImage',
        url: `${BASE}/z.AppImage`
      }),
      asset({ os: 'linux', arch: 'x64', kind: 'deb', name: 'z.deb', url: `${BASE}/z.deb` }),
      asset({
        os: 'android',
        arch: 'universal',
        kind: 'apk',
        name: 'z.apk',
        url: `${BASE}/z.apk`,
        signer: 'B'.repeat(64)
      })
    ],
    feeds: { 'windows-x64': `${BASE}/latest.yml`, evil: 'https://example.com/latest.yml' },
    ...over
  }
}

describe('versions', () => {
  it('parses semver with and without the v prefix', () => {
    expect(parseVersion('1.2.3')).toEqual({ core: [1, 2, 3], pre: null })
    expect(parseVersion('v1.2.3-beta.4')).toEqual({ core: [1, 2, 3], pre: ['beta', '4'] })
    expect(parseVersion('1.2')).toBeNull()
    expect(parseVersion('latest')).toBeNull()
  })

  it('orders by precedence, pre-releases below finals', () => {
    expect(compareVersions('0.2.0', '0.1.9')).toBeGreaterThan(0)
    expect(compareVersions('0.2.0-beta.1', '0.2.0')).toBeLessThan(0)
    expect(compareVersions('0.2.0-beta.2', '0.2.0-beta.10')).toBeLessThan(0)
    expect(compareVersions('0.2.0-alpha.1', '0.2.0-beta.1')).toBeLessThan(0)
    expect(compareVersions('0.2.0-beta', '0.2.0-beta.1')).toBeLessThan(0)
    expect(compareVersions('1.0.0', 'v1.0.0')).toBe(0)
    expect(isNewerVersion('0.2.0', '0.2.0-beta.3')).toBe(true)
    expect(isNewerVersion('0.2.0', '0.2.0')).toBe(false)
    expect(isNewerVersion('0.2.0', '0.3.0')).toBe(false)
  })
})

describe('manifest sources', () => {
  it('reads the latest release through the redirecting download URL on stable', () => {
    const source = manifestSource('stable', REPO)
    expect(source).toEqual({
      kind: 'latest',
      manifestUrl: `https://github.com/${REPO}/releases/latest/download/update-manifest.json`,
      signatureUrl: `https://github.com/${REPO}/releases/latest/download/update-manifest.json.sig`
    })
  })

  it('lists releases through the API on beta', () => {
    expect(manifestSource('beta', REPO)).toEqual({
      kind: 'list',
      url: `https://api.github.com/repos/${REPO}/releases?per_page=30`
    })
  })

  it('picks the newest release that carries a manifest', () => {
    const list = [
      { tag_name: 'v0.3.0', draft: true, prerelease: false, assets: [manifestAsset('v0.3.0')] },
      { tag_name: 'v0.2.0-beta.2', prerelease: true, assets: [manifestAsset('v0.2.0-beta.2')] },
      { tag_name: 'v0.2.1', prerelease: false, assets: [{ name: 'SHA256SUMS.txt' }] },
      {
        tag_name: 'v0.2.0-beta.1',
        prerelease: true,
        assets: [manifestAsset('v0.2.0-beta.1'), sigAsset('v0.2.0-beta.1')]
      },
      { tag_name: 'nightly', assets: [manifestAsset('nightly')] }
    ]
    expect(selectReleaseFromList(list)).toEqual({
      tag: 'v0.2.0-beta.2',
      version: '0.2.0-beta.2',
      prerelease: true,
      manifestUrl: `https://github.com/${REPO}/releases/download/v0.2.0-beta.2/update-manifest.json`,
      signatureUrl: null
    })
    expect(selectReleaseFromList([])).toBeNull()
    expect(selectReleaseFromList({ message: 'rate limited' })).toBeNull()
  })

  it('finds the running version’s notes in the same list – its body – and nothing for a version the list lacks or a draft (SET-54)', () => {
    const list = [
      { tag_name: 'v0.4.36', prerelease: false, body: '## Highlights\n\n- Newer.' },
      { tag_name: 'v0.4.35', prerelease: false, body: '## Highlights\n\n- **Gestures** (#381).' },
      { tag_name: 'v0.4.34', prerelease: false, body: '   ' },
      { tag_name: 'v0.4.33', draft: true, body: 'a draft' }
    ]
    expect(releaseNotesFromList(list, '0.4.35')).toBe('## Highlights\n\n- **Gestures** (#381).')
    expect(releaseNotesFromList(list, '0.4.34')).toBeNull()
    expect(releaseNotesFromList(list, '0.4.33')).toBeNull()
    expect(releaseNotesFromList(list, '0.4.30')).toBeNull()
    expect(releaseNotesFromList({ message: 'rate limited' }, '0.4.35')).toBeNull()
  })
})

describe('releaseHighlights', () => {
  const body = [
    '## Highlights',
    '',
    'A patch on top of 0.4.34.',
    '',
    '- **Desktop: the site glyph** (#406) – what a page is using.',
    '',
    '### Upgrading',
    '',
    '- **Android**: installs in place.',
    'Zenium **0.4.35** for Windows, macOS, Linux and Android.',
    '',
    '## Downloads',
    '',
    '| Platform | Download |',
    '',
    '## Installing'
  ].join('\n')

  it('keeps the Highlights section – its sub-headings with it – and drops the download table and everything after', () => {
    const text = releaseHighlights(body)
    expect(text.startsWith('A patch on top of 0.4.34.')).toBe(true)
    expect(text).toContain('### Upgrading')
    expect(text.endsWith('Zenium **0.4.35** for Windows, macOS, Linux and Android.')).toBe(true)
    expect(text).not.toContain('## Downloads')
    expect(text).not.toContain('| Platform')
  })

  it('without a Highlights heading keeps what stands before the first section, or the first section whole when the notes open on one', () => {
    expect(releaseHighlights('Just a line.\r\n\r\n- one\r\n## Downloads\r\ntable')).toBe(
      'Just a line.\n\n- one'
    )
    expect(releaseHighlights("## What's Changed\n\n- a\n- b\n\n## Downloads\n\nx")).toBe('- a\n- b')
    expect(releaseHighlights('- only bullets\n- here')).toBe('- only bullets\n- here')
    expect(releaseHighlights('  \n\n')).toBe('')
  })

  it('bounds the text to a page of highlights', () => {
    const long = `## Highlights\n\n${'word '.repeat(4_000)}`
    const text = releaseHighlights(long)
    expect(text.length).toBeLessThanOrEqual(RELEASE_HIGHLIGHTS_MAX + 1)
    expect(text.endsWith('…')).toBe(true)
  })
})

function manifestAsset(tag: string): Record<string, unknown> {
  return {
    name: 'update-manifest.json',
    browser_download_url: `https://github.com/${REPO}/releases/download/${tag}/update-manifest.json`
  }
}

function sigAsset(tag: string): Record<string, unknown> {
  return {
    name: 'update-manifest.json.sig',
    browser_download_url: `https://github.com/${REPO}/releases/download/${tag}/update-manifest.json.sig`
  }
}

describe('parseUpdateManifest', () => {
  it('accepts a well-formed manifest and normalises it', () => {
    const parsed = parseUpdateManifest(JSON.stringify(manifest()), REPO)
    expect(parsed.version).toBe('0.2.0')
    expect(parsed.assets).toHaveLength(7)
    expect(parsed.assets[6].signer).toBe('b'.repeat(64))
    // Feeds outside the release are dropped silently; they are only hints.
    expect(Object.keys(parsed.feeds)).toEqual(['windows-x64'])
    // Notes are text the pipeline may add one day (What's new); a manifest without them is whole.
    expect(parsed.notes).toBeUndefined()
    expect(parseUpdateManifest(manifest({ notes: '## Highlights\n\n- One.' }), REPO).notes).toBe(
      '## Highlights\n\n- One.'
    )
    expect(parseUpdateManifest(manifest({ notes: '  ' }), REPO).notes).toBeUndefined()
    expect(parseUpdateManifest(manifest({ notes: 7 }), REPO).notes).toBeUndefined()
  })

  it('rejects manifests that point anywhere but this repository', () => {
    const foreign = manifest({
      assets: [asset({ url: 'https://evil.example/zen-chromium-0.2.0-x64-setup.exe' })]
    })
    expect(() => parseUpdateManifest(foreign, REPO)).toThrow(UpdateManifestError)
    expect(() => parseUpdateManifest(foreign, REPO)).toThrow(/not a download of release/)
    const otherRelease = manifest({
      assets: [asset({ url: `https://github.com/${REPO}/releases/download/v9.9.9/x.exe` })]
    })
    expect(() => parseUpdateManifest(otherRelease, REPO)).toThrow(/not a download of release/)
    const http = manifest({ assets: [asset({ url: `${BASE.replace('https', 'http')}/x.exe` })] })
    expect(() => parseUpdateManifest(http, REPO)).toThrow(/https/)
    const page = manifest({ releaseUrl: 'https://example.com/releases' })
    expect(() => parseUpdateManifest(page, REPO)).toThrow(/outside the repository/)
  })

  it('rejects malformed fields', () => {
    expect(() => parseUpdateManifest('{', REPO)).toThrow(/valid JSON/)
    expect(() => parseUpdateManifest(manifest({ schemaVersion: 2 }), REPO)).toThrow(/schema/)
    expect(() => parseUpdateManifest(manifest({ tag: 'v0.2.1' }), REPO)).toThrow(/does not match/)
    expect(() => parseUpdateManifest(manifest({ version: 'v0.2.0' }), REPO)).toThrow(/semver/)
    expect(() => parseUpdateManifest(manifest({ assets: [] }), REPO)).toThrow(/no assets/)
    expect(() =>
      parseUpdateManifest(manifest({ assets: [asset({ sha256: 'abc' })] }), REPO)
    ).toThrow(/SHA-256/)
    expect(() => parseUpdateManifest(manifest({ assets: [asset({ size: 0 })] }), REPO)).toThrow(
      /positive integer/
    )
    expect(() =>
      parseUpdateManifest(manifest({ assets: [asset({ name: '../x.exe' })] }), REPO)
    ).toThrow(/plain file name/)
    expect(() => parseUpdateManifest(manifest({ assets: [asset({ kind: 'msi' })] }), REPO)).toThrow(
      /unknown/
    )
  })
})

describe('asset selection', () => {
  const parsed = parseUpdateManifest(manifest(), REPO)
  const cases: Array<[UpdateTarget, string | null]> = [
    [{ os: 'windows', arch: 'x64', kind: 'nsis' }, 'zen-chromium-0.2.0-x64-setup.exe'],
    [{ os: 'windows', arch: 'arm64', kind: 'nsis' }, 'zen-chromium-0.2.0-arm64-setup.exe'],
    [{ os: 'windows', arch: 'x64', kind: 'portable' }, 'zen-chromium-0.2.0-x64-setup.exe'],
    [{ os: 'macos', arch: 'arm64', kind: 'mac-unsigned' }, 'z.dmg'],
    [{ os: 'macos', arch: 'arm64', kind: 'mac-signed' }, 'z.zip'],
    [{ os: 'macos', arch: 'x64', kind: 'mac-unsigned' }, null],
    [{ os: 'linux', arch: 'x64', kind: 'appimage' }, 'z.AppImage'],
    [{ os: 'linux', arch: 'x64', kind: 'deb' }, 'z.deb'],
    [{ os: 'linux', arch: 'arm64', kind: 'appimage' }, null],
    [{ os: 'linux', arch: 'x64', kind: 'dev' }, 'z.AppImage'],
    [{ os: 'android', arch: 'universal', kind: 'apk' }, 'z.apk'],
    // A debug build still names the APK a person would download; it just never installs it.
    [{ os: 'android', arch: 'universal', kind: 'dev' }, 'z.apk']
  ]
  for (const [target, expected] of cases) {
    it(`${target.os}/${target.arch}/${target.kind} → ${expected}`, () => {
      expect(pickUpdateAsset(parsed, target)?.name ?? null).toBe(expected)
    })
  }

  it('maps install kinds to modes', () => {
    expect(updateModeFor('nsis')).toBe('in-place')
    expect(updateModeFor('appimage')).toBe('in-place')
    expect(updateModeFor('deb')).toBe('in-place')
    expect(updateModeFor('mac-signed')).toBe('in-place')
    expect(updateModeFor('mac-unsigned')).toBe('installer')
    expect(updateModeFor('apk')).toBe('installer')
    expect(updateModeFor('portable')).toBe('manual')
    expect(updateModeFor('unpacked')).toBe('manual')
    expect(updateModeFor('dev')).toBe('manual')
  })
})

describe('the Android debug-id gate', () => {
  it('recognises the debug build type by its applicationIdSuffix', () => {
    expect(ANDROID_DEBUG_ID_SUFFIX).toBe('.debug')
    expect(isDebugApplicationId('app.zen.chromium.debug')).toBe(true)
    expect(isDebugApplicationId(`org.example.zenium${ANDROID_DEBUG_ID_SUFFIX}`)).toBe(true)
  })

  it('leaves release ids, look-alikes and the preview host (no id) alone', () => {
    expect(isDebugApplicationId('app.zen.chromium')).toBe(false)
    expect(isDebugApplicationId('app.zen.chromium.debugger')).toBe(false)
    expect(isDebugApplicationId('app.zen.debug.chromium')).toBe(false)
    expect(isDebugApplicationId('')).toBe(false)
    expect(isDebugApplicationId(null)).toBe(false)
  })

  it('gives a debug build the dev target: a manual-mode kind the service never auto-checks for', () => {
    // UpdateService.schedule() returns before arming a timer for kind 'dev' (see core/updates.ts).
    expect(updateModeFor('dev')).toBe('manual')
  })
})

describe('settings', () => {
  it('fills defaults and clamps the channel', () => {
    expect(sanitizeUpdateSettings(undefined)).toEqual({
      autoCheck: true,
      autoDownload: true,
      channel: 'stable'
    })
    expect(sanitizeUpdateSettings({ channel: 'nightly' as never, autoCheck: false })).toEqual({
      autoCheck: false,
      autoDownload: true,
      channel: 'stable'
    })
  })

  it('keeps pre-release builds on the beta channel', () => {
    const stable = sanitizeUpdateSettings({ channel: 'stable' })
    expect(effectiveChannel(stable, '0.2.0')).toBe('stable')
    expect(effectiveChannel(stable, '0.2.0-beta.1')).toBe('beta')
    expect(effectiveChannel(sanitizeUpdateSettings({ channel: 'beta' }), '0.2.0')).toBe('beta')
  })
})
