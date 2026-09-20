import { describe, expect, it } from 'vitest'
import {
  INSTANCE_ID_DISABLED,
  INSTANCE_ID_INVALID_PARAMETER,
  formatInstanceId,
  type InstanceIdRecord
} from '../../../core/extensions/api/instanceId'
import { InstanceIdApi } from '../extensionApi/instanceId'
import type { ApiContext, ApiHost } from '../extensionApi/types'

const WPS = 'kdpelmjpfafjppnhbloffcjpeomlnpah'
const OTHER = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

interface World {
  api: InstanceIdApi
  store: Map<string, InstanceIdRecord>
  clock: { now: number }
  ctx(extensionId: string): ApiContext
}

function world(store = new Map<string, InstanceIdRecord>()): World {
  const clock = { now: 1_700_000_000_000 }
  let seed = 1
  const host = {
    store: {
      instanceId: (extensionId: string) => store.get(extensionId),
      setInstanceId: (extensionId: string, record: InstanceIdRecord | null) => {
        if (record) store.set(extensionId, record)
        else store.delete(extensionId)
      }
    }
  } as unknown as ApiHost
  const api = new InstanceIdApi(
    host,
    () => clock.now,
    (bytes) => Uint8Array.from({ length: bytes }, (_, i) => (seed++ * 37 + i) & 0xff)
  )
  return { api, store, clock, ctx: (extensionId) => ({ extensionId }) as unknown as ApiContext }
}

describe('formatInstanceId', () => {
  it('is Chrome’s format: 8 bytes, version 0x7 in the top bits, URL-safe base64 without padding', () => {
    expect(formatInstanceId(new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0]))).toBe('cAAAAAAAAAA')
    // `+` and `/` of plain base64 become `-` and `_`; the top nibble of the first byte is 0x7.
    expect(formatInstanceId(new Uint8Array([0x73, 0xef, 0xbf, 0xfb, 0xff, 0xbe, 0xff, 0xf0]))).toBe(
      'c--_-_--__A'
    )
    expect(formatInstanceId(new Uint8Array([0x7f, 0xbf, 0xbe, 0xff, 0xff, 0xff, 0xff, 0xff]))).toBe(
      'f7--______8'
    )
    expect(() => formatInstanceId(new Uint8Array(4))).toThrow()
  })
})

describe('InstanceIdApi', () => {
  it('generates the ID once per install and keeps it across restarts, dated by getCreationTime', () => {
    const w = world()
    expect(w.api.handlers.getCreationTime(w.ctx(WPS))).toBe(0)
    const id = w.api.handlers.getID(w.ctx(WPS)) as string
    expect(id).toMatch(/^[c-f][A-Za-z0-9_-]{10}$/)
    expect(w.api.handlers.getCreationTime(w.ctx(WPS))).toBe(1_700_000_000_000)
    w.clock.now += 5000
    expect(w.api.handlers.getID(w.ctx(WPS))).toBe(id)
    expect(w.api.handlers.getCreationTime(w.ctx(WPS))).toBe(1_700_000_000_000)
    // Another extension gets its own.
    expect(w.api.handlers.getID(w.ctx(OTHER))).not.toBe(id)
    // A restart: the same store, a new router.
    const next = world(w.store)
    expect(next.api.handlers.getID(next.ctx(WPS))).toBe(id)
    expect(next.api.handlers.getCreationTime(next.ctx(WPS))).toBe(1_700_000_000_000)
  })

  it('fails the token calls as Chrome does with GCM off, after the parameter checks', () => {
    const w = world()
    const params = { authorizedEntity: '1234567890', scope: 'GCM' }
    // getToken generates the ID before it would ask the server.
    expect(() => w.api.handlers.getToken(w.ctx(WPS), params)).toThrow(INSTANCE_ID_DISABLED)
    expect(w.store.has(WPS)).toBe(true)
    expect(() => w.api.handlers.getToken(w.ctx(WPS), { ...params, options: { a: 'b' } })).toThrow(
      INSTANCE_ID_DISABLED
    )
    for (const bad of [
      undefined,
      null,
      'x',
      { scope: 'GCM' },
      { authorizedEntity: 5, scope: 'GCM' },
      { ...params, options: { n: 1 } }
    ]) {
      expect(() => w.api.handlers.getToken(w.ctx(WPS), bad)).toThrow(INSTANCE_ID_INVALID_PARAMETER)
    }
    // deleteToken: invalid parameters before an ID exists, disabled once it does.
    expect(() => w.api.handlers.deleteToken(w.ctx(OTHER), params)).toThrow(
      INSTANCE_ID_INVALID_PARAMETER
    )
    expect(() => w.api.handlers.deleteToken(w.ctx(WPS), params)).toThrow(INSTANCE_ID_DISABLED)
  })

  it('deleteID drops the local ID and reports the failed revocation; nothing to delete succeeds', () => {
    const w = world()
    expect(w.api.handlers.deleteID(w.ctx(WPS))).toBeUndefined()
    const first = w.api.handlers.getID(w.ctx(WPS))
    expect(() => w.api.handlers.deleteID(w.ctx(WPS))).toThrow(INSTANCE_ID_DISABLED)
    expect(w.store.has(WPS)).toBe(false)
    expect(w.api.handlers.getCreationTime(w.ctx(WPS))).toBe(0)
    w.clock.now += 1
    const second = w.api.handlers.getID(w.ctx(WPS))
    expect(second).not.toBe(first)
    expect(w.api.handlers.getCreationTime(w.ctx(WPS))).toBe(1_700_000_000_001)
  })

  it('ignores a malformed stored record and generates afresh', () => {
    const store = new Map<string, InstanceIdRecord>()
    store.set(WPS, { id: '', creationTime: Number.NaN })
    const w = world(store)
    expect(w.api.handlers.getCreationTime(w.ctx(WPS))).toBe(0)
    expect(w.api.handlers.getID(w.ctx(WPS))).toMatch(/^[c-f][A-Za-z0-9_-]{10}$/)
  })
})
