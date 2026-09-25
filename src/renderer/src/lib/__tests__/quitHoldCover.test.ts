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
