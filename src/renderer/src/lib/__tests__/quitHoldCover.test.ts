import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../api', () => ({
  cmd: vi.fn(async () => null),
  run: vi.fn(),
  onEvent: vi.fn(() => () => undefined)
}))

import { run } from '../api'
import { closeQuitHoldCover, openQuitHoldCover } from '../quitHoldCover'
import {
  chromeNeedsKeyboard,
  overlayCoversContent,
  pageHidden,
  panelAloneOverContent,
  uiStore
} from '../ui'

/*
 * The page's way under "Hold ⌘Q to quit" when its renderer is hung (lib/quitHoldCover.ts; the
 * design lead's C4 on #486): the chrome's twin of the notice is drawn, but on the desktop the
 * page's view composites above the chrome and a hung renderer keeps its last frame painted
 * there, over the twin – so for the hold the view gives way to its picture, as it does under the
 * "Page unresponsive" prompt, and comes back as the hold is released or ends.
 */

afterEach(() => {
  closeQuitHoldCover()
  vi.mocked(run).mockClear()
  vi.unstubAllGlobals()
})

describe('openQuitHoldCover / closeQuitHoldCover', () => {
  it('hides the hung page behind its picture once the capture is in – no dim, no keyboard asked for – and gives the view back on close', async () => {
    vi.stubGlobal('window', { zen: { invoke: async () => null } })
    expect(uiStore.get().quitHoldCover).toBe(false)
    expect(overlayCoversContent(uiStore.get())).toBe(false)

    await openQuitHoldCover('a')
    expect(uiStore.get().quitHoldCover).toBe(true)
    // The cover hides the view (what `useLayoutReporter` reports as `contentHidden`; the
    // capture stands in) …
    expect(overlayCoversContent(uiStore.get())).toBe(true)
    expect(pageHidden(uiStore.get())).toBe(true)
    // … under a status block with no scrim, as the page-drawn notice has none: not a frame
    // dialog that dims the picture.
    expect(panelAloneOverContent(uiStore.get())).toBe(true)
    // It asks for no keyboard of its own: the core gives the keyboard to the chrome with the hide
    // (the chord's key up is heard there) and back to the page with the show.
    expect(chromeNeedsKeyboard()).toBe(false)
    expect(run).not.toHaveBeenCalledWith('focus.chrome', undefined)

    closeQuitHoldCover()
    expect(uiStore.get().quitHoldCover).toBe(false)
    expect(overlayCoversContent(uiStore.get())).toBe(false)
    expect(pageHidden(uiStore.get())).toBe(false)
    expect(chromeNeedsKeyboard()).toBe(false)
  })

  it('a close overtakes an open still waiting for the picture: the key was released within the wait', async () => {
    vi.stubGlobal('window', { zen: { invoke: async () => null } })
    const opening = openQuitHoldCover('a')
    closeQuitHoldCover()
    await opening
    expect(uiStore.get().quitHoldCover).toBe(false)
    expect(overlayCoversContent(uiStore.get())).toBe(false)
  })
})

/*
 * The chord's release under the cover (the closing items on #486): the keyboard comes to the
 * chrome with the hide, and Chromium drops a key up there while the chrome widget's last
 * browser-handled key down was a consumed shortcut – a short tap quit at 1.5 s with the notice
 * showing (measured). The host is told the cover engaged and puts one key down of the chord into
 * the chrome's widget (`main/platform/quitHoldKeys.ts`), before the layout report that moves the
 * keyboard: once per engagement, never for an open that did not engage.
 */
describe('the host is told the cover engaged', () => {
  it('once per engagement, before the view hides; a second engagement tells it again', async () => {
    const engaged = vi.fn(() => {
      // Heard before the cover stands: the layout report that hides the view follows the store.
      expect(uiStore.get().quitHoldCover).toBe(false)
    })
    vi.stubGlobal('window', { zen: { invoke: async () => null, quitHoldCoverEngaged: engaged } })

    await openQuitHoldCover('a')
    expect(engaged).toHaveBeenCalledTimes(1)
    expect(uiStore.get().quitHoldCover).toBe(true)
    closeQuitHoldCover()
    expect(engaged).toHaveBeenCalledTimes(1)

    await openQuitHoldCover('a')
    expect(engaged).toHaveBeenCalledTimes(2)
    closeQuitHoldCover()
  })

  it('never for an open a close overtook: the cover did not engage, and no key goes into the chrome', async () => {
    const engaged = vi.fn()
    vi.stubGlobal('window', { zen: { invoke: async () => null, quitHoldCoverEngaged: engaged } })
    const opening = openQuitHoldCover('a')
    closeQuitHoldCover()
    await opening
    expect(uiStore.get().quitHoldCover).toBe(false)
    expect(engaged).not.toHaveBeenCalled()
  })

  it('a host without the line (Android’s window.zen) engages the cover all the same', async () => {
    vi.stubGlobal('window', { zen: { invoke: async () => null } })
    await openQuitHoldCover('a')
    expect(uiStore.get().quitHoldCover).toBe(true)
  })
})
