import { BrowserState } from '@core/state'
import type { StoreIO } from '@core/platform'
import type { HostCapabilities, Platform } from '@shared/types'
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

/** A bridge that answers `storage.*` from `disk` and records every call. */
function fakeBridge(disk: Record<string, string>): {
  bridge: Bridge
  calls: Array<{ method: string; args: Record<string, unknown> }>
} {
  const calls: Array<{ method: string; args: Record<string, unknown> }> = []
  const answer = (method: string, args: Record<string, unknown>): unknown => {
    calls.push({ method, args })
    const name = args.name as string
    if (method === 'storage.read') return disk[name] ?? null
    if (method === 'storage.exists') return name in disk
    if (method === 'storage.write' || method === 'storage.writeSync') {
      disk[name] = args.text as string
      return method === 'storage.writeSync' ? true : null
    }
    return null
  }
  const bridge = {
    call: async (method: string, args: Record<string, unknown>) => answer(method, args),
    callSync: (method: string, args: Record<string, unknown>) => answer(method, args),
    send: (method: string, args: Record<string, unknown>) => {
      answer(method, args)
    }
  } as unknown as Bridge
  return { bridge, calls }
}

/** A profile as a running browser persists it: `cleanExit: false` tells it from first-run defaults. */
async function runningProfile(): Promise<string> {
  const files: Record<string, string> = {}
  const io: StoreIO = {
    readSync: (name) => files[name] ?? null,
    write: async (name, text) => {
      files[name] = text
    },
    writeSync: (name, text) => {
      files[name] = text
    }
  }
  const state = new BrowserState(io, 'linux' as Platform, {} as HostCapabilities, '0.0')
  state.load()
  await state.flush()
  const text = files['state.json']
  if (!text) throw new Error('state.json was not written')
  return text
}

/**
 * The boot order the handoff must survive: the payload defers `state.json` (a session over the
 * inline limit), the platform is built and the core reads the session before the fetched file
 * has been adopted. The profile must come through – a session read as absent boots as a first
 * run, and its first write replaces the user's file.
 */
describe('a deferred root document read before the boot fetch lands', () => {
  it('is the profile, read through the bridge, not first-run defaults', async () => {
    const profile = await runningProfile()
    const { bridge, calls } = fakeBridge({ 'state.json': profile, 'history.json': '{}' })
    const platform = new AndroidPlatform(bridge, {
      ...BOOT,
      files: { 'history.json': '{}' },
      deferred: [{ name: 'state.json', bytes: profile.length, etag: '1f4-18f3-0' }]
    })

    const state = new BrowserState(platform.io, platform.info.os, platform.capabilities, '0.0')
    state.load()
    // The persisted profile says it did not exit cleanly; first-run defaults never do.
    expect(state.uncleanExit).toBe(true)
    expect(calls).toEqual([{ method: 'storage.read', args: { name: 'state.json' } }])

    // The fetch lands later: the core keeps what it read, and reads it no second time from the host.
    platform.io.adopt({ 'state.json': profile })
    const again = new BrowserState(platform.io, platform.info.os, platform.capabilities, '0.0')
    again.load()
    expect(again.uncleanExit).toBe(true)
    expect(calls).toHaveLength(1)
  })

  it('is first-run defaults only when the host has no such document either', () => {
    const { bridge, calls } = fakeBridge({})
    const platform = new AndroidPlatform(bridge, { ...BOOT, files: {} })
    const state = new BrowserState(platform.io, platform.info.os, platform.capabilities, '0.0')
    state.load()
    expect(state.uncleanExit).toBe(false)
    // The session store asked for the document and its backup; the host had neither.
    expect(calls.map((c) => c.args.name)).toEqual(['state.json', 'state.json.bak'])
  })
})
