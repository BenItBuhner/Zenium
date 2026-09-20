import { describe, expect, it } from 'vitest'
import { transformManifestBytes, withContentScriptPrelude } from '../contentScriptPrelude'
import { utf8Decode, utf8Encode } from '../bytes'
import { manifestIssueReport, withheldPermissionReport } from '../errorConsole'
import {
  DECLARED_MANIFEST_FILE,
  WITHHELD_PERMISSIONS,
  hasWithheldPermissions,
  isWithheldPermission,
  restoreWithheldPermissions,
  withheldPermissionLine,
  withheldPermissionNames,
  withheldPermissionsOf,
  withoutWithheldPermissions
} from '../withheldPermissions'

const ID = 'abcdefghijklmnopabcdefghijklmnop'

const declared = {
  manifest_version: 3,
  name: 'Disk probe',
  version: '1.0',
  permissions: ['storage', 'system.storage', 'tabs'],
  optional_permissions: ['bookmarks', 'system.storage'],
  host_permissions: ['<all_urls>'],
  background: { service_worker: 'sw.js' }
}

describe('permissions withheld from the engine', () => {
  it('names system.storage and nothing else: only confirmed crashes are withheld', () => {
    expect(WITHHELD_PERMISSIONS).toEqual(['system.storage'])
    expect(isWithheldPermission('system.storage')).toBe(true)
    expect(isWithheldPermission('system.display')).toBe(false)
    expect(isWithheldPermission(42)).toBe(false)
  })

  it('takes the entry out of permissions and optional_permissions, leaves every other entry and key alone', () => {
    const rewrite = withoutWithheldPermissions(declared)
    expect(rewrite.changed).toBe(true)
    expect(rewrite.withheld).toEqual({ required: ['system.storage'], optional: ['system.storage'] })
    expect(rewrite.manifest).toEqual({
      ...declared,
      permissions: ['storage', 'tabs'],
      optional_permissions: ['bookmarks']
    })
    expect(rewrite.manifest.background).toBe(declared.background)
    // The declaration itself is not touched.
    expect(declared.permissions).toEqual(['storage', 'system.storage', 'tabs'])
  })

  it('is idempotent: a manifest already free of the entries comes back as the same object', () => {
    const once = withoutWithheldPermissions(declared).manifest
    const twice = withoutWithheldPermissions(once)
    expect(twice.changed).toBe(false)
    expect(twice.manifest).toBe(once)
    expect(twice.withheld).toEqual({ required: [], optional: [] })
    const plain = { manifest_version: 3, permissions: ['tabs'] }
    expect(withoutWithheldPermissions(plain).manifest).toBe(plain)
    expect(withoutWithheldPermissions({ name: 'no lists' }).changed).toBe(false)
  })

  it('leaves an emptied list as an empty list and ignores entries that are not strings', () => {
    const rewrite = withoutWithheldPermissions({
      permissions: ['system.storage'],
      optional_permissions: [7, 'system.storage', null]
    })
    expect(rewrite.manifest).toEqual({ permissions: [], optional_permissions: [7, null] })
  })

  it('reads what a manifest declares, by list, each once, and nothing from a non-object', () => {
    expect(withheldPermissionsOf(declared)).toEqual({
      required: ['system.storage'],
      optional: ['system.storage']
    })
    expect(withheldPermissionsOf({ permissions: ['system.storage', 'system.storage'] })).toEqual({
      required: ['system.storage'],
      optional: []
    })
    expect(withheldPermissionsOf(null)).toEqual({ required: [], optional: [] })
    expect(withheldPermissionsOf(['system.storage'])).toEqual({ required: [], optional: [] })
    expect(hasWithheldPermissions(withheldPermissionsOf(declared))).toBe(true)
    expect(hasWithheldPermissions(withheldPermissionsOf({}))).toBe(false)
    expect(withheldPermissionNames(withheldPermissionsOf(declared))).toEqual(['system.storage'])
  })

  it('puts the declaration back into the engine\u2019s copy, into the lists it came from', () => {
    const rewrite = withoutWithheldPermissions(declared)
    const restored = restoreWithheldPermissions(rewrite.manifest, rewrite.withheld)
    expect(restored.permissions).toEqual(['storage', 'tabs', 'system.storage'])
    expect(restored.optional_permissions).toEqual(['bookmarks', 'system.storage'])
    expect(withheldPermissionsOf(restored)).toEqual(rewrite.withheld)
    // A manifest that lost its lists altogether gets them back too.
    const bare: { name: string; permissions?: unknown } = { name: 'x' }
    expect(
      restoreWithheldPermissions(bare, { required: ['system.storage'], optional: [] })
    ).toEqual({ name: 'x', permissions: ['system.storage'] })
  })

  it('restoring is a no-op (same object) when nothing was withheld or the entries are there', () => {
    const none = { required: [], optional: [] }
    expect(restoreWithheldPermissions(declared, none)).toBe(declared)
    expect(
      restoreWithheldPermissions(declared, { required: ['system.storage'], optional: [] })
    ).toBe(declared)
  })

  it('composes with the content-script prelude rewrite over manifest bytes, as the install pipeline runs it', () => {
    const bytes = utf8Encode(
      JSON.stringify({
        ...declared,
        content_scripts: [{ matches: ['<all_urls>'], js: ['cs.js'] }]
      })
    )
    const engine = JSON.parse(
      utf8Decode(
        transformManifestBytes(
          bytes,
          (m) => withoutWithheldPermissions(withContentScriptPrelude(m).manifest).manifest
        )
      )
    ) as typeof declared & { content_scripts: Array<{ js: string[] }> }
    expect(engine.permissions).toEqual(['storage', 'tabs'])
    expect(engine.optional_permissions).toEqual(['bookmarks'])
    expect(engine.content_scripts[0].js[0]).toBe('zenium-storage-prelude.js')
    expect(engine.host_permissions).toEqual(['<all_urls>'])
  })

  it('reports one load warning per withheld permission on the error console, in Chrome\u2019s tone', () => {
    expect(withheldPermissionLine('system.storage')).toBe(
      "'system.storage' is not available in Zenium; the permission was withheld and chrome.system.storage answers with no devices."
    )
    expect(withheldPermissionLine('other.api')).toBe(
      "'other.api' is not available in Zenium; the permission was withheld."
    )
    const report = withheldPermissionReport(ID, 'system.storage')
    expect(report).toEqual({
      level: 'warning',
      source: 'load',
      message: withheldPermissionLine('system.storage'),
      url: `chrome-extension://${ID}/manifest.json`,
      line: null,
      context: null
    })
    // Same place on the console as a manifest warning.
    const issue = manifestIssueReport(ID, { path: null, message: 'x' } as never, 'warning')
    expect([report.source, report.url]).toEqual([issue.source, issue.url])
  })

  it('names the declared-manifest copy an install directory keeps, off the reserved underscore names', () => {
    expect(DECLARED_MANIFEST_FILE).toBe('zenium-declared-manifest.json')
    expect(DECLARED_MANIFEST_FILE.startsWith('_')).toBe(false)
  })
})
