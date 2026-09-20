/**
 * `chrome.system.storage` as Chrome shows it on a machine with no storage devices. The engine's
 * own implementation crashes the browser (`withheldPermissions.ts`: Electron never instantiates
 * the `StorageMonitor` the API dereferences), so the permission is withheld from the engine and
 * the browser layer answers instead: `getInfo` lists nothing, `getAvailableCapacity` fails with
 * the error Chrome gives for an id that names no device, `ejectDevice` answers `no_such_device`
 * as Chrome does for an unknown id, and `onAttached` / `onDetached` exist and never fire. Chrome
 * hides the namespace from extensions that do not declare the permission; so does the shim.
 */

export const SYSTEM_STORAGE_PERMISSION = 'system.storage'

export const SYSTEM_STORAGE_NO_PERMISSION_ERROR =
  "The extension does not have the 'system.storage' permission."

/**
 * Chrome's `SystemStorageGetAvailableCapacityFunction` error: its provider answers a negative
 * capacity for a transient id that matches no device, and the function reports this.
 */
export const SYSTEM_STORAGE_CAPACITY_ERROR = 'Error occurred when querying available capacity.'

/** Chrome's `EjectDeviceResultCode` for a transient id that matches no device. */
export const SYSTEM_STORAGE_NO_SUCH_DEVICE = 'no_such_device'

export const SYSTEM_STORAGE_METHODS = ['getInfo', 'getAvailableCapacity', 'ejectDevice'] as const

export const SYSTEM_STORAGE_EVENTS = ['onAttached', 'onDetached'] as const

/** Chrome's `system.storage` enums, as the namespace exposes them. */
export const SYSTEM_STORAGE_CONSTANTS: Record<string, Record<string, string>> = {
  StorageUnitType: { FIXED: 'fixed', REMOVABLE: 'removable', UNKNOWN: 'unknown' },
  EjectDeviceResultCode: {
    SUCCESS: 'success',
    IN_USE: 'in_use',
    NO_SUCH_DEVICE: SYSTEM_STORAGE_NO_SUCH_DEVICE,
    FAILURE: 'failure'
  }
}

/** Chrome's `system.storage.StorageUnitInfo`; the list Zenium answers is always empty. */
export interface StorageUnitInfo {
  id: string
  name: string
  type: 'fixed' | 'removable' | 'unknown'
  capacity: number
}

/**
 * Chrome's answer to one `system.storage` call over no devices. Throws an `Error` carrying the
 * message Chrome reports through `runtime.lastError` where Chrome fails the call; the hosts turn
 * that into their call error. The method name is validated against the API table before it gets
 * here; an unknown one is reported all the same rather than answered.
 */
export function answerSystemStorage(method: string, args: readonly unknown[]): unknown {
  switch (method) {
    case 'getInfo':
      return [] satisfies StorageUnitInfo[]
    case 'getAvailableCapacity':
      requireId(args[0])
      throw new Error(SYSTEM_STORAGE_CAPACITY_ERROR)
    case 'ejectDevice':
      requireId(args[0])
      return SYSTEM_STORAGE_NO_SUCH_DEVICE
    default:
      throw new Error(`chrome.system.storage.${method} is not a function`)
  }
}

function requireId(value: unknown): void {
  if (typeof value !== 'string')
    throw new TypeError(
      `Error at parameter 'id': Invalid type. Expected string, found ${typeof value}.`
    )
}
