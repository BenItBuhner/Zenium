import { beforeEach, describe, expect, it, vi } from 'vitest'
import { isWebDavError } from '../../../core/sync/webdav'

/**
 * The desktop's fetch for the WebDAV transport (ID-32): Electron's `net.fetch` with the manual
 * redirect mode, `credentials: 'omit'` and `no-store`; the one answer that mode cannot give – a
 * 3xx, which Electron 44 turns into a cancelled request ("Redirect was cancelled") – typed as
 * the transport's `redirect` so it never reads as an unreachable server.
 */

const net = vi.hoisted(() => ({
  fetch: vi.fn<(url: string, init: Record<string, unknown>) => Promise<unknown>>()
}))

vi.mock('electron', () => ({ net, dialog: { showOpenDialog: vi.fn() } }))

const { ElectronSyncHost, webDavFetchError } = await import('../host')

beforeEach(() => {
  net.fetch.mockReset()
})

describe('ElectronSyncHost.fetch', () => {
  it('goes through net.fetch with the method as given, no redirect followed, no credentials, no cache', async () => {
    const answer = { status: 207, headers: new Headers(), text: async () => '<d:multistatus/>' }
    net.fetch.mockResolvedValue(answer)
    const host = new ElectronSyncHost()
    const signal = new AbortController().signal
    const reply = await host.fetch('https://cloud.example/remote.php/dav/files/alice/', {
      method: 'PROPFIND',
      headers: { Authorization: 'Basic x', Depth: '0' },
      body: '<d:propfind/>',
      signal
    })
    expect(reply).toBe(answer)
    expect(net.fetch).toHaveBeenCalledWith('https://cloud.example/remote.php/dav/files/alice/', {
      method: 'PROPFIND',
      headers: { Authorization: 'Basic x', Depth: '0' },
      body: '<d:propfind/>',
      signal,
      cache: 'no-store',
      redirect: 'manual',
      credentials: 'omit'
    })
  })

  it('types the cancelled redirect as the transport’s redirect, without the address; other failures pass as they are', async () => {
    const host = new ElectronSyncHost()
    net.fetch.mockRejectedValue(new TypeError('Redirect was cancelled'))
    const redirected = await host
      .fetch('https://cloud.example/dav/', { method: 'PROPFIND', headers: {} })
      .then(
        () => null,
        (error: unknown) => error
      )
    expect(isWebDavError(redirected)).toBe(true)
    expect(redirected).toMatchObject({ kind: 'redirect', status: 0, method: 'PROPFIND' })
    expect((redirected as Error).message).toBe('WebDAV PROPFIND: the address redirected')
    expect((redirected as Error).message).not.toContain('cloud.example')

    const refused = new TypeError('net::ERR_CONNECTION_REFUSED')
    net.fetch.mockRejectedValue(refused)
    await expect(
      host.fetch('https://cloud.example/dav/', { method: 'GET', headers: {} })
    ).rejects.toBe(refused)
  })

  it('webDavFetchError keys on Electron’s words alone', () => {
    const other = new Error('something else')
    expect(webDavFetchError(other, 'PUT')).toBe(other)
    expect(webDavFetchError('Redirect was cancelled', 'MKCOL')).toMatchObject({
      kind: 'redirect',
      method: 'MKCOL'
    })
  })
})
