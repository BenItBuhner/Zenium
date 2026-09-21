import { describe, expect, it, vi } from 'vitest'
import type { Browser } from '../../browser'
import { sanitizePasswordSettings } from '../../../shared/defaults'
import { emptyPasswordsDevice } from '../../../shared/types'
import { PasswordService } from '../service'
import { FakeKeyWrap, MemoryIO } from './fakes'

/**
 * Just enough of a `Browser` for the service: the store's documents, the passwords settings, the
 * volatile-state commit the status is broadcast through, favicons for summaries and toasts.
 */
function setup(options: { io?: MemoryIO; keys?: FakeKeyWrap } = {}): {
  io: MemoryIO
  keys: FakeKeyWrap
  service: PasswordService
} {
  const io = options.io ?? new MemoryIO()
  const keys = options.keys ?? new FakeKeyWrap()
  const browser = {
    platform: { io },
    state: {
      settings: { passwords: sanitizePasswordSettings(undefined) },
      passwordsDevice: emptyPasswordsDevice(),
      commit: vi.fn(),
      commitVolatile: vi.fn()
    },
    history: { faviconsByDomain: () => new Map<string, string>() },
    toast: vi.fn()
  }
  const service = new PasswordService(browser as unknown as Browser, {
    keys,
    reauth: { available: async () => false, verify: async () => false }
  })
  return { io, keys, service }
}

describe('PasswordService.unlock when the OS keystore refuses', () => {
  it('treats a dismissed prompt as something to try again, not as an unreadable vault', async () => {
    const first = setup()
    expect(await first.service.unlock()).toEqual({ status: 'ok', value: null })
    first.service.add({ url: 'https://example.com/login', username: 'ada', password: 'pw' })
    await first.service.store.flush()
    first.service.lock()

    const again = setup({ io: first.io, keys: first.keys })
    again.keys.refuse = 'cancelled'
    const denied = await again.service.unlock()
    expect(denied).toEqual({ status: 'denied', reason: 'refused: cancelled' })
    expect(again.service.status().locked).toBe(true)
    expect(again.service.status().error).toBeNull()

    again.keys.refuse = null
    expect(await again.service.unlock()).toEqual({ status: 'ok', value: null })
    expect(again.service.status().count).toBe(1)
  })

  it('reports a key the device invalidated for good as the vault being unreadable', async () => {
    const first = setup()
    await first.service.unlock()
    first.service.add({ url: 'https://example.com/login', username: 'ada', password: 'pw' })
    await first.service.store.flush()

    const again = setup({ io: first.io, keys: first.keys })
    again.keys.refuse = 'invalidated'
    expect(await again.service.unlock()).toEqual({
      status: 'denied',
      reason: 'refused: invalidated'
    })
    expect(again.service.status().error).toBe('refused: invalidated')

    // Starting over is the way out; the status clears with it.
    await again.service.reset()
    expect(again.service.status().error).toBeNull()
    expect(again.service.status().protection).toEqual({ os: false, passphrase: false })
  })

  it('offers the passphrase route when the vault has one, whatever the keystore said', async () => {
    const first = setup()
    await first.service.unlock()
    first.service.add({ url: 'https://example.com/login', username: 'ada', password: 'pw' })
    expect(await first.service.setPassphrase('open sesame please', undefined)).toEqual({
      status: 'ok',
      value: null
    })
    await first.service.store.flush()

    const again = setup({ io: first.io, keys: first.keys })
    again.keys.refuse = 'invalidated'
    expect(await again.service.unlock()).toEqual({ status: 'passphrase' })
    expect(again.service.status().error).toBeNull()
    expect(await again.service.unlock('open sesame please')).toEqual({ status: 'ok', value: null })
    expect(again.service.status().count).toBe(1)
  })

  it('leaves no vault behind when the prompt protecting a new one is dismissed', async () => {
    const { io, keys, service } = setup()
    keys.refuse = 'cancelled'
    expect(await service.unlock()).toEqual({ status: 'denied', reason: 'refused: cancelled' })
    expect(service.status().error).toBeNull()
    expect(io.documents.size).toBe(0)

    keys.refuse = null
    expect(await service.unlock()).toEqual({ status: 'ok', value: null })
    expect(service.status().protection.os).toBe(true)
  })
})
