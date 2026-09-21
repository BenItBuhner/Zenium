import { describe, expect, it } from 'vitest'
import type { Bridge } from '../bridge'
import { AndroidPlatform, safeBrowsingHitFrom, type BootInfo } from '../platform'

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

/** A bridge whose `privacy.lookup` answers `reply`, recording every call. */
function fakeBridge(reply: unknown): {
  bridge: Bridge
  calls: Array<{ method: string; args: Record<string, unknown> }>
} {
  const calls: Array<{ method: string; args: Record<string, unknown> }> = []
  const bridge = {
    call: async (method: string, args: Record<string, unknown>) => {
      calls.push({ method, args })
      return method === 'privacy.lookup' ? reply : null
    },
    send: (method: string, args: Record<string, unknown>) => {
      calls.push({ method, args })
    },
    callSync: () => undefined
  } as unknown as Bridge
  return { bridge, calls }
}

/**
 * The Kotlin engine holds the Safe Browsing tables (`privacy/SafeBrowsing.kt`); the core's
 * service asks it where it needs a table's word (`Host.kt`, `privacy.lookup`).
 */
describe('AndroidPlatform.privacy (Safe Browsing)', () => {
  it('says the host holds the tables and asks it for a lookup, checking the answer', async () => {
    const { bridge, calls } = fakeBridge({
      feedId: 'urlhaus',
      threat: 'malware',
      expression: 'evil.example',
      remote: false
    })
    const privacy = new AndroidPlatform(bridge, BOOT).privacy
    expect(privacy?.safeBrowsingTables).toBe('host')
    expect(await privacy?.lookupSafeBrowsing?.('http://evil.example/setup.exe')).toEqual({
      feedId: 'urlhaus',
      threat: 'malware',
      expression: 'evil.example',
      remote: false
    })
    expect(calls).toEqual([
      { method: 'privacy.lookup', args: { url: 'http://evil.example/setup.exe' } }
    ])
  })

  it('reads nothing listed, and an answer that is not a hit, as null', async () => {
    const { bridge } = fakeBridge(null)
    const privacy = new AndroidPlatform(bridge, BOOT).privacy
    expect(await privacy?.lookupSafeBrowsing?.('https://fine.example/')).toBeNull()
    expect(safeBrowsingHitFrom(undefined)).toBeNull()
    expect(safeBrowsingHitFrom('malware')).toBeNull()
    expect(safeBrowsingHitFrom({ feedId: 'urlhaus' })).toBeNull()
    expect(safeBrowsingHitFrom({ feedId: 'urlhaus', expression: 7 })).toBeNull()
    // Kotlin's own threat names; anything else is reported as unknown, never as a remote answer.
    expect(
      safeBrowsingHitFrom({ feedId: 'x', threat: 'weird', expression: 'a.example', remote: true })
    ).toEqual({ feedId: 'x', threat: 'unknown', expression: 'a.example', remote: false })
    expect(safeBrowsingHitFrom({ feedId: 'x', expression: 'a.example' })).toMatchObject({
      threat: 'unknown'
    })
  })
})
