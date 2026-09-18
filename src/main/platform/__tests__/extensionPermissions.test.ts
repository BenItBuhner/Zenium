import { describe, expect, it } from 'vitest'
import type { ExtensionManifest } from '../../../core/extensions/manifest'
import type { PermissionSet } from '../../../core/extensions/api/permissions'
import { PermissionsApi } from '../extensionApi/permissions'
import type { ApiContext, ApiHost, LoadedExtension } from '../extensionApi/types'

function loaded(manifest: ExtensionManifest, id = 'stylus'): LoadedExtension {
  return {
    id,
    manifest,
    path: `/ext/${id}`,
    sessions: [],
    unpacked: false
  } as unknown as LoadedExtension
}

function world(stored?: PermissionSet): {
  api: PermissionsApi
  saved: Map<string, PermissionSet>
  ctx: (ext: LoadedExtension) => ApiContext
} {
  const saved = new Map<string, PermissionSet>()
  if (stored) saved.set('stylus', stored)
  const store = {
    grants: (id: string) => saved.get(id),
    setGrants: (id: string, grants: PermissionSet) => {
      saved.set(id, grants)
    }
  }
  const host = { store } as unknown as ApiHost
  const api = new PermissionsApi(host)
  const ctx = (ext: LoadedExtension): ApiContext =>
    ({ extensionId: ext.id, extension: ext }) as unknown as ApiContext
  return { api, saved, ctx }
}

const stylusLike: ExtensionManifest = {
  manifest_version: 3,
  name: 'Stylus',
  version: '2.4.11',
  permissions: ['webRequest', 'webRequestBlocking', 'storage', 'scripting'],
  host_permissions: ['<all_urls>']
}

describe('PermissionsApi and manifest versions', () => {
  it('does not grant webRequestBlocking to an MV3 extension that declares it', () => {
    const w = world()
    const ext = loaded(stylusLike)
    w.api.load(ext)
    expect(w.api.grants('stylus').permissions).toEqual(['webRequest', 'storage', 'scripting'])
    // Stylus probes this way before choosing between a blocking and an observational listener.
    expect(w.api.handlers.contains(w.ctx(ext), { permissions: ['webRequestBlocking'] })).toBe(false)
    expect(w.api.handlers.contains(w.ctx(ext), { permissions: ['webRequest'] })).toBe(true)
    expect(w.api.handlers.getAll(w.ctx(ext))).toEqual({
      permissions: ['webRequest', 'storage', 'scripting'],
      origins: ['<all_urls>']
    })
  })

  it('drops a stored grant the manifest version refuses and persists the corrected set', () => {
    const w = world({
      permissions: ['webRequest', 'webRequestBlocking', 'storage', 'bookmarks'],
      origins: ['<all_urls>']
    })
    w.api.load(loaded(stylusLike))
    expect(w.api.grants('stylus')).toEqual({
      permissions: ['webRequest', 'storage', 'bookmarks', 'scripting'],
      origins: ['<all_urls>']
    })
    expect(w.saved.get('stylus')).toEqual(w.api.grants('stylus'))
  })

  it('keeps webRequestBlocking for MV2 and leaves the MV3-only permissions out there', () => {
    const w = world()
    w.api.load(
      loaded(
        {
          manifest_version: 2,
          name: 'uBlock Origin',
          version: '1',
          permissions: ['webRequest', 'webRequestBlocking', 'scripting', '<all_urls>']
        },
        'ubo'
      )
    )
    expect(w.api.grants('ubo')).toEqual({
      permissions: ['webRequest', 'webRequestBlocking'],
      origins: ['<all_urls>']
    })
  })
})
