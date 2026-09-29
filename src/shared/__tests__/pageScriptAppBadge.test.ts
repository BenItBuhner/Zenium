// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { APP_BADGE_EVENT, type AppBadge } from '../appBadge'
import {
  DEFAULT_PAGE_FLAGS,
  installPageScript,
  type PageScriptFlags,
  type PageScriptMessage
} from '../pageScript'

/*
 * The page script's side of the Badging API (MW-51): the shim in the page's world posts every
 * `setAppBadge` / `clearAppBadge` as a DOM event, and the relay here turns it into a
 * `webapp: 'badge'` message while the browser's flags say the page is an installed app's
 * document in the app's own window – nothing for a plain tab's page (Chrome's resolving no-op),
 * the badge held for the first flags when the page badges before they arrive, the same badge
 * sent once. Hosts without `installAppBadgeShim` on their transport (the phone) install
 * nothing at all.
 */

interface Page {
  sent: PageScriptMessage[]
  /** The event name the script asked the host to run the shim with (undefined: never asked). */
  shimEvent: string | undefined
  flags: (patch: Partial<PageScriptFlags>) => void
  /** The page's world posted a badge (what the shim dispatches). */
  post: (badge: AppBadge | null) => void
  /** ...or something that is not a badge. */
  postRaw: (detail: unknown) => void
}

const count = (value: number): AppBadge => ({ kind: 'count', value })
const FLAG: AppBadge = { kind: 'flag' }

function install(options: { shim?: boolean } = {}): Page {
  const sent: PageScriptMessage[] = []
  const captured: { listener?: (flags: PageScriptFlags) => void; shimEvent?: string } = {}
  installPageScript({
    send: (m) => {
      sent.push(m)
    },
    onFlags: (l) => {
      captured.listener = l
    },
    ...(options.shim === false
      ? {}
      : {
          installAppBadgeShim: (eventName: string) => {
            captured.shimEvent = eventName
          }
        })
  })
  const listener = captured.listener
  if (!listener) throw new Error('the page script did not ask for flags')
  const eventName = captured.shimEvent ?? APP_BADGE_EVENT
  return {
    sent,
    shimEvent: captured.shimEvent,
    flags: (patch) => listener({ ...DEFAULT_PAGE_FLAGS, glanceEnabled: false, ...patch }),
    post: (badge) =>
      document.dispatchEvent(new CustomEvent(eventName, { detail: JSON.stringify({ badge }) })),
    postRaw: (detail) => document.dispatchEvent(new CustomEvent(eventName, { detail }))
  }
}

const badges = (page: Page): Array<AppBadge | null | undefined> =>
  page.sent.filter((m) => m.type === 'webapp' && m.webapp === 'badge').map((m) => m.badge)

describe('the Badging API relay (installAppBadgeRelay)', () => {
  it('asks the host to run the shim in the page’s world on the badge event', () => {
    const page = install()
    expect(page.shimEvent).toBe(APP_BADGE_EVENT)
    expect(APP_BADGE_EVENT).toBe('zen-app-badge')
  })

  it('installs nothing on a host without the shim hook: no message, whatever the flags say', () => {
    const page = install({ shim: false })
    expect(page.shimEvent).toBeUndefined()
    page.flags({ installedApp: true })
    page.post(count(3))
    expect(page.sent).toEqual([])
  })

  it('forwards an installed app’s badges as webapp.badge messages: a count, a flag, a cleared badge', () => {
    const page = install()
    page.flags({ installedApp: true })
    page.post(count(3))
    page.post(FLAG)
    page.post(null)
    expect(page.sent).toEqual([
      { type: 'webapp', webapp: 'badge', badge: count(3) },
      { type: 'webapp', webapp: 'badge', badge: FLAG },
      { type: 'webapp', webapp: 'badge', badge: null }
    ])
  })

  it('sends nothing for a page that is no installed app’s (the calls resolved in the page already)', () => {
    const page = install()
    page.flags({ installedApp: false })
    page.post(count(3))
    page.post(FLAG)
    page.post(null)
    expect(page.sent).toEqual([])
    // Still nothing once the flags come again unchanged: the badges were dropped, not held.
    page.flags({ installedApp: false })
    page.flags({ installedApp: true })
    expect(page.sent).toEqual([])
  })

  it('holds a badge set before the first flags and sends the last one when they say installed app', () => {
    const page = install()
    page.post(count(1))
    page.post(count(2))
    expect(page.sent).toEqual([])
    page.flags({ installedApp: true })
    expect(badges(page)).toEqual([count(2)])
  })

  it('drops a badge set before the first flags when they say the page is no installed app’s', () => {
    const page = install()
    page.post(count(5))
    page.flags({ installedApp: false })
    expect(page.sent).toEqual([])
    // Later flags that make it an installed app's page (the tab moved into the app's window)
    // bring nothing back: the page sets its next badge itself.
    page.flags({ installedApp: true })
    expect(page.sent).toEqual([])
  })

  it('sends the same badge once, and afresh after the page left the app and came back', () => {
    const page = install()
    page.flags({ installedApp: true })
    page.post(count(4))
    page.post(count(4))
    page.post({ kind: 'count', value: 4 })
    expect(badges(page)).toEqual([count(4)])
    page.post(FLAG)
    page.post(FLAG)
    page.post(null)
    page.post(null)
    expect(badges(page)).toEqual([count(4), FLAG, null])
    // Out of the app's window and back: what the browser holds is not known here any more.
    page.flags({ installedApp: false })
    page.post(count(4))
    expect(badges(page)).toEqual([count(4), FLAG, null])
    page.flags({ installedApp: true })
    page.post(null)
    expect(badges(page)).toEqual([count(4), FLAG, null, null])
  })

  it('ignores what is not a badge: a malformed count, a foreign kind, non-JSON, a non-string detail', () => {
    const page = install()
    page.flags({ installedApp: true })
    page.postRaw(JSON.stringify({ badge: { kind: 'count', value: -1 } }))
    page.postRaw(JSON.stringify({ badge: { kind: 'count', value: 1.5 } }))
    page.postRaw(JSON.stringify({ badge: { kind: 'dot' } }))
    page.postRaw(JSON.stringify({ badge: 3 }))
    page.postRaw(JSON.stringify({}))
    page.postRaw(JSON.stringify([]))
    page.postRaw(JSON.stringify('flag'))
    page.postRaw('{not json')
    page.postRaw({ badge: count(2) })
    page.postRaw(undefined)
    expect(page.sent).toEqual([])
    page.post(count(2))
    expect(badges(page)).toEqual([count(2)])
  })
})
