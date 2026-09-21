import { describe, expect, it, vi } from 'vitest'
import type { Browser } from '../../browser'
import { sanitizePasswordSettings } from '../../../shared/defaults'
import { emptyPasswordsDevice } from '../../../shared/types'
import type { PasswordsDeviceState } from '../../../shared/types'
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
  /** The range responses by prefix ('' when unset: clean; null: the request fails). */
  ranges: Record<string, string | null>
  state: { passwordsDevice: PasswordsDeviceState; commit: ReturnType<typeof vi.fn> }
} {
  const io = options.io ?? new MemoryIO()
  const keys = options.keys ?? new FakeKeyWrap()
  const ranges: Record<string, string | null> = {}
  const state = {
    settings: { passwords: sanitizePasswordSettings(undefined) },
    passwordsDevice: emptyPasswordsDevice(),
    commit: vi.fn(),
    commitVolatile: vi.fn()
  }
  const browser = {
    platform: {
      io,
      net: {
        fetchText: async (url: string) => {
          const text = ranges[url.slice(-5).toUpperCase()]
          return text === null
            ? { ok: false, status: 503, text: '' }
            : { ok: true, status: 200, text: text ?? '' }
        }
      }
    },
    state,
    history: { faviconsByDomain: () => new Map<string, string>() },
    toast: vi.fn()
  }
  const service = new PasswordService(browser as unknown as Browser, {
    keys,
    reauth: { available: async () => false, verify: async () => false }
  })
  return { io, keys, service, ranges, state }
}

/** SHA-1 prefix of "password" and the padded range it returns (see checkup.test.ts). */
const BREACHED_PREFIX = '5BAA6'
const RANGE_5BAA6 = [
  '003D68EB55068C33ACE09247EE4C639306B:3',
  '1E4C9B93F3F0682250B6CF8331B7EE68FD8:10434004',
  ''
].join('\r\n')

describe('PasswordService.runCheckup and the device\u2019s checkup summary (ID-19)', () => {
  async function finished(service: PasswordService): Promise<void> {
    for (let i = 0; i < 200 && service.status().checkup.running; i++)
      await new Promise((r) => setTimeout(r, 10))
  }

  it('records each login\u2019s verdict and writes the summary the vault-independent Safety Check reads', async () => {
    const { service, ranges, state } = setup()
    ranges[BREACHED_PREFIX] = RANGE_5BAA6
    await service.unlock()
    const bad = service.add({ url: 'https://a.example', username: 'ada', password: 'password' })
    const twin = service.add({ url: 'https://b.example', username: 'bob', password: 'password' })
    const ok = service.add({
      url: 'https://c.example',
      username: 'cat',
      password: 'a-long-unique-passphrase-9f'
    })
    expect(service.status().checkupSummary).toEqual({
      compromised: 0,
      weak: 0,
      reused: 0,
      checkedAt: null
    })

    service.runCheckup()
    await finished(service)
    const status = service.status()
    expect(status.checkup.error).toBeNull()
    expect(status.checkup.compromised.sort()).toEqual([bad.id, twin.id].sort())
    expect(service.store.get(bad.id)).toMatchObject({ breached: 10_434_004, leakWarnedAt: null })
    expect(service.store.get(ok.id)).toMatchObject({ breached: 0 })
    expect(service.store.get(ok.id)!.checkedAt).toBe(status.checkup.finishedAt)
    expect(status.checkupSummary).toEqual({
      compromised: 2,
      weak: 2,
      reused: 2,
      checkedAt: status.checkup.finishedAt
    })
    // Persisted with the profile, outside the vault, and read from there while locked.
    expect(state.passwordsDevice.checkupSummary).toEqual(status.checkupSummary)
    expect(state.commit).toHaveBeenCalled()
    await service.store.flush()
    service.lock()
    expect(service.status().locked).toBe(true)
    expect(service.status().checkupSummary).toEqual(status.checkupSummary)
    // The manager's list carries the verdicts.
    await service.unlock()
    expect(
      service
        .list()
        .map((c) => [c.username, c.breached])
        .sort()
    ).toEqual([
      ['ada', 10_434_004],
      ['bob', 10_434_004],
      ['cat', 0]
    ])
  })

  it('keeps the compromised count live off the vault and forgets the summary with a reset', async () => {
    const { service, ranges, state } = setup()
    ranges[BREACHED_PREFIX] = RANGE_5BAA6
    await service.unlock()
    const bad = service.add({ url: 'https://a.example', username: 'ada', password: 'password' })
    service.runCheckup()
    await finished(service)
    expect(service.status().checkupSummary.compromised).toBe(1)
    // A change of password clears the verdict; the count follows without another run.
    service.update(bad.id, { password: 'something-else-entirely' })
    expect(service.status().checkupSummary).toMatchObject({ compromised: 0, weak: 1 })
    expect(service.status().checkupSummary.checkedAt).not.toBeNull()
    await service.reset()
    expect(state.passwordsDevice.checkupSummary).toEqual({
      compromised: 0,
      weak: 0,
      reused: 0,
      checkedAt: null
    })
  })

  it('a cancelled or offline run leaves the last summary in place', async () => {
    const { service, ranges, state } = setup()
    ranges[BREACHED_PREFIX] = null
    await service.unlock()
    service.add({ url: 'https://a.example', username: 'ada', password: 'password' })
    service.runCheckup()
    await finished(service)
    expect(service.status().checkup.error).toMatch(/could not reach/)
    // Offline still is a finished run: nothing was looked up, and the summary says weak / reused.
    expect(state.passwordsDevice.checkupSummary).toMatchObject({
      compromised: 0,
      weak: 1,
      reused: 0
    })
    const before = state.passwordsDevice.checkupSummary
    service.runCheckup()
    service.cancelCheckup()
    await finished(service)
    expect(service.status().checkup.error).toBe('Checkup cancelled')
    expect(state.passwordsDevice.checkupSummary).toBe(before)
  })
})

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
