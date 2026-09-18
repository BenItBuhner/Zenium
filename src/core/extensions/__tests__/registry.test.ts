import { describe, expect, it } from 'vitest'
import {
  emptyRegistry,
  manifestFields,
  migrateRegistry,
  newRecord,
  newTabOverrideUrl,
  setNewTabOverride,
  withManifest,
  type ExtensionRecord,
  type MigrationHelpers
} from '../registry'

const NOW = 1_800_000_000_000

const MV3 = {
  manifest_version: 3,
  name: 'Dark Reader',
  version: '4.9.110',
  description: 'Dark mode for every website',
  permissions: ['alarms', 'storage'],
  host_permissions: ['*://*/*'],
  options_ui: { page: '/ui/options/index.html' },
  action: { default_popup: 'ui/popup/index.html' },
  update_url: 'https://clients2.google.com/service/update2/crx'
}

const MV2 = {
  manifest_version: 2,
  name: 'Legacy',
  version: '1.0',
  permissions: ['tabs', 'https://*.example.com/*', 'storage', '<all_urls>'],
  options_page: 'options.html',
  browser_action: { default_popup: 'popup.html' }
}

const helpers: MigrationHelpers = {
  idForPath: (path) => `id-for-${path.replace(/\W/g, '')}`,
  readManifest: (path) => (path.includes('missing') ? null : { ...MV2, name: `From ${path}` })
}

const record = (overrides: Partial<ExtensionRecord> = {}): ExtensionRecord => ({
  ...newRecord({
    id: 'a'.repeat(32),
    source: 'chrome-web-store',
    path: '/root/aaaa/4.9.110',
    manifest: MV3,
    now: NOW,
    publisher: 'chrome-web-store',
    updateUrl: 'https://clients2.google.com/service/update2/crx'
  }),
  ...overrides
})

describe('manifestFields', () => {
  it('reads an MV3 manifest, keeping api and host permissions apart', () => {
    expect(manifestFields(MV3)).toEqual({
      version: '4.9.110',
      manifestVersion: 3,
      name: 'Dark Reader',
      description: 'Dark mode for every website',
      permissions: ['alarms', 'storage'],
      hostPermissions: ['*://*/*'],
      optionsPage: 'ui/options/index.html',
      popup: 'ui/popup/index.html',
      newTabPage: null,
      updateUrl: 'https://clients2.google.com/service/update2/crx'
    })
  })

  it('moves the host patterns an MV2 manifest lists under permissions into hostPermissions', () => {
    const fields = manifestFields(MV2)
    expect(fields.permissions).toEqual(['tabs', 'storage'])
    expect(fields.hostPermissions).toEqual(['https://*.example.com/*', '<all_urls>'])
    expect(fields.optionsPage).toBe('options.html')
    expect(fields.popup).toBe('popup.html')
    expect(fields.updateUrl).toBeNull()
  })

  it('prefers options_ui.page over options_page and tolerates junk', () => {
    expect(
      manifestFields({ options_ui: { page: 'a.html' }, options_page: 'b.html' }).optionsPage
    ).toBe('a.html')
    expect(manifestFields(null)).toEqual({
      version: '',
      manifestVersion: 2,
      name: '',
      description: '',
      permissions: [],
      hostPermissions: [],
      optionsPage: null,
      popup: null,
      newTabPage: null,
      updateUrl: null
    })
    expect(manifestFields({ permissions: ['tabs', 7, null] }).permissions).toEqual(['tabs'])
  })

  it('reads the new-tab override page without a leading slash', () => {
    expect(manifestFields({ chrome_url_overrides: { newtab: '/newtab.html' } }).newTabPage).toBe(
      'newtab.html'
    )
    expect(manifestFields({ chrome_url_overrides: { history: 'h.html' } }).newTabPage).toBeNull()
  })
})

describe('new-tab override', () => {
  const momentum = (overrides: Partial<ExtensionRecord> = {}): ExtensionRecord =>
    record({
      id: 'm'.repeat(32),
      newTabPage: 'dashboard.html',
      ...overrides
    })

  it('is off for a fresh record and only yields a URL when on, enabled and declared', () => {
    const r = momentum()
    expect(r.newTabOverride).toBe(false)
    expect(newTabOverrideUrl(r)).toBeNull()
    r.newTabOverride = true
    expect(newTabOverrideUrl(r)).toBe(`chrome-extension://${'m'.repeat(32)}/dashboard.html`)
    expect(newTabOverrideUrl({ ...r, enabled: false })).toBeNull()
    expect(newTabOverrideUrl({ ...r, newTabPage: null })).toBeNull()
  })

  it('lets one extension hold the override at a time and reports what changed', () => {
    const a = momentum({ id: 'a'.repeat(32), newTabOverride: true })
    const b = momentum({ id: 'b'.repeat(32) })
    const plain = record({ id: 'c'.repeat(32) })
    const records = [a, b, plain]
    expect(setNewTabOverride(records, b.id, true)).toEqual([a, b])
    expect(records.map((r) => r.newTabOverride)).toEqual([false, true, false])
    // Nothing to do: already on.
    expect(setNewTabOverride(records, b.id, true)).toEqual([])
    // An extension without a new-tab page cannot take the override.
    expect(setNewTabOverride(records, plain.id, true)).toEqual([])
    expect(setNewTabOverride(records, 'missing', true)).toEqual([])
    expect(records.map((r) => r.newTabOverride)).toEqual([false, true, false])
    expect(setNewTabOverride(records, b.id, false)).toEqual([b])
    expect(records.map((r) => r.newTabOverride)).toEqual([false, false, false])
  })

  it('survives the registry round trip and defaults for records written before the field', () => {
    const on = momentum({ newTabOverride: true })
    const migrated = migrateRegistry(
      { version: 2, extensions: [on, { ...record(), newTabPage: undefined }] },
      helpers,
      NOW
    )
    expect(migrated.extensions[0]).toMatchObject({
      newTabPage: 'dashboard.html',
      newTabOverride: true
    })
    expect(migrated.extensions[1]).toMatchObject({ newTabPage: null, newTabOverride: false })
  })
})

describe('newRecord and withManifest', () => {
  it('applies Chrome defaults: enabled, not pinned, no file or private access, nothing pending', () => {
    const r = record()
    expect(r).toMatchObject({
      enabled: true,
      pinned: false,
      allowFileAccess: false,
      allowPrivate: false,
      pendingWarnings: null,
      installedAt: NOW,
      updatedAt: NOW,
      publisher: 'chrome-web-store'
    })
  })

  it('lets the caller override the update url, including clearing it', () => {
    const base = { id: 'x', source: 'zip' as const, path: '/p', manifest: MV3, now: NOW }
    expect(newRecord(base).updateUrl).toBe(MV3.update_url)
    expect(newRecord({ ...base, updateUrl: null }).updateUrl).toBeNull()
    expect(newRecord({ ...base, updateUrl: 'https://u' }).updateUrl).toBe('https://u')
  })

  it('refreshes manifest fields while store installs keep their store update url', () => {
    const updated = withManifest(
      record(),
      { ...MV3, version: '5.0.0', update_url: 'https://elsewhere' },
      { updatedAt: NOW + 1 }
    )
    expect(updated.version).toBe('5.0.0')
    expect(updated.updatedAt).toBe(NOW + 1)
    expect(updated.installedAt).toBe(NOW)
    expect(updated.updateUrl).toBe('https://clients2.google.com/service/update2/crx')

    const sideloaded = withManifest(record({ source: 'crx' }), {
      ...MV3,
      update_url: 'https://elsewhere'
    })
    expect(sideloaded.updateUrl).toBe('https://elsewhere')
  })
})

describe('migrateRegistry', () => {
  it('yields an empty registry for anything that is not a registry document', () => {
    for (const raw of [
      undefined,
      null,
      42,
      'x',
      {},
      { version: 2 },
      { version: 2, extensions: {} }
    ])
      expect(migrateRegistry(raw, helpers, NOW)).toEqual(emptyRegistry())
    expect(migrateRegistry({ version: 3, extensions: [] }, helpers, NOW)).toEqual(emptyRegistry())
  })

  it('turns version 1 {path, enabled} entries into unpacked records read from their manifests', () => {
    const migrated = migrateRegistry(
      {
        version: 1,
        extensions: [
          { path: '/home/u/ext-a', enabled: true },
          { path: '/home/u/ext-b', enabled: false },
          { path: '/home/u/ext-a' },
          { path: '' },
          { enabled: true },
          null
        ]
      },
      helpers,
      NOW
    )
    expect(migrated.version).toBe(2)
    expect(migrated.lastUpdateCheck).toBeNull()
    expect(migrated.extensions.map((r) => [r.id, r.path, r.enabled])).toEqual([
      ['id-for-homeuexta', '/home/u/ext-a', true],
      ['id-for-homeuextb', '/home/u/ext-b', false]
    ])
    const [a] = migrated.extensions
    expect(a).toMatchObject({
      source: 'unpacked',
      name: 'From /home/u/ext-a',
      version: '1.0',
      manifestVersion: 2,
      permissions: ['tabs', 'storage'],
      hostPermissions: ['https://*.example.com/*', '<all_urls>'],
      optionsPage: 'options.html',
      popup: 'popup.html',
      publisher: null,
      updateUrl: null,
      installedAt: NOW,
      updatedAt: NOW,
      pinned: false,
      pendingWarnings: null
    })
  })

  it('keeps file access for version 1 folders, which the first schema always granted', () => {
    const migrated = migrateRegistry(
      { version: 1, extensions: [{ path: '/home/u/missing', enabled: true }] },
      helpers,
      NOW
    )
    expect(migrated.extensions[0].allowFileAccess).toBe(true)
    expect(migrated.extensions[0].name).toBe('')
  })

  it('passes a well-formed version 2 document through unchanged', () => {
    const doc = { version: 2, extensions: [record()], lastUpdateCheck: NOW - 5 }
    const migrated = migrateRegistry(JSON.parse(JSON.stringify(doc)), helpers, NOW)
    expect(migrated).toEqual(doc)
  })

  it('sanitises version 2 records a hand edit or truncation damaged', () => {
    const migrated = migrateRegistry(
      {
        version: 2,
        lastUpdateCheck: 'yesterday',
        extensions: [
          { id: 'ok', path: '/p', source: 'from-mars', publisher: 'someone', pendingWarnings: 'x' },
          { id: 'ok', path: '/dup' },
          {
            id: 'partial',
            path: '/q',
            installedAt: 5,
            enabled: false,
            pinned: true,
            allowPrivate: true,
            pendingWarnings: ['Read your browsing history', 3]
          },
          { path: '/no-id' },
          { id: 'no-path' },
          'string',
          null
        ]
      },
      helpers,
      NOW
    )
    expect(migrated.lastUpdateCheck).toBeNull()
    expect(migrated.extensions.map((r) => r.id)).toEqual(['ok', 'partial'])
    expect(migrated.extensions[0]).toMatchObject({
      source: 'unpacked',
      publisher: null,
      pendingWarnings: null,
      enabled: true,
      allowFileAccess: false,
      allowPrivate: false,
      installedAt: NOW,
      updatedAt: NOW,
      version: '',
      manifestVersion: 2,
      permissions: [],
      hostPermissions: [],
      optionsPage: null,
      popup: null
    })
    expect(migrated.extensions[1]).toMatchObject({
      installedAt: 5,
      updatedAt: 5,
      enabled: false,
      pinned: true,
      allowPrivate: true,
      pendingWarnings: ['Read your browsing history']
    })
  })
})
