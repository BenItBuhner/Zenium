import { describe, expect, it } from 'vitest'
import type { TabViewEvents } from '@core/platform'
import { createTabRecord } from '@core/model'
import type { Tab } from '@shared/types'
import { BLANK_URL, NEW_TAB_URL } from '@shared/url'
import type { Bridge } from '../bridge'
import { AndroidPlatform } from '../platform'

/*
 * NTP-35 (#563, mitigation (1)'s third half): the core tags the `view.create` of a tab on the
 * served new tab page – `newTabPage: true` – and nothing else about the message changes. What
 * the tag means is the host's: on the tablet chassis `Host.kt` admits the tab to the boot hold,
 * so the view's creation, its document's load and its placement all wait for the FULLY DRAWN
 * frame (`BootPlacementHold`); the phone's host reads the tag and holds nothing – and the phone's
 * core never makes a `zen://newtab` tab in the first place, its new tab being the chrome-drawn
 * page over `zen://blank` (`platform.ts` `newTabPage: largeScreen`). A tab on any other URL – a
 * restored page's, the blank tab's, a chrome page's – is created exactly as before: no key.
 */

interface Sent {
  method: string
  args: unknown
}

function recordingBridge(): { bridge: Bridge; sent: Sent[] } {
  const sent: Sent[] = []
  const bridge = {
    call: async (method: string, args: unknown) => {
      sent.push({ method, args })
      return null
    },
    send: (method: string, args: unknown) => {
      sent.push({ method, args })
    },
    callSync: () => undefined
  } as unknown as Bridge
  return { bridge, sent }
}

function silentEvents(): TabViewEvents {
  return new Proxy({} as TabViewEvents, { get: () => (): undefined => undefined })
}

function platformOn(bridge: Bridge): AndroidPlatform {
  return new AndroidPlatform(bridge, {
    version: '0.0.0-test',
    sdkInt: 34,
    signer: null,
    packageName: null,
    files: {},
    downloadsDir: '/sdcard/Download',
    insets: { top: 0, right: 0, bottom: 0, left: 0 },
    fullscreen: false
  })
}

const tabOf = (id: string, url: string): Tab =>
  createTabRecord({ id, spaceId: 'space_1', containerId: 'default', url })

/** The `view.create` messages the platform sent, in order. */
function creates(sent: Sent[]): unknown[] {
  return sent.filter((s) => s.method === 'view.create').map((s) => s.args)
}

describe("the boot's served tab: `view.create` carries the new tab page tag (NTP-35)", () => {
  it('a tab on the served page is created with the tag, the message otherwise the one it was', () => {
    const { bridge, sent } = recordingBridge()
    platformOn(bridge).views.createView(tabOf('tab_ntp', NEW_TAB_URL), silentEvents())
    expect(creates(sent)).toEqual([{ tabId: 'tab_ntp', containerId: 'default', newTabPage: true }])
  })

  it("the page's other spellings – a trailing slash, a query – carry it too, as the arm reads them", () => {
    for (const url of [`${NEW_TAB_URL}/`, `${NEW_TAB_URL}?private=1`]) {
      const { bridge, sent } = recordingBridge()
      platformOn(bridge).views.createView(tabOf('tab_ntp', url), silentEvents())
      expect(creates(sent)).toEqual([
        { tabId: 'tab_ntp', containerId: 'default', newTabPage: true }
      ])
    }
  })

  it('a tab on anything else carries no key at all: a restored page, the blank tab, a chrome page', () => {
    for (const url of ['https://open.example/', BLANK_URL, 'zen://settings', 'zen://newtabs']) {
      const { bridge, sent } = recordingBridge()
      platformOn(bridge).views.createView(tabOf('tab_1', url), silentEvents())
      const [create] = creates(sent)
      expect(create).toEqual({ tabId: 'tab_1', containerId: 'default' })
      expect(Object.keys(create as object)).toEqual(['tabId', 'containerId'])
    }
  })

  it("the tag rides the container too: a private window's served page is tagged in its container", () => {
    const { bridge, sent } = recordingBridge()
    const tab = createTabRecord({
      id: 'tab_p',
      spaceId: 'space_1',
      containerId: 'private',
      url: NEW_TAB_URL
    })
    platformOn(bridge).views.createView(tab, silentEvents())
    expect(creates(sent)).toEqual([{ tabId: 'tab_p', containerId: 'private', newTabPage: true }])
  })
})
