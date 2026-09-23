import { describe, expect, it, vi } from 'vitest'
import type { Browser } from '@core/browser'
import type { ZenWindow } from '@core/window'
import type { Bridge } from '../bridge'
import { AndroidPlatform, type BootInfo } from '../platform'

const BOOT: BootInfo = {
  version: '0.0.0-test',
  sdkInt: 34,
  signer: null,
  packageName: null,
  files: {},
  downloadsDir: '/sdcard/Download',
  insets: { top: 0, right: 0, bottom: 0, left: 0 },
  fullscreen: false
}

const bridge = {
  call: async () => null,
  callSync: () => null,
  send: () => undefined
} as unknown as Bridge

/**
 * A platform with a window, a browser whose active tab has a view, and the chrome's event sink.
 * `view` records the landings the host event asked of it; `focusContent` the plain focus a page
 * without a document gets instead.
 */
function platformWithView(hasDocument = true): {
  platform: AndroidPlatform
  view: { focusEdge: ReturnType<typeof vi.fn> }
  focusContent: ReturnType<typeof vi.fn>
  sent: ReturnType<typeof vi.fn>
} {
  const platform = new AndroidPlatform(bridge, BOOT)
  const focusContent = vi.fn()
  const win = { id: 1, focusContent } as unknown as ZenWindow
  ;(platform as unknown as { zenWindow: ZenWindow }).zenWindow = win
  const view = { focusEdge: vi.fn(), hasDocument: () => hasDocument }
  const browser = {
    emit: vi.fn(),
    handleCommand: vi.fn(),
    tabs: {
      activeTabFor: (w: ZenWindow) => (w === win ? { id: 'tab_1' } : undefined),
      view: (id: string) => (id === 'tab_1' ? view : undefined)
    }
  }
  platform.bind(browser as unknown as Browser)
  const sent = vi.fn()
  ;(platform as unknown as { events: { send: typeof sent } }).events = { send: sent }
  return { platform, view, focusContent, sent }
}

/**
 * Page-to-chrome Tab traversal for a hardware keyboard (A11Y-09's remainder): Kotlin's
 * `FocusHandoff` reports a Tab that ran past a page's end as `focus.fromPage` – the chrome
 * lands its focus (`lib/panes.ts` hears the event) – and one past the chrome's end as
 * `focus.toPage`, which the active page's view takes at the edge the Tab came in at.
 */
describe('the focus.fromPage and focus.toPage host events', () => {
  it('hands a Tab out of the page to the chrome as an event with its direction', () => {
    const { platform, sent } = platformWithView()
    platform.hostEvent('focus.fromPage', { direction: 'forward' })
    platform.hostEvent('focus.fromPage', { direction: 'backward' })
    expect(sent.mock.calls).toEqual([
      ['focus.fromPage', { direction: 'forward' }],
      ['focus.fromPage', { direction: 'backward' }]
    ])
  })

  it('lands a Tab out of the chrome on the active page’s first tabbable, a Shift+Tab on its last', () => {
    const { platform, view, focusContent } = platformWithView()
    platform.hostEvent('focus.toPage', { direction: 'forward' })
    platform.hostEvent('focus.toPage', { direction: 'backward' })
    expect(view.focusEdge.mock.calls).toEqual([['first'], ['last']])
    expect(focusContent).not.toHaveBeenCalled()
  })

  it('gives a page with no document yet the keyboard plainly: there is nothing to land on', () => {
    const { platform, view, focusContent } = platformWithView(false)
    platform.hostEvent('focus.toPage', { direction: 'forward' })
    expect(view.focusEdge).not.toHaveBeenCalled()
    expect(focusContent).toHaveBeenCalledTimes(1)
  })

  it('does nothing for a direction that is neither', () => {
    const { platform, view, focusContent, sent } = platformWithView()
    platform.hostEvent('focus.fromPage', { direction: 'sideways' } as never)
    platform.hostEvent('focus.fromPage', null as never)
    platform.hostEvent('focus.toPage', {} as never)
    expect(sent).not.toHaveBeenCalled()
    expect(view.focusEdge).not.toHaveBeenCalled()
    expect(focusContent).not.toHaveBeenCalled()
  })
})
