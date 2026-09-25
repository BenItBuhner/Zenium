import { describe, expect, it } from 'vitest'
import type { ExtensionManifest } from '../../../core/extensions/manifest'
import {
  manifestPermissionSets,
  type PermissionSet
} from '../../../core/extensions/api/permissions'
import { PermissionsApi, reclassifyHostGrants } from '../extensionApi/permissions'
import type { ApiContext, ApiHost, LoadedExtension } from '../extensionApi/types'

const ORIGIN = 'http://127.0.0.1:38593/*'

/** Markdown Viewer's shape: file required, every site optional. */
const manifest: ExtensionManifest = {
  manifest_version: 3,
  name: 'Markdown Viewer',
  version: '5.3',
  permissions: ['storage', 'scripting'],
  host_permissions: ['file:///*'],
  optional_host_permissions: ['*://*/']
} as unknown as ExtensionManifest

describe('reclassifyHostGrants: a folded runtime grant counts as optional, not required', () => {
  it('moves the folded origin from the required set to the optional set', () => {
    // The engine's manifest carries the grant among host_permissions: required to Chromium.
    const engine = { ...manifest, host_permissions: ['file:///*', ORIGIN] } as ExtensionManifest
    const sets = reclassifyHostGrants(manifestPermissionSets(engine), [ORIGIN])
    expect(sets.required.origins).toEqual(['file:///*'])
    expect(sets.optional.origins).toEqual(['*://*/', ORIGIN])
  })

  it('leaves the sets alone when nothing was folded or the origin is not required', () => {
    const sets = manifestPermissionSets(manifest)
    expect(reclassifyHostGrants(sets, [])).toBe(sets)
    // An origin that is not among the required set (already optional) needs no move.
    expect(reclassifyHostGrants(sets, ['*://*/'])).toBe(sets)
  })
})

function world(stored?: PermissionSet): {
  api: PermissionsApi
  saved: Map<string, PermissionSet>
  dispatched: Array<{ event: string; args: unknown[] }>
  origins: Array<readonly string[]>
  ctx: (ext: LoadedExtension) => ApiContext
} {
  const saved = new Map<string, PermissionSet>()
  if (stored) saved.set('mdv', stored)
  const dispatched: Array<{ event: string; args: unknown[] }> = []
  const host = {
    store: {
      grants: (id: string) => saved.get(id),
      setGrants: (id: string, grants: PermissionSet) => saved.set(id, grants)
    },
    registry: { framesOf: () => [], workersOf: () => [], sendTo: () => undefined },
    dispatch: (_id: string, _ns: string, event: string, args: unknown[]) =>
      dispatched.push({ event, args })
  } as unknown as ApiHost
  const api = new PermissionsApi(host)
  const origins: Array<readonly string[]> = []
  api.onOriginsChanged((_id, o) => origins.push(o))
  const ctx = (ext: LoadedExtension): ApiContext =>
    ({ extensionId: ext.id, extension: ext }) as unknown as ApiContext
  return { api, saved, dispatched, origins, ctx }
}

const loaded = (m: ExtensionManifest): LoadedExtension =>
  ({
    id: 'mdv',
    manifest: m,
    path: '/ext/mdv',
    sessions: [],
    unpacked: false,
    withheld: { required: [], optional: [] }
  }) as unknown as LoadedExtension

describe('a runtime host grant folded into the engine manifest stays removable', () => {
  const engine = { ...manifest, host_permissions: ['file:///*', ORIGIN] } as ExtensionManifest

  it('remove takes it back once the load was told the origin is a runtime grant', () => {
    const w = world({ permissions: ['storage', 'scripting'], origins: ['file:///*', ORIGIN] })
    w.api.noteManifestHostGrants('mdv', [ORIGIN])
    w.api.load(loaded(engine))
    const ext = loaded(engine)
    expect(w.api.handlers.remove(w.ctx(ext), { origins: [ORIGIN] })).toBe(true)
    expect(w.saved.get('mdv')?.origins).toEqual(['file:///*'])
    expect(w.origins.at(-1)).toEqual(['file:///*'])
  })

  it('refuses to remove it when the load was not told (the engine calls it required)', () => {
    const w = world({ permissions: ['storage', 'scripting'], origins: ['file:///*', ORIGIN] })
    w.api.load(loaded(engine))
    const ext = loaded(engine)
    expect(() => w.api.handlers.remove(w.ctx(ext), { origins: [ORIGIN] })).toThrow(
      /cannot remove required/i
    )
  })

  it('clears the note on unload so a later load reads the manifest as declared', () => {
    const w = world({ permissions: ['storage', 'scripting'], origins: ['file:///*'] })
    w.api.noteManifestHostGrants('mdv', [ORIGIN])
    w.api.unload('mdv')
    // Declared manifest again (grant revoked): file required, site optional, nothing folded.
    w.api.load(loaded(manifest))
    const ext = loaded(manifest)
    // file:///* is required and cannot be removed; the site is optional and simply absent.
    expect(() => w.api.handlers.remove(w.ctx(ext), { origins: ['file:///*'] })).toThrow(
      /cannot remove required/i
    )
  })
})
