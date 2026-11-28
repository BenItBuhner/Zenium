import { describe, expect, it } from 'vitest'
import type { UIState } from '@shared/types'
import { nativeCaption, ownCaption } from '../caption'

function state(overlay: boolean, chrome: UIState['window']['chrome']): UIState {
  return {
    capabilities: { windowControls: true, windowControlsOverlay: overlay },
    window: { chrome }
  } as unknown as UIState
}

describe('caption buttons on Windows', () => {
  it('draws its own buttons in a browser window, so no band is kept for the OS', () => {
    expect(ownCaption(state(true, 'full'))).toBe(true)
    expect(nativeCaption(state(true, 'full'))).toBe(false)
  })

  it('keeps the OS buttons (and Snap Layouts) on popups and app windows', () => {
    for (const chrome of ['popup', 'app'] as const) {
      expect(nativeCaption(state(true, chrome))).toBe(true)
      expect(ownCaption(state(true, chrome))).toBe(false)
    }
  })

  it('leaves hosts without the overlay alone', () => {
    expect(nativeCaption(state(false, 'full'))).toBe(false)
    expect(ownCaption(state(false, 'full'))).toBe(false)
  })
})
