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

function fakeBridge(reply: (method: string) => unknown): {
  bridge: Bridge
  calls: Array<{ method: string; args: Record<string, unknown> }>
} {
  const calls: Array<{ method: string; args: Record<string, unknown> }> = []
  const bridge = {
    call: async (method: string, args: Record<string, unknown>) => {
      calls.push({ method, args })
      return reply(method)
    },
    send: (method: string, args: Record<string, unknown>) => {
      calls.push({ method, args })
    },
    callSync: () => undefined
  } as unknown as Bridge
  return { bridge, calls }
}

/**
 * The web capture's engine on Android (`shared/capture.ts`): the picture's Save goes to
 * Kotlin's Downloads collection (`Host.saveToDownloads`, Take Screenshot's path) and the path it
 * hands back is what the core lists; its Copy goes down the image context menu's path, which
 * takes a data URL already (`Host.copyImage`).
 */
describe('the Android capture host', () => {
  it('saves a capture through the downloads bridge and hands the path back', async () => {
    const { bridge, calls } = fakeBridge((method) =>
      method === 'download.saveFile' ? '/storage/emulated/0/Download/Screenshot 2026-09-23 at 14.05.09.png' : null
    )
    const platform = new AndroidPlatform(bridge, BOOT)
    const file = { name: 'Screenshot 2026-09-23 at 14.05.09.png', mimeType: 'image/png', data: 'iVBORw0KGgo=' }
    await expect(platform.downloads.saveFile?.(file)).resolves.toBe(
      '/storage/emulated/0/Download/Screenshot 2026-09-23 at 14.05.09.png'
    )
    expect(calls).toEqual([{ method: 'download.saveFile', args: file }])
  })

  it('a save Kotlin could not make is null, never a path', async () => {
    const { bridge } = fakeBridge(() => null)
    const platform = new AndroidPlatform(bridge, BOOT)
    await expect(
      platform.downloads.saveFile?.({ name: 'shot.png', mimeType: 'image/png', data: 'iVBORw0KGgo=' })
    ).resolves.toBeNull()
  })

  it('copies a capture down the image context menu’s path with the data URL as it is', async () => {
    const { bridge, calls } = fakeBridge((method) => method === 'clipboard.writeImage')
    const platform = new AndroidPlatform(bridge, BOOT)
    const url = 'data:image/png;base64,iVBORw0KGgo='
    await expect(platform.clipboard.writeImageFromUrl(url)).resolves.toBe(true)
    expect(calls).toEqual([{ method: 'clipboard.writeImage', args: { url } }])
  })
})
