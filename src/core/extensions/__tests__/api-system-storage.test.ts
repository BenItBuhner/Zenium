import { describe, expect, it } from 'vitest'
import { API_SPEC } from '../api/spec'
import {
  SYSTEM_STORAGE_CAPACITY_ERROR,
  SYSTEM_STORAGE_EVENTS,
  SYSTEM_STORAGE_METHODS,
  SYSTEM_STORAGE_NO_SUCH_DEVICE,
  SYSTEM_STORAGE_PERMISSION,
  answerSystemStorage
} from '../api/systemStorage'
import { WITHHELD_PERMISSIONS } from '../withheldPermissions'

describe('chrome.system.storage over no devices', () => {
  it('getInfo lists nothing', () => {
    expect(answerSystemStorage('getInfo', [])).toEqual([])
  })

  it('getAvailableCapacity fails with Chrome\u2019s error for an id that names no device', () => {
    expect(() => answerSystemStorage('getAvailableCapacity', ['0123'])).toThrow(
      SYSTEM_STORAGE_CAPACITY_ERROR
    )
    expect(() => answerSystemStorage('getAvailableCapacity', [])).toThrow(
      "Error at parameter 'id': Invalid type. Expected string, found undefined."
    )
  })

  it('ejectDevice answers no_such_device, as Chrome does for an unknown id', () => {
    expect(answerSystemStorage('ejectDevice', ['0123'])).toBe(SYSTEM_STORAGE_NO_SUCH_DEVICE)
    expect(answerSystemStorage('ejectDevice', ['0123'])).toBe('no_such_device')
    expect(() => answerSystemStorage('ejectDevice', [7])).toThrow("Error at parameter 'id'")
  })

  it('reports a method it does not know rather than answering it', () => {
    expect(() => answerSystemStorage('formatDevice', ['0123'])).toThrow(
      'chrome.system.storage.formatDevice is not a function'
    )
  })

  it('is in the spec behind the system.storage permission with Chrome\u2019s methods, events and enums', () => {
    const ns = API_SPEC['system.storage']
    expect(ns.permissions).toEqual([SYSTEM_STORAGE_PERMISSION])
    expect(Object.keys(ns.methods).sort()).toEqual([...SYSTEM_STORAGE_METHODS].sort())
    expect(ns.methods.getInfo.params).toEqual([])
    const id = { name: 'id', type: 'string', optional: false }
    expect(ns.methods.getAvailableCapacity.params).toEqual([id])
    expect(ns.methods.ejectDevice.params).toEqual([id])
    expect(Object.keys(ns.events)).toEqual([...SYSTEM_STORAGE_EVENTS])
    expect(ns.constants).toEqual({
      StorageUnitType: { FIXED: 'fixed', REMOVABLE: 'removable', UNKNOWN: 'unknown' },
      EjectDeviceResultCode: {
        SUCCESS: 'success',
        IN_USE: 'in_use',
        NO_SUCH_DEVICE: 'no_such_device',
        FAILURE: 'failure'
      }
    })
    // Routed, not inert: the hosts answer, so the permission gate is theirs too.
    expect(ns.shape).toBeUndefined()
    expect(Object.values(ns.methods).every((m) => m.inert === undefined)).toBe(true)
  })

  it('is the permission the engine never sees', () => {
    expect(WITHHELD_PERMISSIONS).toContain(SYSTEM_STORAGE_PERMISSION)
  })
})
