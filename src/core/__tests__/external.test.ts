import { describe, expect, it } from 'vitest'
import type { PermissionPrompt, Tab } from '../../shared/types'
import type { Browser } from '../browser'
import type { PermissionPromptHost, StoreIO } from '../platform'
import { ExternalLaunches } from '../external'
import { PermissionService } from '../permissions'
import { PopupBlocker } from '../popups'

function fakeIo(): StoreIO {
  return { readSync: () => null, write: async () => undefined, writeSync: () => undefined }
}

function harness(answer: boolean): {
  browser: Browser
  asked: PermissionPrompt[]
  opened: string[]
  clock: { now: number }
} {
  const asked: PermissionPrompt[] = []
  const opened: string[] = []
  const clock = { now: 50_000 }
  const prompts: PermissionPromptHost = {
    show: async (request) => {
      asked.push(request)
      return answer ? 'allow' : 'block'
    },
    cancel: () => undefined
  }
  const tabs: Record<string, Tab> = {
    t1: { id: 't1', url: 'https://shop.example/checkout' } as Tab
  }
  const browser = {
    permissions: new PermissionService(fakeIo(), prompts),
    state: { commitVolatile: () => undefined },
    tabs: { tab: (id: string) => tabs[id], createTab: () => undefined, windowFor: () => ({}) },
    platform: {
      shell: {
        openExternal: (url: string) => {
          opened.push(url)
        }
      }
    }
  }
  const b = browser as unknown as Browser
  const self = browser as unknown as { popups: PopupBlocker; external: ExternalLaunches }
  self.popups = new PopupBlocker(b, () => clock.now)
  self.external = new ExternalLaunches(b, () => clock.now)
  return { browser: b, asked, opened, clock }
}

describe('ExternalLaunches', () => {
  it('needs a gesture: without one the launch is listed, not asked, not opened', async () => {
    const h = harness(true)
    expect(await h.browser.external.request('t1', 'zoommtg://join')).toBe(false)
    expect(h.asked).toEqual([])
    expect(h.browser.popups.blockedFor('t1')).toEqual([
      { url: 'zoommtg://join', at: h.clock.now, kind: 'external' }
    ])
  })

  it('asks once the user tapped, and remembers the yes per scheme', async () => {
    const h = harness(true)
    h.browser.popups.activate('t1')
    h.clock.now += 2000
    expect(await h.browser.external.request('t1', 'zoommtg://join')).toBe(true)
    expect(h.asked.length).toBe(1)
    expect(h.asked[0].message).toBe('Allow shop.example to open zoommtg: links in another app?')
    expect(h.asked[0].allowLabel).toBe('Open')
    // The host launches it (the answer only says whether it may): nothing opened from here.
    expect(h.opened).toEqual([])
    // Same scheme on the same site: no second prompt. Another scheme: asked again.
    expect(await h.browser.external.request('t1', 'zoommtg://other')).toBe(true)
    expect(h.asked.length).toBe(1)
    expect(await h.browser.external.request('t1', 'tel:+1')).toBe(true)
    expect(h.asked.length).toBe(2)
    expect(h.asked[1].message).toBe('Allow shop.example to open tel: links in another app?')
  })

  it('a gesture only counts for the activation window', async () => {
    const h = harness(true)
    h.browser.popups.activate('t1')
    h.clock.now += 6000
    expect(await h.browser.external.request('t1', 'mailto:a@b.c')).toBe(false)
    expect(h.asked).toEqual([])
    expect(h.browser.popups.blockedFor('t1').map((p) => p.url)).toEqual(['mailto:a@b.c'])
  })

  it('a refusal is not remembered, so the site can ask on the next tap', async () => {
    const h = harness(false)
    h.browser.popups.activate('t1')
    expect(await h.browser.external.request('t1', 'tel:+1')).toBe(false)
    expect(await h.browser.external.request('t1', 'tel:+1')).toBe(false)
    expect(h.asked.length).toBe(2)
    expect(h.browser.permissions.rules()).toEqual([])
  })

  it('"open anyway" from the blocked list asks and then opens through the host', async () => {
    const h = harness(true)
    await h.browser.external.request('t1', 'zoommtg://join')
    h.browser.popups.open('t1', 'zoommtg://join')
    await new Promise((r) => setTimeout(r, 0))
    expect(h.asked.length).toBe(1)
    expect(h.opened).toEqual(['zoommtg://join'])
    expect(h.browser.popups.blockedFor('t1')).toEqual([])
  })
})
