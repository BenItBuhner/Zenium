import { describe, expect, it } from 'vitest'
import type { Bridge } from '../bridge'
import { AndroidPlatform, type BootInfo } from '../platform'

const BOOT: BootInfo = {
  version: '0.0.0-test',
  sdkInt: 34,
  signer: null,
  packageName: null,
  files: {},
  downloadsDir: '/sdcard/Download',
  insets: { top: 0, right: 0, bottom: 0, left: 0 },
  fullscreen: false
}

function fakeBridge(reply: unknown): {
  bridge: Bridge
  calls: Array<{ method: string; args: Record<string, unknown> }>
} {
  const calls: Array<{ method: string; args: Record<string, unknown> }> = []
  const bridge = {
    call: async (method: string, args: Record<string, unknown>) => {
      calls.push({ method, args })
      return method === 'dialog.openText' ? reply : null
    },
    send: (method: string, args: Record<string, unknown>) => {
      calls.push({ method, args })
    },
    callSync: () => undefined
  } as unknown as Bridge
  return { bridge, calls }
}

describe('Android file import (ID-23)', () => {
  it('has no other browser to read: the platform offers no importHost', () => {
    const { bridge } = fakeBridge([])
    const platform = new AndroidPlatform(bridge, BOOT)
    expect(platform.importHost).toBeUndefined()
  })

  it('hands the picker request, size cap included, to the document picker over the bridge', async () => {
    const picked = [{ name: 'bookmarks.html', text: '<DL></DL>' }]
    const { bridge, calls } = fakeBridge(picked)
    const platform = new AndroidPlatform(bridge, BOOT)
    const files = await platform.dialogs.pickTextFiles({
      title: 'Import bookmarks',
      extensions: ['html', 'htm'],
      maxBytes: 64 * 1024 * 1024
    })
    expect(files).toEqual(picked)
    expect(calls).toEqual([
      {
        method: 'dialog.openText',
        args: { title: 'Import bookmarks', extensions: ['html', 'htm'], maxBytes: 64 * 1024 * 1024 }
      }
    ])
  })
})
