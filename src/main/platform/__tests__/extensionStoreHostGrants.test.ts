import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DECLARED_MANIFEST_FILE } from '../../../core/extensions/withheldPermissions'
import {
  engineManifest,
  grantedHostPermissions,
  idForUnpackedPath,
  prepareInstallDir,
  shadowUnpacked,
  withGrantedHosts,
  withoutGrantedHosts
} from '../extensionStore'

vi.mock('electron', () => ({ net: { fetch: vi.fn() } }))

/** Markdown Viewer (ckkdlimhmcjmikdlpkmbgfkaikojcbjk): file access declared, every site optional. */
const markdownViewer = {
  manifest_version: 3,
  name: 'Markdown Viewer',
  version: '5.3',
  permissions: ['storage', 'scripting'],
  optional_permissions: ['webRequest'],
  host_permissions: ['file:///*'],
  optional_host_permissions: ['*://*/'],
  options_page: '/options/index.html',
  background: { service_worker: 'background/index.js' }
}

const ORIGIN = 'http://127.0.0.1:38593/*'

const roots: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'zen-host-grants-'))
  roots.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const readJson = (path: string): Record<string, unknown> =>
  JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>

describe('grantedHostPermissions: which granted origins the engine’s manifest gets', () => {
  it('folds a granted optional origin in and leaves the required pattern where it is', () => {
    // The persisted grant set is required ∪ granted optional: `file:///*` is already declared.
    expect(grantedHostPermissions(markdownViewer, ['file:///*', ORIGIN])).toEqual([ORIGIN])
  })

  it('never bakes an optional pattern the user did not grant into the manifest', () => {
    expect(grantedHostPermissions(markdownViewer, ['file:///*'])).toEqual([])
    expect(grantedHostPermissions(markdownViewer, [])).toEqual([])
  })

  it('takes the "Allow All" request as granted: *://*/* under the optional *://*/', () => {
    expect(grantedHostPermissions(markdownViewer, ['*://*/*'])).toEqual(['*://*/*'])
  })

  it('leaves out what the manifest cannot request, a malformed pattern, and a repeat', () => {
    const manifest = {
      ...markdownViewer,
      optional_host_permissions: ['https://*.example.com/*']
    }
    expect(
      grantedHostPermissions(manifest, [
        'https://docs.example.com/*',
        'https://other.org/*', // a grant kept from an earlier version's manifest
        'nonsense', // no scheme separator
        'https://docs.example.com/*'
      ])
    ).toEqual(['https://docs.example.com/*'])
  })

  it('passes <all_urls> and a file-scheme pattern through as they are', () => {
    const everything = { ...markdownViewer, optional_host_permissions: ['<all_urls>'] }
    expect(grantedHostPermissions(everything, ['<all_urls>'])).toEqual(['<all_urls>'])
    const files = {
      ...markdownViewer,
      host_permissions: [],
      optional_host_permissions: ['file:///*']
    }
    expect(grantedHostPermissions(files, ['file:///*'])).toEqual(['file:///*'])
    // Required <all_urls> already covers every origin: nothing to fold.
    const all = { ...markdownViewer, host_permissions: ['<all_urls>'] }
    expect(grantedHostPermissions(all, ['<all_urls>', ORIGIN])).toEqual([])
  })
})

describe('withGrantedHosts / withoutGrantedHosts: the list Chromium reads', () => {
  it('appends to host_permissions in MV3 and reports the change', () => {
    const folded = withGrantedHosts(markdownViewer, ['file:///*', ORIGIN])
    expect(folded.changed).toBe(true)
    expect(folded.manifest.host_permissions).toEqual(['file:///*', ORIGIN])
    expect(folded.manifest.optional_host_permissions).toEqual(['*://*/'])
    // The declaration object is not written to.
    expect(markdownViewer.host_permissions).toEqual(['file:///*'])
  })

  it('appends to permissions in MV2, where Chromium ignores host_permissions', () => {
    const mv2 = {
      manifest_version: 2,
      name: 'Old',
      version: '1',
      permissions: ['storage', 'https://a.example/*'],
      optional_permissions: ['*://*/*']
    }
    const folded = withGrantedHosts(mv2, ['https://a.example/*', 'https://b.example/*'])
    expect(folded.changed).toBe(true)
    expect(folded.manifest.permissions).toEqual([
      'storage',
      'https://a.example/*',
      'https://b.example/*'
    ])
    expect(folded.manifest.host_permissions).toBeUndefined()
  })

  it('hands the manifest back unchanged when nothing is to add', () => {
    const same = withGrantedHosts(markdownViewer, ['file:///*'])
    expect(same.changed).toBe(false)
    expect(same.manifest).toBe(markdownViewer)
  })

  it('takes the fold out again, so the API layer reads the declared required set', () => {
    const engine = withGrantedHosts(markdownViewer, [ORIGIN, '*://*/*']).manifest
    expect(withoutGrantedHosts(engine, [ORIGIN, '*://*/*'])).toEqual(markdownViewer)
    expect(withoutGrantedHosts(markdownViewer, [])).toBe(markdownViewer)
    expect(withoutGrantedHosts(markdownViewer, [ORIGIN])).toBe(markdownViewer)
  })

  it('composes with the rest of the engine manifest', () => {
    const declared = {
      ...markdownViewer,
      permissions: ['storage', 'scripting', 'system.storage'],
      content_scripts: [{ matches: ['<all_urls>'], js: ['cs.js'] }]
    }
    const engine = engineManifest(declared, [ORIGIN])
    expect(engine.changed).toBe(true)
    expect(engine.manifest.permissions).toEqual(['storage', 'scripting'])
    expect(engine.manifest.host_permissions).toEqual(['file:///*', ORIGIN])
    expect((engine.manifest.content_scripts as Array<{ js: string[] }>)[0].js).toHaveLength(2)
    expect(engineManifest(markdownViewer).changed).toBe(false)
  })
})

describe('prepareInstallDir: a grant reaches the engine at the next load, a revoke leaves', () => {
  it('folds the persisted grant in, keeps the declaration, and unfolds it once revoked', async () => {
    const dir = tempDir()
    const original = JSON.stringify(markdownViewer, null, 2)
    writeFileSync(join(dir, 'manifest.json'), original)

    // The grant persisted in an earlier session: in force at this boot.
    expect(await prepareInstallDir(dir, ['file:///*', ORIGIN])).toBe(true)
    expect(readJson(join(dir, 'manifest.json')).host_permissions).toEqual(['file:///*', ORIGIN])
    expect(readFileSync(join(dir, DECLARED_MANIFEST_FILE), 'utf8')).toBe(original)

    // The same grants again: the engine copy is left as it is (no write).
    const before = statSync(join(dir, 'manifest.json')).mtimeMs
    const bytes = readFileSync(join(dir, 'manifest.json'))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(await prepareInstallDir(dir, ['file:///*', ORIGIN])).toBe(true)
    expect(statSync(join(dir, 'manifest.json')).mtimeMs).toBe(before)
    expect(readFileSync(join(dir, 'manifest.json'))).toEqual(bytes)

    // Revoked: the engine copy is derived from the declaration, not from its last self, so the
    // origin is gone; the declaration is still byte for byte the original.
    expect(await prepareInstallDir(dir, ['file:///*'])).toBe(true)
    expect(readJson(join(dir, 'manifest.json')).host_permissions).toEqual(['file:///*'])
    expect(readFileSync(join(dir, DECLARED_MANIFEST_FILE), 'utf8')).toBe(original)
  })

  it('never folds what the user did not grant', async () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(markdownViewer))
    expect(await prepareInstallDir(dir)).toBe(true)
    const engine = readJson(join(dir, 'manifest.json'))
    expect(engine.host_permissions).toEqual(['file:///*'])
    expect(engine.optional_host_permissions).toEqual(['*://*/'])
  })
})

describe('shadowUnpacked: the shadow carries the fold, the folder never does', () => {
  it('writes the granted origin into the shadow’s manifest only', async () => {
    const root = tempDir()
    const folder = join(tempDir(), 'markdown-viewer')
    mkdirSync(folder)
    const original = JSON.stringify(markdownViewer)
    writeFileSync(join(folder, 'manifest.json'), original)
    const id = idForUnpackedPath(folder)

    const shadow = await shadowUnpacked(root, id, folder, ['file:///*', ORIGIN])
    expect(readJson(join(shadow, 'manifest.json')).host_permissions).toEqual(['file:///*', ORIGIN])
    expect(readFileSync(join(folder, 'manifest.json'), 'utf8')).toBe(original)

    // Rebuilt without the grant: the fold is gone with it.
    await shadowUnpacked(root, id, folder, ['file:///*'])
    expect(readJson(join(shadow, 'manifest.json')).host_permissions).toEqual(['file:///*'])
  })
})
