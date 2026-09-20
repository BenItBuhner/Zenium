import { describe, expect, it } from 'vitest'
import {
  SYSTEM_STORAGE_CAPACITY_ERROR,
  SYSTEM_STORAGE_NO_PERMISSION_ERROR,
  SYSTEM_STORAGE_NO_SUCH_DEVICE
} from '../../../core/extensions/api/systemStorage'
import { SystemStorageApi } from '../extensionApi/systemStorage'
import { ApiError, type ApiContext, type ApiHost } from '../extensionApi/types'

const DECLARED = 'abcdefghijklmnopabcdefghijklmnop'
const NOT_DECLARED = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

function world(): { api: SystemStorageApi; ctx(id: string): ApiContext } {
  const host = {
    grants: (extensionId: string) => ({
      permissions: extensionId === DECLARED ? ['system.storage', 'storage'] : ['storage'],
      origins: []
    })
  } as unknown as ApiHost
  return {
    api: new SystemStorageApi(host),
    ctx: (extensionId) => ({ extensionId }) as unknown as ApiContext
  }
}

describe('chrome.system.storage on the desktop', () => {
  it('answers Chrome\u2019s shape over no devices for an extension granted the permission', () => {
    const w = world()
    expect(w.api.handlers.getInfo(w.ctx(DECLARED))).toEqual([])
    expect(w.api.handlers.ejectDevice(w.ctx(DECLARED), '0123')).toBe(SYSTEM_STORAGE_NO_SUCH_DEVICE)
    expect(() => w.api.handlers.getAvailableCapacity(w.ctx(DECLARED), '0123')).toThrow(
      SYSTEM_STORAGE_CAPACITY_ERROR
    )
    expect(Object.keys(w.api.handlers).sort()).toEqual([
      'ejectDevice',
      'getAvailableCapacity',
      'getInfo'
    ])
  })

  it('refuses an extension without the grant with Chrome\u2019s no-permission error', () => {
    const w = world()
    for (const method of ['getInfo', 'getAvailableCapacity', 'ejectDevice']) {
      expect(() => w.api.handlers[method](w.ctx(NOT_DECLARED), '0123')).toThrow(
        SYSTEM_STORAGE_NO_PERMISSION_ERROR
      )
    }
  })

  it('reports a binding-style argument error as the call\u2019s error, not a crash', () => {
    const w = world()
    let caught: unknown
    try {
      w.api.handlers.getAvailableCapacity(w.ctx(DECLARED), 7)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(ApiError)
    expect((caught as Error).message).toBe(
      "Error at parameter 'id': Invalid type. Expected string, found number."
    )
  })
})
