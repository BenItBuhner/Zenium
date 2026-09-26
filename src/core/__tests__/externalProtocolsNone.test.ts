import { describe, expect, it, vi } from 'vitest'
import type { Tab } from '../../shared/types'
import type { Browser } from '../browser'
import { ExternalProtocolService, type HostExternalRequest } from '../externalProtocols'
import type { ZenWindow } from '../window'

/**
 * `ExternalProtocolService.request` with `handler: 'none'` – the host is sure no app opens the
 * link – on a browser reduced to what that branch touches: the host's answer, the tab it
 * navigates, the chrome's own opener, the toast, and the sheet it must NOT put up.
 */
function harness(): {
  service: ExternalProtocolService
  win: ZenWindow
  answers: Array<{ requestId: string; allow: boolean }>
  navigated: Array<{ tabId: string; url: string }>
  opened: Array<{ url: string; win: ZenWindow }>
  toasts: Array<{ message: string; kind: string; win: ZenWindow }>
  emitted: string[]
} {
  const answers: Array<{ requestId: string; allow: boolean }> = []
  const navigated: Array<{ tabId: string; url: string }> = []
  const opened: Array<{ url: string; win: ZenWindow }> = []
  const toasts: Array<{ message: string; kind: string; win: ZenWindow }> = []
  const emitted: string[] = []
  const win = { id: 'w1' } as unknown as ZenWindow
  const tabs: Record<string, Tab> = {
    t1: { id: 't1', url: 'https://shop.example/checkout' } as Tab
  }
  const browser = {
    state: { settings: { externalProtocols: {} }, commit: vi.fn() },
    tabs: {
      tab: (id: string) => tabs[id],
      navigate: (tabId: string, url: string) => {
        navigated.push({ tabId, url })
      }
    },
    platform: {
      externalProtocols: {
        respond: (requestId: string, allow: boolean) => {
          answers.push({ requestId, allow })
        }
      }
    },
    focusedWindow: () => win,
    openExternalUrl: (url: string, w: ZenWindow) => {
      opened.push({ url, win: w })
    },
    toast: (message: string, kind: string, w: ZenWindow) => {
      toasts.push({ message, kind, win: w })
    },
    emit: (channel: string) => {
      emitted.push(channel)
    }
  }
  const b = browser as unknown as Browser
  return {
    service: new ExternalProtocolService(b),
    win,
    answers,
    navigated,
    opened,
    toasts,
    emitted
  }
}

let seq = 0
function none(url: string, tabId: string | null = 't1'): HostExternalRequest {
  return {
    requestId: `ext-${++seq}`,
    tabId,
    url,
    appName: null,
    handler: 'none',
    userGesture: true
  }
}

const FALLBACK = 'https://zxing.org/w/decode'
const WITH_FALLBACK = `intent://scan/#Intent;scheme=zxing;package=com.google.zxing.client.android;S.browser_fallback_url=${encodeURIComponent(FALLBACK)};end`
const WITH_PACKAGE =
  'intent://scan/#Intent;scheme=zxing;package=com.google.zxing.client.android;end'
const BARE = 'intent://scan/#Intent;scheme=zxing;end'
const NO_APP = 'No app can open this link'

describe("ExternalProtocolService: the host's word that no app can open the link (handler 'none')", () => {
  it('an intent:// with S.browser_fallback_url: the host is answered false and the tab loads the fallback – no sheet, nothing pending', () => {
    const h = harness()
    const req = none(WITH_FALLBACK)
    h.service.request(req, h.win)
    expect(h.answers).toEqual([{ requestId: req.requestId, allow: false }])
    expect(h.navigated).toEqual([{ tabId: 't1', url: FALLBACK }])
    expect(h.opened).toEqual([])
    expect(h.toasts).toEqual([])
    expect(h.emitted).toEqual([])
    // Nothing was held for the sheet: a late answer for the id is a no-op.
    h.service.respond(req.requestId, true, true)
    expect(h.answers).toHaveLength(1)
  })

  it('a package and no fallback: the tab loads the Play web listing of the app the link wants', () => {
    const h = harness()
    const req = none(WITH_PACKAGE)
    h.service.request(req, h.win)
    expect(h.answers).toEqual([{ requestId: req.requestId, allow: false }])
    expect(h.navigated).toEqual([
      {
        tabId: 't1',
        url: 'https://play.google.com/store/apps/details?id=com.google.zxing.client.android'
      }
    ])
    expect(h.toasts).toEqual([])
  })

  it('a fallback beats a package: an intent naming both loads the fallback, not the store', () => {
    const h = harness()
    h.service.request(none(WITH_FALLBACK), h.win)
    expect(h.navigated.map((n) => n.url)).toEqual([FALLBACK])
  })

  it('neither: the toast "No app can open this link" on the window, the host still answered false', () => {
    const h = harness()
    for (const url of [BARE, 'zoommtg://join?confno=1', 'market://details?id=com.x', 'tel:+1']) {
      const req = none(url)
      h.service.request(req, h.win)
      expect(h.answers.at(-1)).toEqual({ requestId: req.requestId, allow: false })
    }
    expect(h.toasts).toEqual(Array(4).fill({ message: NO_APP, kind: 'info', win: h.win }))
    expect(h.navigated).toEqual([])
    expect(h.opened).toEqual([])
    expect(h.emitted).toEqual([])
  })

  it("no tab (the chrome's own request): the fallback or the listing opens through openExternalUrl on the window", () => {
    const h = harness()
    h.service.request(none(WITH_FALLBACK, null), h.win)
    h.service.request(none(WITH_PACKAGE, null), h.win)
    expect(h.opened).toEqual([
      { url: FALLBACK, win: h.win },
      {
        url: 'https://play.google.com/store/apps/details?id=com.google.zxing.client.android',
        win: h.win
      }
    ])
    expect(h.navigated).toEqual([])
    // A tab id the browser no longer knows reads the same as none.
    h.service.request(none(WITH_FALLBACK, 'gone'), h.win)
    expect(h.opened).toHaveLength(3)
    expect(h.navigated).toEqual([])
    // Nothing to open: the toast, on the window given.
    h.service.request(none(BARE, null), h.win)
    expect(h.toasts).toEqual([{ message: NO_APP, kind: 'info', win: h.win }])
  })

  it('the window defaults to the focused one', () => {
    const h = harness()
    h.service.request(none(BARE))
    expect(h.toasts).toEqual([{ message: NO_APP, kind: 'info', win: h.win }])
  })

  it('a malformed intent: URL never throws and ends in the toast – no fallback, no listing', () => {
    const h = harness()
    const malformed = [
      'intent:',
      'intent://',
      'intent://host',
      'intent://host#Intent;',
      'intent://host#Intent',
      'intent://x#Intent;S.browser_fallback_url=;end',
      'intent://x#Intent;S.browser_fallback_url=https%3A%2F%2Fzxing.org%2F',
      'intent://x#Intent;package=com.x',
      'intent://x#Intent;package=com.x;S.browser_fallback_url=https%3A%2F%2Fzxing.org%2F',
      'intent://x#Intent;S.browser_fallback_url=javascript%3Aalert(1);end',
      'intent://x#Intent;S.browser_fallback_url=file%3A%2F%2F%2Fetc%2Fpasswd;end',
      'intent://x#Intent;S.browser_fallback_url=intent%3A%2F%2Fy%23Intent%3Bend;end',
      'intent://x#Intent;S.browser_fallback_url=%E0%A4%A;end',
      'intent://x#Intent;package=;end',
      'intent://x#Intent;package=com.x%3Bmalice;end',
      'intent://x#Intent;package=../evil;end',
      'intent://x;package=com.x#Intent;end',
      'intent://x?S.browser_fallback_url=https%3A%2F%2Fzxing.org%2F#Intent;end',
      'intent://x#Intent;;;end',
      'intent://x#Intent;=;end',
      'intent://x#other;package=com.x;end',
      'INTENT://x#Intent;end'
    ]
    for (const url of malformed) {
      const req = none(url)
      expect(() => h.service.request(req, h.win), url).not.toThrow()
      expect(h.answers.at(-1), url).toEqual({ requestId: req.requestId, allow: false })
      expect(h.toasts.at(-1), url).toEqual({ message: NO_APP, kind: 'info', win: h.win })
    }
    expect(h.toasts).toHaveLength(malformed.length)
    expect(h.navigated).toEqual([])
    expect(h.opened).toEqual([])
    expect(h.emitted).toEqual([])
  })

  it("a blocked scheme is refused before the host's word is read: no toast, no fallback", () => {
    const h = harness()
    const req = none('zenium://settings/privacy')
    h.service.request(req, h.win)
    expect(h.answers).toEqual([{ requestId: req.requestId, allow: false }])
    expect(h.toasts).toEqual([])
    expect(h.navigated).toEqual([])
  })
})
