import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  lstatSync,
  symlinkSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CONTENT_SCRIPT_PRELUDE_FILE } from '../../../core/extensions/api/contentScriptStorage'
import { DECLARED_MANIFEST_FILE } from '../../../core/extensions/withheldPermissions'
import {
  declaredManifestPath,
  idForUnpackedPath,
  prepareInstallDir,
  shadowUnpacked
} from '../extensionStore'

vi.mock('electron', () => ({ net: { fetch: vi.fn() } }))

const declared = {
  manifest_version: 3,
  name: 'Disk probe',
  version: '1.0',
  permissions: ['storage', 'system.storage', 'tabs'],
  optional_permissions: ['bookmarks', 'system.storage'],
  host_permissions: ['<all_urls>'],
  content_scripts: [{ matches: ['<all_urls>'], js: ['cs.js'] }],
  background: { service_worker: 'sw.js' }
}

const roots: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'zen-withheld-'))
  roots.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const readJson = (path: string): Record<string, unknown> =>
  JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>

describe('an install directory from before the permission was withheld', () => {
  it('gets the engine\u2019s manifest at load, keeps the declaration beside it, and is idempotent', async () => {
    const dir = tempDir()
    const original = JSON.stringify(declared, null, 2)
    writeFileSync(join(dir, 'manifest.json'), original)
    writeFileSync(join(dir, 'sw.js'), '')

    expect(await prepareInstallDir(dir)).toBe(true)
    const engine = readJson(join(dir, 'manifest.json'))
    expect(engine.permissions).toEqual(['storage', 'tabs'])
    expect(engine.optional_permissions).toEqual(['bookmarks'])
    expect(engine.host_permissions).toEqual(['<all_urls>'])
    expect((engine.content_scripts as Array<{ js: string[] }>)[0].js).toEqual([
      CONTENT_SCRIPT_PRELUDE_FILE,
      'cs.js'
    ])
    expect(existsSync(join(dir, CONTENT_SCRIPT_PRELUDE_FILE))).toBe(true)
    // The declaration, byte for byte, where the host reads permissions and warnings from.
    expect(readFileSync(join(dir, DECLARED_MANIFEST_FILE), 'utf8')).toBe(original)
    expect(declaredManifestPath(dir)).toBe(join(dir, DECLARED_MANIFEST_FILE))
    expect(readJson(declaredManifestPath(dir)).permissions).toEqual(declared.permissions)

    // A second load changes nothing: same engine bytes, the declaration untouched.
    const engineBytes = readFileSync(join(dir, 'manifest.json'))
    expect(await prepareInstallDir(dir)).toBe(true)
    expect(readFileSync(join(dir, 'manifest.json'))).toEqual(engineBytes)
    expect(readFileSync(join(dir, DECLARED_MANIFEST_FILE), 'utf8')).toBe(original)
  })

  it('never overwrites an existing declaration copy with an already rewritten manifest', async () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(declared))
    expect(await prepareInstallDir(dir)).toBe(true)
    // Simulate a manifest.json that was rewritten while the copy is already there.
    writeFileSync(
      join(dir, 'manifest.json'),
      JSON.stringify({ ...declared, permissions: ['storage'], optional_permissions: [] })
    )
    expect(await prepareInstallDir(dir)).toBe(true)
    expect(readJson(join(dir, DECLARED_MANIFEST_FILE)).permissions).toEqual(declared.permissions)
  })

  it('reads the declaration from manifest.json when no copy exists yet (an unpacked folder)', () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(declared))
    expect(declaredManifestPath(dir)).toBe(join(dir, 'manifest.json'))
  })

  it('leaves a manifest that is not JSON to the engine\u2019s loader (a load error, not a crash)', async () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'manifest.json'), '{ not json')
    expect(await prepareInstallDir(dir)).toBe(true)
    expect(readFileSync(join(dir, 'manifest.json'), 'utf8')).toBe('{ not json')
  })

  it('reports a directory whose manifest cannot be read, so the load can be refused', async () => {
    const dir = tempDir()
    mkdirSync(join(dir, 'manifest.json'))
    expect(await prepareInstallDir(dir)).toBe(false)
  })
})

describe('the shadow the engine loads for an unpacked folder', () => {
  it('carries the manifest without the withheld entries and leaves the developer\u2019s folder alone', async () => {
    const root = tempDir()
    const folder = join(tempDir(), 'probe')
    mkdirSync(folder)
    const original = JSON.stringify(declared)
    writeFileSync(join(folder, 'manifest.json'), original)
    writeFileSync(join(folder, 'sw.js'), '')
    const id = idForUnpackedPath(folder)

    const shadow = await shadowUnpacked(root, id, folder)
    const engine = readJson(join(shadow, 'manifest.json'))
    expect(engine.permissions).toEqual(['storage', 'tabs'])
    expect(engine.optional_permissions).toEqual(['bookmarks'])
    expect(typeof engine.key).toBe('string')
    expect(existsSync(join(shadow, 'sw.js'))).toBe(true)
    expect(existsSync(join(shadow, DECLARED_MANIFEST_FILE))).toBe(false)
    // The folder is the declaration; nothing was written into it.
    expect(readFileSync(join(folder, 'manifest.json'), 'utf8')).toBe(original)
    expect(existsSync(join(folder, DECLARED_MANIFEST_FILE))).toBe(false)
    expect(declaredManifestPath(folder)).toBe(join(folder, 'manifest.json'))
  })

  it('copies the folder\u2019s files in (Chromium drops a content script that resolves outside the root)', async () => {
    const root = tempDir()
    const folder = join(tempDir(), 'probe')
    mkdirSync(join(folder, 'lib'), { recursive: true })
    writeFileSync(join(folder, 'manifest.json'), JSON.stringify(declared))
    writeFileSync(join(folder, 'cs.js'), 'console.log("cs")')
    writeFileSync(join(folder, 'lib', 'util.js'), 'export const x = 1')
    // A link inside the developer's folder is followed, as Chrome follows it.
    symlinkSync(join(folder, 'lib', 'util.js'), join(folder, 'linked.js'))

    const shadow = await shadowUnpacked(root, idForUnpackedPath(folder), folder)
    for (const relative of ['cs.js', join('lib', 'util.js'), 'linked.js', 'manifest.json']) {
      const info = lstatSync(join(shadow, relative))
      expect(info.isSymbolicLink(), relative).toBe(false)
      expect(info.isFile(), relative).toBe(true)
    }
    expect(lstatSync(join(shadow, 'lib')).isDirectory()).toBe(true)
    expect(readFileSync(join(shadow, 'cs.js'), 'utf8')).toBe('console.log("cs")')
    expect(readFileSync(join(shadow, 'linked.js'), 'utf8')).toBe('export const x = 1')
    expect(existsSync(join(shadow, CONTENT_SCRIPT_PRELUDE_FILE))).toBe(true)
    // A rebuild replaces the shadow with the folder's current files.
    writeFileSync(join(folder, 'cs.js'), 'console.log("cs2")')
    expect(await shadowUnpacked(root, idForUnpackedPath(folder), folder)).toBe(shadow)
    expect(readFileSync(join(shadow, 'cs.js'), 'utf8')).toBe('console.log("cs2")')
  })
})
