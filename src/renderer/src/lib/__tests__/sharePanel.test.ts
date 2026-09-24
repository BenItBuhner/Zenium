import { describe, expect, it } from 'vitest'
import type { SharePanelRequest } from '@shared/types'
import { SHARE_PANEL_MORE, sharePanelChips, sharePanelCopy, sharePanelPreview } from '../sharePanel'

/** A request as the host sends one (`Share.kt`), with what a test names changed. */
function request(over: Partial<SharePanelRequest> = {}): SharePanelRequest {
  return {
    id: 'share-panel-1',
    kind: 'link',
    title: 'Example Domain',
    url: 'https://example.com/',
    text: null,
    favicon: 'data:image/png;base64,AAAA',
    image: null,
    tabId: 'tab-1',
    private: false,
    targets: [
      { component: 'com.example.a/.Share', label: 'Alpha', icon: 'data:image/webp;base64,AAAA' },
      { component: 'com.example.b/.Share', label: 'Beta', icon: 'data:image/webp;base64,BBBB' }
    ],
    ...over
  }
}

const kinds = (r: SharePanelRequest): string[] => sharePanelChips(r).map((c) => c.kind)
const labels = (r: SharePanelRequest): string[] => sharePanelChips(r).map((c) => c.label)

describe("the share panel's chips (Chrome 152's first-party row, less Send to your devices)", () => {
  it("gives a page's share Copy link, Long screenshot, Print and QR code, in Chrome's order", () => {
    expect(kinds(request())).toEqual(['copy', 'screenshot', 'print', 'qr'])
    expect(labels(request())).toEqual(['Copy link', 'Long screenshot', 'Print', 'QR code'])
  })

  it('has every chip carry a glyph', () => {
    for (const chip of sharePanelChips(request())) expect(chip.icon).toBeTypeOf('object')
    expect(SHARE_PANEL_MORE.icon).toBeTypeOf('object')
    expect(SHARE_PANEL_MORE.label).toBe('More')
  })

  it('leaves out Long screenshot and Print for a share with no tab behind it (a link held in a page)', () => {
    expect(kinds(request({ tabId: null }))).toEqual(['copy', 'qr'])
  })

  it("hides QR code for a private tab's share, as Chrome does in incognito; the rest stays", () => {
    expect(kinds(request({ private: true }))).toEqual(['copy', 'screenshot', 'print'])
  })

  it("gives a selection's text Copy text and Long screenshot: no page to print, no link to draw", () => {
    const selection = request({ kind: 'text', text: 'a passage', url: null, title: null })
    expect(labels(selection)).toEqual(['Copy text', 'Long screenshot'])
    // A selection that came with the page's link still copies its text, and draws no code for it.
    expect(labels(request({ kind: 'text', text: 'a passage' }))).toEqual([
      'Copy text',
      'Long screenshot'
    ])
  })

  it('gives an image Copy image and Long screenshot', () => {
    const image = request({
      kind: 'image',
      url: null,
      title: null,
      favicon: null,
      image: 'data:image/webp;base64,IMG'
    })
    expect(labels(image)).toEqual(['Copy image', 'Long screenshot'])
    expect(kinds({ ...image, tabId: null })).toEqual(['copy'])
  })
})

describe("the share panel's preview", () => {
  it('puts the title over the link', () => {
    expect(sharePanelPreview(request())).toEqual({
      title: 'Example Domain',
      detail: 'https://example.com/'
    })
  })

  it('shows a link without a title once, on the first line', () => {
    expect(sharePanelPreview(request({ title: null }))).toEqual({
      title: 'https://example.com/',
      detail: ''
    })
  })

  it("puts a selection's text under its title, or on the first line when there is none", () => {
    expect(sharePanelPreview(request({ kind: 'text', text: 'a passage', url: null }))).toEqual({
      title: 'Example Domain',
      detail: 'a passage'
    })
    expect(
      sharePanelPreview(request({ kind: 'text', text: 'a passage', url: null, title: null }))
    ).toEqual({ title: 'a passage', detail: '' })
  })

  it('names a picture that came without one "Image"', () => {
    expect(
      sharePanelPreview(
        request({ kind: 'image', title: null, url: null, image: 'data:image/webp;base64,IMG' })
      )
    ).toEqual({ title: 'Image', detail: '' })
  })
})

describe('what Copy puts on the clipboard', () => {
  it("is the link for a page's share, said as Link copied", () => {
    expect(sharePanelCopy(request())).toEqual({
      text: 'https://example.com/',
      confirmation: 'Link copied'
    })
  })

  it("is the text for a selection's share, said as Text copied", () => {
    expect(sharePanelCopy(request({ kind: 'text', text: 'a passage' }))).toEqual({
      text: 'a passage',
      confirmation: 'Text copied'
    })
  })

  it('is nothing when the share carries nothing to copy', () => {
    expect(sharePanelCopy(request({ url: null }))).toBeNull()
    expect(sharePanelCopy(request({ kind: 'text', text: null }))).toBeNull()
  })
})
