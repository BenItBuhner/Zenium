import { describe, expect, it } from 'vitest'
import type { ExtensionManifest } from '../../../core/extensions/manifest'
import type { PermissionSet } from '../../../core/extensions/api/permissions'
import type { WithheldPermissions } from '../../../core/extensions/withheldPermissions'
import { PermissionsApi } from '../extensionApi/permissions'
import type { ApiContext, ApiHost, LoadedExtension } from '../extensionApi/types'

function loaded(
  manifest: ExtensionManifest,
  id = 'stylus',
  withheld: WithheldPermissions = { required: [], optional: [] }
): LoadedExtension {
  return {
    id,
    manifest,
    path: `/ext/${id}`,
    sessions: [],
    unpacked: false,
    withheld
  } as unknown as LoadedExtension
}

function world(
  stored?: PermissionSet,
  answer = true
): {
  api: PermissionsApi
  saved: Map<string, PermissionSet>
  prompts: Array<{ id: string; warnings: string[] }>
  dispatched: Array<{ event: string; args: unknown[] }>
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
  const prompts: Array<{ id: string; warnings: string[] }> = []
  const dispatched: Array<{ event: string; args: unknown[] }> = []
  const host = {
    store,
    confirmPermissions: async (id: string, warnings: string[]) => {
      prompts.push({ id, warnings })
      return answer
    },
    dispatch: (_id: string, _namespace: string, event: string, args: unknown[]) => {
      dispatched.push({ event, args })
    }
  } as unknown as ApiHost
  const api = new PermissionsApi(host)
  const ctx = (ext: LoadedExtension): ApiContext =>
    ({ extensionId: ext.id, extension: ext }) as unknown as ApiContext
  return { api, saved, prompts, dispatched, ctx }
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

const oneTabLike: ExtensionManifest = {
  manifest_version: 3,
  name: 'OneTab',
  version: '2.18',
  permissions: ['tabs', 'storage', 'contextMenus'],
  optional_permissions: ['tabGroups', 'bookmarks', 'alarms'],
  optional_host_permissions: ['https://example.com/*']
}

describe('permissions.request', () => {
  it("asks through the browser's prompt with Chrome's warning for what the request adds", async () => {
    const w = world()
    const ext = loaded(oneTabLike, 'onetab')
    w.api.load(ext)
    const granted = await w.api.handlers.request(w.ctx(ext), { permissions: ['tabGroups'] })
    expect(granted).toBe(true)
    expect(w.prompts).toEqual([{ id: 'onetab', warnings: ['View and manage your tab groups'] }])
    expect(w.api.grants('onetab').permissions).toContain('tabGroups')
    expect(w.saved.get('onetab')?.permissions).toContain('tabGroups')
    expect(w.dispatched).toEqual([
      { event: 'onAdded', args: [{ permissions: ['tabGroups'], origins: [] }] }
    ])
  })

  it('lists a new host the way the install prompt would', async () => {
    const w = world()
    const ext = loaded(oneTabLike, 'onetab')
    w.api.load(ext)
    await w.api.handlers.request(w.ctx(ext), {
      permissions: ['bookmarks'],
      origins: ['https://example.com/*']
    })
    expect(w.prompts[0]?.warnings).toEqual([
      'Read and change your data on example.com',
      'Read and change your bookmarks'
    ])
  })

  it('grants a request that adds no warning without asking, as Chrome does', async () => {
    const w = world()
    const ext = loaded(oneTabLike, 'onetab')
    w.api.load(ext)
    expect(await w.api.handlers.request(w.ctx(ext), { permissions: ['alarms'] })).toBe(true)
    expect(w.prompts).toEqual([])
    expect(w.api.grants('onetab').permissions).toContain('alarms')
    expect(w.dispatched.map((d) => d.event)).toEqual(['onAdded'])
  })

  it('grants nothing and fires no event when the user refuses', async () => {
    const w = world(undefined, false)
    const ext = loaded(oneTabLike, 'onetab')
    w.api.load(ext)
    expect(await w.api.handlers.request(w.ctx(ext), { permissions: ['tabGroups'] })).toBe(false)
    expect(w.prompts).toHaveLength(1)
    expect(w.api.grants('onetab').permissions).not.toContain('tabGroups')
    expect(w.dispatched).toEqual([])
  })

  it('answers true at once for permissions already held', async () => {
    const w = world()
    const ext = loaded(oneTabLike, 'onetab')
    w.api.load(ext)
    expect(await w.api.handlers.request(w.ctx(ext), { permissions: ['tabs'] })).toBe(true)
    expect(w.prompts).toEqual([])
    expect(w.dispatched).toEqual([])
  })
})

/** The engine's copy of a manifest that declared `system.storage` as optional: the entry is out. */
const engineCopyOptional: ExtensionManifest = {
  manifest_version: 3,
  name: 'Disk probe',
  version: '1.0',
  permissions: ['storage'],
  optional_permissions: ['bookmarks']
}

describe('permissions withheld from the engine (system.storage)', () => {
  it('request answers false without a prompt, a grant or an event, and the rest of the request waits with it', async () => {
    const w = world()
    const ext = loaded(engineCopyOptional, 'disk', { required: [], optional: ['system.storage'] })
    w.api.load(ext)
    expect(await w.api.handlers.request(w.ctx(ext), { permissions: ['system.storage'] })).toBe(
      false
    )
    expect(
      await w.api.handlers.request(w.ctx(ext), { permissions: ['system.storage', 'bookmarks'] })
    ).toBe(false)
    expect(w.prompts).toEqual([])
    expect(w.dispatched).toEqual([])
    expect(w.api.grants('disk').permissions).toEqual(['storage'])
    expect(w.api.handlers.contains(w.ctx(ext), { permissions: ['system.storage'] })).toBe(false)
  })

  it('counts a withheld optional permission as declared: requesting it is not the manifest error', async () => {
    const w = world()
    const ext = loaded(engineCopyOptional, 'disk', { required: [], optional: ['system.storage'] })
    w.api.load(ext)
    await expect(
      w.api.handlers.request(w.ctx(ext), { permissions: ['system.display'] })
    ).rejects.toThrow('Only permissions specified in the manifest may be requested.')
    expect(await w.api.handlers.request(w.ctx(ext), { permissions: ['system.storage'] })).toBe(
      false
    )
  })

  it('grants a withheld required permission as Chrome grants required ones, and keeps it from being removed', () => {
    const w = world()
    const ext = loaded({ ...engineCopyOptional, optional_permissions: [] }, 'disk', {
      required: ['system.storage'],
      optional: []
    })
    w.api.load(ext)
    expect(w.api.grants('disk').permissions).toEqual(['storage', 'system.storage'])
    expect(w.api.handlers.contains(w.ctx(ext), { permissions: ['system.storage'] })).toBe(true)
    expect(w.api.handlers.getAll(w.ctx(ext))).toEqual({
      permissions: ['storage', 'system.storage'],
      origins: []
    })
    expect(() => w.api.handlers.remove(w.ctx(ext), { permissions: ['system.storage'] })).toThrow(
      'You cannot remove required permissions.'
    )
  })

  it('drops a withheld optional permission granted before it was withheld and persists the corrected set', () => {
    const w = world({ permissions: ['storage', 'system.storage'], origins: [] })
    const ext = loaded(engineCopyOptional, 'stylus', { required: [], optional: ['system.storage'] })
    w.api.load(ext)
    expect(w.api.grants('stylus').permissions).toEqual(['storage'])
    expect(w.saved.get('stylus')).toEqual({ permissions: ['storage'], origins: [] })
  })
})
