import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import {
  BUNDLED_DEV_DEPENDENCIES,
  LICENCES_MODULE_ID,
  collectLicences,
  licenceFileOf,
  licenceIdOf,
  licencesModuleSource,
  licencesPlugin,
  packageUrlOf,
  resolvePackageDir
} from './licences'
import type { LicenceEntry } from '../src/shared/licences'

/*
 * The build-time licences list (Settings › About › Open-source licences, settings-73): the walk
 * over the installed tree from the root's dependencies, Node's nearest-copy resolution, the
 * licence file and its text, the declared licence and homepage as one entry each, and the
 * virtual module the Vite plugin serves the page.
 */

const root = mkdtempSync(join(tmpdir(), 'zenium-licences-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

/** A package directory with its manifest and files, under `root`. */
function pkg(path: string, manifest: object, files: Record<string, string> = {}): string {
  const dir = join(root, path)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text)
  return dir
}

pkg('.', {
  name: 'app',
  version: '1.0.0',
  dependencies: { alpha: '^1', beta: '^2', linked: '^2' },
  devDependencies: { react: '^19', 'react-dom': '^19', vitest: '^3' }
})
pkg(
  'node_modules/alpha',
  {
    name: 'alpha',
    version: '1.0.0',
    license: 'MIT',
    homepage: 'https://alpha.example/',
    dependencies: { gamma: '^2' },
    optionalDependencies: { missing: '^1' }
  },
  { LICENSE: 'MIT text\r\nline two\r\n', 'LICENSE-MIT.txt': 'the same, named longer' }
)
pkg(
  'node_modules/alpha/node_modules/gamma',
  { name: 'gamma', version: '2.0.0', license: { type: 'ISC' } },
  { COPYING: 'nested gamma' }
)
pkg(
  'node_modules/gamma',
  { name: 'gamma', version: '1.0.0', license: 'ISC' },
  { 'license.md': 'hoisted gamma' }
)
pkg(
  'node_modules/beta',
  {
    name: 'beta',
    version: '2.1.0',
    licenses: [{ type: 'Apache-2.0' }, 'BSD-2-Clause'],
    repository: { type: 'git', url: 'git+https://github.com/example/beta.git' },
    dependencies: { gamma: '^1' },
    devDependencies: { vitest: '^3' }
  },
  { README: 'not a licence' }
)
pkg('node_modules/react', { name: 'react', version: '19.0.0', license: 'MIT' })
pkg('node_modules/react-dom', { name: 'react-dom', version: '19.0.0', license: 'MIT' })
pkg('node_modules/vitest', { name: 'vitest', version: '3.0.0', license: 'MIT' })
pkg('node_modules/electron', { name: 'electron', version: '44.0.0', license: 'MIT' })
mkdirSync(join(root, 'node_modules/electron/dist'), { recursive: true })
writeFileSync(join(root, 'node_modules/electron/dist/LICENSE'), 'electron licence')
// A linked package: the same directory under a second name resolves to one entry.
symlinkSync(join(root, 'node_modules/beta'), join(root, 'node_modules/linked'), 'dir')

describe('resolvePackageDir', () => {
  it('finds the nearest copy walking up from the requiring package, stopping at the root', () => {
    const alpha = join(root, 'node_modules/alpha')
    expect(resolvePackageDir('gamma', alpha, root)).toBe(join(alpha, 'node_modules/gamma'))
    expect(resolvePackageDir('gamma', join(root, 'node_modules/beta'), root)).toBe(
      join(root, 'node_modules/gamma')
    )
    expect(resolvePackageDir('missing', alpha, root)).toBeNull()
  })
})

describe('licenceIdOf', () => {
  it('reads the licence field in each of its shapes', () => {
    expect(licenceIdOf({ license: ' MIT ' })).toBe('MIT')
    expect(licenceIdOf({ license: { type: 'ISC' } })).toBe('ISC')
    expect(licenceIdOf({ licenses: [{ type: 'Apache-2.0' }, 'BSD-2-Clause'] })).toBe(
      '(Apache-2.0 OR BSD-2-Clause)'
    )
    expect(licenceIdOf({ licenses: ['MIT'] })).toBe('MIT')
    expect(licenceIdOf({ licenses: [] })).toBe('')
    expect(licenceIdOf({})).toBe('')
  })
})

describe('packageUrlOf', () => {
  it('prefers the homepage and turns a repository field into a browsable URL', () => {
    expect(packageUrlOf({ homepage: 'https://alpha.example/' })).toBe('https://alpha.example/')
    expect(packageUrlOf({ repository: 'github:user/repo' })).toBe('https://github.com/user/repo')
    expect(packageUrlOf({ repository: 'user/repo' })).toBe('https://github.com/user/repo')
    expect(packageUrlOf({ repository: { url: 'git+https://github.com/u/r.git' } })).toBe(
      'https://github.com/u/r'
    )
    expect(packageUrlOf({ repository: 'git@github.com:u/r.git' })).toBe('https://github.com/u/r')
    expect(packageUrlOf({ repository: 'git://github.com/u/r.git' })).toBe('https://github.com/u/r')
    expect(packageUrlOf({ repository: 'file:../local' })).toBeUndefined()
    expect(packageUrlOf({})).toBeUndefined()
  })
})

describe('licenceFileOf', () => {
  it('picks the licence file by name, the shortest licence before a copying file', () => {
    expect(licenceFileOf(join(root, 'node_modules/alpha'))).toBe('LICENSE')
    expect(licenceFileOf(join(root, 'node_modules/gamma'))).toBe('license.md')
    expect(licenceFileOf(join(root, 'node_modules/alpha/node_modules/gamma'))).toBe('COPYING')
    expect(licenceFileOf(join(root, 'node_modules/beta'))).toBeNull()
    expect(licenceFileOf(join(root, 'node_modules/nowhere'))).toBeNull()
  })
})

describe('collectLicences', () => {
  it('walks the root dependencies and the bundled dev dependencies, one entry per name and version', () => {
    const entries = collectLicences({ root })
    expect(entries.map((e) => `${e.name}@${e.version}`)).toEqual([
      'alpha@1.0.0',
      'beta@2.1.0',
      'gamma@1.0.0',
      'gamma@2.0.0',
      'react@19.0.0',
      'react-dom@19.0.0'
    ])
    expect(BUNDLED_DEV_DEPENDENCIES).toEqual(['react', 'react-dom'])
    // The text comes with CRLF folded to LF and the trailing newline gone.
    expect(entries[0]).toEqual({
      name: 'alpha',
      version: '1.0.0',
      licence: 'MIT',
      url: 'https://alpha.example/',
      text: 'MIT text\nline two'
    })
    expect(entries[1]).toMatchObject({
      licence: '(Apache-2.0 OR BSD-2-Clause)',
      url: 'https://github.com/example/beta'
    })
    expect(entries[1].text).toBeUndefined()
    // Both gammas: the nested copy alpha loads and the hoisted one beta loads.
    expect(entries[2].text).toBe('hoisted gamma')
    expect(entries[3].text).toBe('nested gamma')
  })

  it('adds Electron, with the licence from its binary distribution, only when asked', () => {
    expect(collectLicences({ root }).some((e) => e.name === 'electron')).toBe(false)
    const electron = collectLicences({ root, electron: true }).find((e) => e.name === 'electron')
    expect(electron).toEqual({
      name: 'electron',
      version: '44.0.0',
      licence: 'MIT',
      url: 'https://www.electronjs.org',
      text: 'electron licence'
    })
  })
})

describe('licencesModuleSource', () => {
  it('is a module whose default export is the entries, their texts shared', async () => {
    const entries: LicenceEntry[] = [
      { name: 'a', version: '1', licence: 'MIT', text: 'same text' },
      { name: 'b', version: '2', licence: 'MIT', url: 'https://b.example', text: 'same text' },
      { name: 'c', version: '3', licence: '' }
    ]
    const source = licencesModuleSource(entries)
    expect(source.split('same text').length - 1).toBe(1)
    const mod = (await import(`data:text/javascript,${encodeURIComponent(source)}`)) as {
      default: LicenceEntry[]
    }
    expect(mod.default).toEqual(entries)
  })
})

describe('licencesPlugin', () => {
  it('resolves and loads the virtual module once', () => {
    const plugin = licencesPlugin({ electron: true, root })
    const resolveId = plugin.resolveId as (id: string) => string | null
    const load = plugin.load as (id: string) => string | null
    expect(resolveId('./other')).toBeNull()
    const resolved = resolveId(LICENCES_MODULE_ID)
    expect(resolved).toBeTruthy()
    const first = load(resolved!)
    // The entries ride inside a JSON string literal, their quotes escaped.
    expect(first).toContain('{\\"name\\":\\"electron\\"')
    expect(load(resolved!)).toBe(first)
    expect(load('./other')).toBeNull()
  })

  it('reads the real tree: the renderer’s packages and Electron, no test tooling', () => {
    const projectRoot = fileURLToPath(new URL('..', import.meta.url))
    const entries = collectLicences({ root: projectRoot, electron: true })
    const names = new Set(entries.map((e) => e.name))
    expect(names.has('react')).toBe(true)
    expect(names.has('react-dom')).toBe(true)
    expect(names.has('electron')).toBe(true)
    expect(names.has('vitest')).toBe(false)
    for (const entry of entries) {
      expect(entry.name).not.toBe('')
      expect(entry.version).not.toBe('')
    }
    expect(entries.filter((e) => e.text).length).toBeGreaterThan(entries.length / 2)
  })
})
