import { describe, expect, it } from 'vitest'
import { DownloadLimiter, type DownloadLimiterDeps } from '../downloadLimiter'
import type { ContentDefault } from '../../shared/contentSettings'
import type { PermissionRequestDetails } from '../permissions'

interface World {
  pages: Map<string, { url: string; privateContainerId?: string }>
  activations: Map<string, number>
  settings: Map<string, ContentDefault>
  asked: Array<{ url: string; details: PermissionRequestDetails }>
  answer: boolean
}

function world(): { limiter: DownloadLimiter; w: World } {
  const w: World = {
    pages: new Map([['t1', { url: 'https://files.example.com/list' }]]),
    activations: new Map(),
    settings: new Map(),
    asked: [],
    answer: true
  }
  const deps: DownloadLimiterDeps = {
    page: (tabId) => w.pages.get(tabId) ?? null,
    activatedAt: (tabId) => w.activations.get(tabId) ?? -Infinity,
    setting: (url) => w.settings.get(new URL(url).origin) ?? 'ask',
    ask: async (url, details) => {
      w.asked.push({ url, details })
      return w.answer
    }
  }
  return { limiter: new DownloadLimiter(deps), w }
}

describe('DownloadLimiter (automatic-downloads, PS-71)', () => {
  it('lets the first download of a document through and asks about the next one without a gesture', () => {
    const { limiter } = world()
    expect(limiter.judge('t1')?.limit).toBe('allow')
    expect(limiter.judge('t1')?.limit).toBe('ask')
    expect(limiter.judge('t1')?.limit).toBe('ask')
  })

  it('frees one download per gesture: a click that fires three at once frees the first alone', () => {
    const { limiter, w } = world()
    w.activations.set('t1', 100)
    expect(limiter.judge('t1')?.limit).toBe('allow')
    expect(limiter.judge('t1')?.limit).toBe('ask')
    expect(limiter.judge('t1')?.limit).toBe('ask')
    // Another click, later: one more.
    w.activations.set('t1', 4000)
    expect(limiter.judge('t1')?.limit).toBe('allow')
    expect(limiter.judge('t1')?.limit).toBe('ask')
  })

  it("reads the site's row past the free one: allowed sites run, blocked sites lose the transfer", () => {
    const { limiter, w } = world()
    w.settings.set('https://files.example.com', 'allow')
    expect(limiter.judge('t1')?.limit).toBe('allow')
    expect(limiter.judge('t1')?.limit).toBe('allow')
    w.settings.set('https://files.example.com', 'deny')
    expect(limiter.judge('t1')?.limit).toBe('refuse')
  })

  it('counts per tab and per site: another site in the tab starts over, a same-site page carries on', () => {
    const { limiter, w } = world()
    expect(limiter.judge('t1')?.limit).toBe('allow')
    w.pages.set('t1', { url: 'https://files.example.com/other' })
    expect(limiter.judge('t1')?.limit).toBe('ask')
    w.pages.set('t1', { url: 'https://elsewhere.example.org/' })
    expect(limiter.judge('t1')?.limit).toBe('allow')
    // Another tab of the first site has its own count.
    w.pages.set('t2', { url: 'https://files.example.com/list' })
    expect(limiter.judge('t2')?.limit).toBe('allow')
  })

  it('asks the permission store with the tab and, for a private tab, its container', async () => {
    const { limiter, w } = world()
    w.pages.set('p1', { url: 'https://files.example.com/list', privateContainerId: 'private' })
    limiter.judge('p1')
    const judged = limiter.judge('p1')
    expect(judged?.limit).toBe('ask')
    await expect(judged?.ask()).resolves.toBe(true)
    expect(w.asked).toEqual([
      {
        url: 'https://files.example.com/list',
        details: { tabId: 'p1', privateContainerId: 'private' }
      }
    ])
  })

  it('has nothing to say for a transfer without a page, and forgets a closed tab', () => {
    const { limiter, w } = world()
    expect(limiter.judge('nope')).toBeNull()
    expect(limiter.judge('t1')?.limit).toBe('allow')
    limiter.onTabGone('t1')
    expect(limiter.judge('t1')?.limit).toBe('allow')
    // A page without a site (about:blank) still counts its own downloads.
    w.pages.set('t3', { url: 'about:blank' })
    expect(limiter.judge('t3')?.limit).toBe('allow')
    expect(limiter.judge('t3')?.limit).toBe('ask')
  })
})
