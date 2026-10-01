import { describe, expect, it } from 'vitest'
import { TOP_SITES_MAX } from '../extensionApi'
import { backgroundUp, call, harness, manifest, record } from './runtimeHarness'

/**
 * `chrome.topSites.get` on the phone: the browser's most visited sites, as the new tab page
 * ranks them, in Chrome's `MostVisitedURL` shape (Google Arts & Culture's new tab awaits the
 * call before it draws anything; compat round 25, row 39).
 */
describe('chrome.topSites.get', () => {
  const attach = async (h: ReturnType<typeof harness>): Promise<void> => {
    await h.runtime.attach(record(h, {}, manifest({ permissions: ['topSites'] })))
    backgroundUp(h, 'bg1')
  }

  it('lists the most visited sites as url and title, in the ranking order, nothing else of the site', async () => {
    const h = harness()
    h.topSites.push(
      {
        url: 'https://news.example/today',
        title: 'News',
        favicon: 'data:image/png;base64,AA',
        score: 9
      },
      { url: 'https://docs.example/', title: 'Docs', favicon: null, score: 4 }
    )
    await attach(h)
    const reply = await call(h, 'bg1', 'topSites', 'get', [])
    expect(reply.error).toBeUndefined()
    expect(reply.result).toEqual([
      { url: 'https://news.example/today', title: 'News' },
      { url: 'https://docs.example/', title: 'Docs' }
    ])
  })

  it('answers the empty list for a fresh profile and at most Chrome’s twenty for a full one', async () => {
    const h = harness()
    await attach(h)
    expect((await call(h, 'bg1', 'topSites', 'get', [])).result).toEqual([])
    for (let i = 0; i < 30; i++)
      h.topSites.push({
        url: `https://site${i}.example/`,
        title: `Site ${i}`,
        favicon: null,
        score: 30 - i
      })
    const full = (await call(h, 'bg1', 'topSites', 'get', [])).result as unknown[]
    expect(full).toHaveLength(TOP_SITES_MAX)
    expect(full[0]).toEqual({ url: 'https://site0.example/', title: 'Site 0' })
  })

  it('names any other method of the namespace as not implemented', async () => {
    const h = harness()
    await attach(h)
    const reply = await call(h, 'bg1', 'topSites', 'nonsense', [])
    expect(String(reply.error)).toContain(
      'chrome.topSites.nonsense is not implemented on Zenium for Android'
    )
  })
})
