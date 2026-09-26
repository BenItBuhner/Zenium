import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SharePanelRequest } from '@shared/types'
import { COVERED_TIMEOUT_MS, onLayoutApplied, onViewDrawn, pageViewStore } from '../pageView'
import {
  SHARE_PANEL_MORE,
  afterPageShown,
  displayedLink,
  sharePanelChips,
  sharePanelCopy,
  sharePanelPreview
} from '../sharePanel'

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
    source: 'menu',
    targets: [
      { component: 'com.example.a/.Share', label: 'Alpha', icon: 'data:image/webp;base64,AAAA' },
      { component: 'com.example.b/.Share', label: 'Beta', icon: 'data:image/webp;base64,BBBB' }
    ],
    ...over
  }
}

const kinds = (r: SharePanelRequest): string[] => sharePanelChips(r).map((c) => c.kind)
const labels = (r: SharePanelRequest): string[] => sharePanelChips(r).map((c) => c.label)

describe("the share panel's chips (the Android 14 action row's, less Send to your devices; §9.38)", () => {
  it("gives a page's share Copy link, QR code, Long screenshot and Print, in the action row's order", () => {
    expect(kinds(request())).toEqual(['copy', 'qr', 'screenshot', 'print'])
    expect(labels(request())).toEqual(['Copy link', 'QR code', 'Long screenshot', 'Print'])
  })

  it('has every chip carry a glyph', () => {
    for (const chip of sharePanelChips(request())) expect(chip.icon).toBeTypeOf('object')
    expect(SHARE_PANEL_MORE.icon).toBeTypeOf('object')
    expect(SHARE_PANEL_MORE.label).toBe('More')
  })

  it('leaves out Long screenshot and Print for a share with no tab behind it (a link held in a page)', () => {
    expect(kinds(request({ tabId: null }))).toEqual(['copy', 'qr'])
  })

  it("draws every chip for a private tab's share, QR code with them: private governs what is recorded, not what is shown", () => {
    expect(kinds(request({ private: true }))).toEqual(kinds(request()))
    expect(labels(request({ private: true }))).toEqual([
      'Copy link',
      'QR code',
      'Long screenshot',
      'Print'
    ])
  })

  it("gives a selection's text Copy text and Long screenshot: the quote's page is its picture; no link to draw, no page to print", () => {
    const selection = request({ kind: 'text', text: 'a passage', url: null, title: null })
    expect(labels(selection)).toEqual(['Copy text', 'Long screenshot'])
    // A selection that came with the page's link still copies its text, and draws no code for it.
    expect(labels(request({ kind: 'text', text: 'a passage' }))).toEqual([
      'Copy text',
      'Long screenshot'
    ])
    expect(kinds(request({ kind: 'text', text: 'a passage', tabId: null }))).toEqual(['copy'])
  })

  it("gives an image Copy image alone: the subject is the picture, and Long screenshot, Print and QR code are the page's", () => {
    const image = request({
      kind: 'image',
      url: null,
      title: null,
      favicon: null,
      image: 'data:image/webp;base64,IMG'
    })
    expect(labels(image)).toEqual(['Copy image'])
    expect(kinds({ ...image, tabId: null })).toEqual(['copy'])
    // Neither a link that came along nor a private tab changes the picture's one chip.
    expect(kinds({ ...image, url: 'https://example.com/picture.png' })).toEqual(['copy'])
    expect(kinds({ ...image, private: true })).toEqual(['copy'])
  })
})

/**
 * A page's `navigator.share` as the host brings it to the panel below Android 14 (`Share.kt`:
 * text present → a `text` share, else a `link`; `source: 'page'`; the favicon the sharing tab's).
 */
const page = (over: Partial<SharePanelRequest> = {}): SharePanelRequest =>
  request({ id: 'share-panel-5', source: 'page', ...over })

describe("a page's navigator.share payload (SH-03's follow-up: the panel route below Android 14)", () => {
  it('gives a link alone Copy link and QR code – the payload is a link, not the page, so no Long screenshot and no Print', () => {
    expect(labels(page())).toEqual(['Copy link', 'QR code'])
    expect(labels(page({ title: null }))).toEqual(['Copy link', 'QR code'])
    // The tab behind it changes nothing: those two chips picture and print the page, which is not what the page handed over.
    expect(kinds(page({ tabId: null }))).toEqual(['copy', 'qr'])
  })

  it("gives text alone Copy text and nothing else: no link to draw, and the page's Long screenshot is withheld for a payload (the gate's (b))", () => {
    const text = page({ kind: 'text', text: 'a message', url: null, title: null })
    expect(labels(text)).toEqual(['Copy text'])
    expect(labels({ ...text, title: 'A title' })).toEqual(['Copy text'])
  })

  it("gives text with a link Copy – the two together, as the share goes out – and QR code for the link (Chrome's LINK_AND_TEXT)", () => {
    const pair = page({ kind: 'text', text: 'a message', title: 'A title' })
    expect(labels(pair)).toEqual(['Copy', 'QR code'])
    expect(labels({ ...pair, title: null })).toEqual(['Copy', 'QR code'])
  })

  it('previews a link as its title over its link – the link once, when the payload had no title', () => {
    expect(sharePanelPreview(page())).toEqual({
      title: 'Example Domain',
      detail: 'https://example.com/'
    })
    expect(sharePanelPreview(page({ title: null }))).toEqual({
      title: 'https://example.com/',
      detail: ''
    })
  })

  it("previews text first, the link beneath, the payload's title unshown (Chrome's TEXT and LINK_AND_TEXT previews); text alone on its own", () => {
    expect(sharePanelPreview(page({ kind: 'text', text: 'a message', title: 'A title' }))).toEqual({
      title: 'a message',
      detail: 'https://example.com/'
    })
    expect(
      sharePanelPreview(page({ kind: 'text', text: 'a message', title: 'A title', url: null }))
    ).toEqual({ title: 'a message', detail: '' })
  })

  it('copies what Copy says: the link, the text, or the text and the link on its own line, said as Copied', () => {
    expect(sharePanelCopy(page())).toEqual({
      text: 'https://example.com/',
      confirmation: 'Link copied'
    })
    expect(sharePanelCopy(page({ kind: 'text', text: 'a message', url: null }))).toEqual({
      text: 'a message',
      confirmation: 'Text copied'
    })
    expect(sharePanelCopy(page({ kind: 'text', text: 'a message' }))).toEqual({
      text: 'a message\nhttps://example.com/',
      confirmation: 'Copied'
    })
  })

  it("draws a private tab's page share the same, QR code included", () => {
    expect(labels(page({ private: true }))).toEqual(labels(page()))
    expect(labels(page({ kind: 'text', text: 'a message', private: true }))).toEqual([
      'Copy',
      'QR code'
    ])
  })

  it("leaves the menu's own shares as they were: a page's four chips, a selection's two, an image's one", () => {
    expect(kinds(request())).toEqual(['copy', 'qr', 'screenshot', 'print'])
    expect(kinds(request({ kind: 'text', text: 'a passage' }))).toEqual(['copy', 'screenshot'])
    expect(sharePanelCopy(request({ kind: 'text', text: 'a passage' }))).toEqual({
      text: 'a passage',
      confirmation: 'Text copied'
    })
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

  it("leads with a selection's text and puts the page's link beneath without the highlight's `#:~:text=` fragment, as the host sends the two (no title, no favicon)", () => {
    const highlight = 'https://example.com/#:~:text=a%20passage'
    expect(
      sharePanelPreview(
        request({ kind: 'text', text: 'a passage', url: highlight, title: null, favicon: null })
      )
    ).toEqual({ title: 'a passage', detail: 'https://example.com/' })
    // A title that came along anyway (a host's own share) does not displace the text.
    expect(sharePanelPreview(request({ kind: 'text', text: 'a passage', url: highlight }))).toEqual(
      { title: 'a passage', detail: 'https://example.com/' }
    )
  })

  it('shows a link without its text-fragment directive and nothing else changed: the directive says how, not where, and the share keeps it', () => {
    expect(displayedLink('https://example.com/#:~:text=a%20passage')).toBe('https://example.com/')
    expect(displayedLink('https://example.com/a/page?q=1#:~:text=start,end&text=more')).toBe(
      'https://example.com/a/page?q=1'
    )
    // A plain fragment before the directive is where, and stays.
    expect(displayedLink('https://example.com/doc#section-2:~:text=a%20passage')).toBe(
      'https://example.com/doc#section-2'
    )
    // Nothing to drop: the link as it is, `:~:` outside the fragment included.
    expect(displayedLink('https://example.com/doc#section-2')).toBe(
      'https://example.com/doc#section-2'
    )
    expect(displayedLink('https://example.com/')).toBe('https://example.com/')
    expect(displayedLink('https://example.com/a:~:b')).toBe('https://example.com/a:~:b')
    // The copy of a selection is its text, and a page's Copy link is the page's whole link: neither reads the displayed line.
    expect(sharePanelCopy(request({ url: 'https://example.com/#:~:text=x' }))).toEqual({
      text: 'https://example.com/#:~:text=x',
      confirmation: 'Link copied'
    })
  })

  it("shows a selection's text alone when the page gave no link to the highlight (not a web page)", () => {
    expect(
      sharePanelPreview(request({ kind: 'text', text: 'a passage', url: null, title: null }))
    ).toEqual({ title: 'a passage', detail: '' })
  })

  it('names a picture that came without one "Image", with nothing under it (the host sends no link for an image)', () => {
    expect(
      sharePanelPreview(
        request({ kind: 'image', title: null, url: null, image: 'data:image/webp;base64,IMG' })
      )
    ).toEqual({ title: 'Image', detail: '' })
    expect(
      sharePanelPreview(
        request({
          kind: 'image',
          title: 'A picture',
          url: null,
          image: 'data:image/webp;base64,IMG'
        })
      )
    ).toEqual({ title: 'A picture', detail: '' })
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

describe("Long screenshot's wait for the page view (afterPageShown)", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    pageViewStore.set({ phases: new Map(), lastApplied: null })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('runs at once for a page the host never took down', () => {
    const then = vi.fn()
    afterPageShown('tab-1', then)
    expect(then).toHaveBeenCalledTimes(1)
  })

  it("holds while the page view is under the sheet's cover, and runs once the host has drawn the page back", () => {
    onLayoutApplied({ contentHidden: true, hid: ['tab-1'], shown: [] })
    onViewDrawn('tab-1', false)
    const then = vi.fn()
    afterPageShown('tab-1', then)
    expect(then).not.toHaveBeenCalled()
    // The sheet unmounts, the chrome's layout brings the view back: it is on its way, not yet drawn.
    onLayoutApplied({ contentHidden: false, hid: [], shown: ['tab-1'] })
    expect(then).not.toHaveBeenCalled()
    onViewDrawn('tab-1', true)
    expect(then).toHaveBeenCalledTimes(1)
    // Nothing later runs it again.
    onLayoutApplied({ contentHidden: true, hid: ['tab-1'], shown: [] })
    onViewDrawn('tab-1', true)
    expect(then).toHaveBeenCalledTimes(1)
  })

  it("another tab's page coming back is not this one's", () => {
    onLayoutApplied({ contentHidden: true, hid: ['tab-1', 'tab-2'], shown: [] })
    onViewDrawn('tab-1', false)
    onViewDrawn('tab-2', false)
    const then = vi.fn()
    afterPageShown('tab-1', then)
    onLayoutApplied({ contentHidden: false, hid: [], shown: ['tab-2'] })
    onViewDrawn('tab-2', true)
    expect(then).not.toHaveBeenCalled()
  })

  it('gives up waiting after COVERED_TIMEOUT_MS and asks regardless, once', () => {
    onLayoutApplied({ contentHidden: true, hid: ['tab-1'], shown: [] })
    onViewDrawn('tab-1', false)
    const then = vi.fn()
    afterPageShown('tab-1', then)
    vi.advanceTimersByTime(COVERED_TIMEOUT_MS - 1)
    expect(then).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(then).toHaveBeenCalledTimes(1)
    onLayoutApplied({ contentHidden: false, hid: [], shown: ['tab-1'] })
    onViewDrawn('tab-1', true)
    expect(then).toHaveBeenCalledTimes(1)
  })
})
