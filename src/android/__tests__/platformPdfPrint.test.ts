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

/** A bridge that records what the platform sends Kotlin and answers `view.printPdf` as told. */
function fakeBridge(answer: unknown): {
  bridge: Bridge
  sent: Array<{ method: string; args: unknown }>
} {
  const sent: Array<{ method: string; args: unknown }> = []
  const bridge = {
    call: async (method: string, args: unknown) => {
      sent.push({ method, args })
      return method === 'view.printPdf' ? answer : null
    },
    send: (method: string, args: unknown) => {
      sent.push({ method, args })
    },
    callSync: () => undefined
  } as unknown as Bridge
  return { bridge, sent }
}

describe('the PDF print host (CT-44: present only where the host answers `view.printPdf`)', () => {
  it('is left out, with the capability off, until boot says the host has the verb', () => {
    for (const boot of [BOOT, { ...BOOT, pdfPrint: false }]) {
      const platform = new AndroidPlatform(fakeBridge(true).bridge, boot)
      expect(platform.printPdf).toBeUndefined()
      expect(platform.capabilities.pdfPrint).toBe(false)
    }
  })

  it('hands the job to the host over the bridge as it is, and reads only a plain true as taken', async () => {
    const { bridge, sent } = fakeBridge(true)
    const platform = new AndroidPlatform(bridge, { ...BOOT, pdfPrint: true })
    expect(platform.capabilities.pdfPrint).toBe(true)
    const file = { tabId: 'tab_1', name: 'mooring.pdf', path: 'content://downloads/12', data: null }
    const copy = { tabId: 'tab_1', name: 'mooring.pdf', path: null, data: 'JVBERi0x' }
    expect(await platform.printPdf!(file)).toBe(true)
    expect(await platform.printPdf!(copy)).toBe(true)
    expect(sent).toEqual([
      { method: 'view.printPdf', args: file },
      { method: 'view.printPdf', args: copy }
    ])
    // A host that answers nothing, or anything but true, did not take the job.
    for (const answer of [null, undefined, false, 'ok', 1]) {
      const refused = new AndroidPlatform(fakeBridge(answer).bridge, { ...BOOT, pdfPrint: true })
      expect(await refused.printPdf!(file)).toBe(false)
    }
  })
})
