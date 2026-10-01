import { describe, expect, it } from 'vitest'
import { chromeSnapshotFrom } from '../platform'

/*
 * Kotlin's answer to `chrome.snapshot` – the copy of the window where a Settings tab's page is,
 * and the card picture scaled from it (`ChromePageSnapshot.kt`) – as the core's `ChromeSnapshot`
 * (`AndroidWindowHost.snapshotChrome`): the cover is required, the card may be null (the host's
 * last picture of the tab is a moment old and stands), and anything malformed is no picture.
 */

const COVER = 'data:image/jpeg;base64,Y292ZXI='
const CARD = { data: 'data:image/jpeg;base64,Y2FyZA==', width: 344, height: 704 }

describe("the host's chrome snapshot", () => {
  it('carries the cover and the card picture', () => {
    expect(chromeSnapshotFrom({ cover: COVER, card: CARD })).toEqual({ cover: COVER, card: CARD })
  })

  it('carries the cover alone when the card picture a moment old still stands', () => {
    expect(chromeSnapshotFrom({ cover: COVER, card: null })).toEqual({ cover: COVER, card: null })
    expect(chromeSnapshotFrom({ cover: COVER })).toEqual({ cover: COVER, card: null })
  })

  it('is no picture without a cover', () => {
    expect(chromeSnapshotFrom(null)).toBeNull()
    expect(chromeSnapshotFrom(undefined)).toBeNull()
    expect(chromeSnapshotFrom({})).toBeNull()
    expect(chromeSnapshotFrom({ cover: '', card: CARD })).toBeNull()
    expect(chromeSnapshotFrom('data:image/jpeg;base64,Y292ZXI=')).toBeNull()
  })

  it('drops a card picture that is not one', () => {
    expect(
      chromeSnapshotFrom({ cover: COVER, card: { data: '', width: 1, height: 1 } })?.card
    ).toBeNull()
    expect(
      chromeSnapshotFrom({ cover: COVER, card: { data: 'd', width: 0, height: 1 } })?.card
    ).toBeNull()
    expect(
      chromeSnapshotFrom({ cover: COVER, card: { data: 'd', width: '3', height: 1 } })?.card
    ).toBeNull()
    expect(chromeSnapshotFrom({ cover: COVER, card: 'picture' })?.card).toBeNull()
  })
})
