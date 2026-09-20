import { describe, expect, it } from 'vitest'
import { liveWebContents } from '../popupContents'

// A popup document that closes itself (`window.close()`) leaves `WebContentsView.webContents`
// undefined by the time the view's `destroyed` handler runs `closePopup`; the handle taken at
// creation still answers `isDestroyed()`. The readers of the popup's contents go through this.
describe('liveWebContents', () => {
  it('returns the handle while the document is alive', () => {
    const wc = { isDestroyed: () => false, close: () => undefined }
    expect(liveWebContents(wc)).toBe(wc)
  })

  it('returns null for a destroyed handle, so nothing is asked of it', () => {
    let closed = 0
    const wc = {
      isDestroyed: () => true,
      close: () => {
        closed += 1
      }
    }
    liveWebContents(wc)?.close()
    expect(liveWebContents(wc)).toBeNull()
    expect(closed).toBe(0)
  })

  it('returns null when the view no longer reads a webContents at all', () => {
    expect(liveWebContents(undefined)).toBeNull()
    expect(liveWebContents(null)).toBeNull()
  })
})
