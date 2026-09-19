import { describe, expect, it, vi } from 'vitest'
import { Browser } from '../browser'
import type { ZenWindow } from '../window'

/**
 * `openExternalUrl` on a browser reduced to what it touches: the tab manager, the routing and
 * the page service (a `zenium://settings` deep link is its; these URLs are not).
 */
function harness(): {
  open: (url: string, opts?: { fromIntent?: boolean }) => void
  created: Array<{ url: string; fromIntent: boolean }>
  pageOpens: Array<{ url: string; fromIntent: boolean | undefined }>
} {
  const created: Array<{ url: string; fromIntent: boolean }> = []
  const pageOpens: Array<{ url: string; fromIntent: boolean | undefined }> = []
  const win = {
    localSpace: null,
    activeSpaceId: 's1',
    host: { show: vi.fn(), focus: vi.fn() }
  } as unknown as ZenWindow
  const self = {
    routeSpaceFor: () => null,
    pages: {
      openUrl: (url: string, _win: unknown, _opener: unknown, opts: { fromIntent?: boolean }) => {
        pageOpens.push({ url, fromIntent: opts.fromIntent })
        return url.startsWith('zen://settings') || url.startsWith('zenium://settings')
      }
    },
    tabs: {
      createTab: (opts: { url: string; fromIntent: boolean }) => {
        created.push({ url: opts.url, fromIntent: opts.fromIntent })
        return { id: 'tab_new' }
      },
      switchSpace: vi.fn()
    }
  }
  return {
    open: (url, opts) => Browser.prototype.openExternalUrl.call(self, url, win, opts),
    created,
    pageOpens
  }
}

describe('openExternalUrl', () => {
  it('marks a tab another app sent so that mobile back at its root returns to that app', () => {
    const { open, created } = harness()
    open('https://sent.example/', { fromIntent: true })
    expect(created).toEqual([{ url: 'https://sent.example/', fromIntent: true }])
  })

  it('does not mark URLs the browser opens on its own behalf (release notes, a store fallback)', () => {
    const { open, created } = harness()
    open('https://github.com/example/releases')
    expect(created).toEqual([{ url: 'https://github.com/example/releases', fromIntent: false }])
  })

  it('hands an internal page address to the page service, the intent mark with it', () => {
    const { open, created, pageOpens } = harness()
    open('zenium://settings/privacy', { fromIntent: true })
    expect(created).toEqual([])
    expect(pageOpens).toEqual([{ url: 'zenium://settings/privacy', fromIntent: true }])
  })
})
