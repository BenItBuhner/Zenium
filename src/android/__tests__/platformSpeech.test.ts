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

/** A bridge that records what the platform sends Kotlin. */
function fakeBridge(): { bridge: Bridge; sent: Array<{ method: string; args: unknown }> } {
  const sent: Array<{ method: string; args: unknown }> = []
  const bridge = {
    call: async (method: string, args: unknown) => {
      sent.push({ method, args })
      return method === 'speech.voices' ? [] : null
    },
    send: (method: string, args: unknown) => {
      sent.push({ method, args })
    },
    callSync: () => undefined
  } as unknown as Bridge
  return { bridge, sent }
}

describe('the speech host behind read aloud (interface 3.2: present only with an engine)', () => {
  it('is left out, with the capability off, when boot found no text-to-speech engine', () => {
    for (const boot of [BOOT, { ...BOOT, readAloud: false }]) {
      const platform = new AndroidPlatform(fakeBridge().bridge, boot)
      expect(platform.speech).toBeUndefined()
      expect(platform.capabilities.readAloud).toBe(false)
    }
  })

  it('is built over the bridge, with the capability on, when boot found one', async () => {
    const { bridge, sent } = fakeBridge()
    const platform = new AndroidPlatform(bridge, { ...BOOT, readAloud: true })
    expect(platform.capabilities.readAloud).toBe(true)
    const speech = platform.speech
    expect(speech).toBeDefined()
    await speech!.voices()
    // `speak` flushes the engine's queue; `prepare` queues the next sentence behind the current one.
    speech!.speak('u1', 'One.', { voiceId: 'v', lang: 'en-GB', rate: 1.2 })
    speech!.prepare!('u2', 'Two.', { voiceId: 'v', lang: 'en-GB', rate: 1.2 })
    speech!.stop()
    expect(sent).toEqual([
      { method: 'speech.voices', args: undefined },
      {
        method: 'speech.speak',
        args: {
          utteranceId: 'u1',
          text: 'One.',
          voiceId: 'v',
          lang: 'en-GB',
          rate: 1.2,
          queue: 'flush'
        }
      },
      {
        method: 'speech.speak',
        args: {
          utteranceId: 'u2',
          text: 'Two.',
          voiceId: 'v',
          lang: 'en-GB',
          rate: 1.2,
          queue: 'add'
        }
      },
      { method: 'speech.stop', args: undefined }
    ])
  })
})
