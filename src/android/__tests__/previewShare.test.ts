import { describe, expect, it } from 'vitest'
import { awaitedPanelAnswer, previewShareRequest } from '../previewShare'
import type { Tab } from '@shared/types'

/*
 * SH-03's page route in the stand-in host: a page's `navigator.share` staged as the panel's
 * `page` share (`share=page-*`), shaped as `Share.kt` shapes one, and the answer a page's
 * awaited share hears for the panel's action, as `Share.awaitedPanelAnswer` gives it.
 */

const tab = {
  id: 'tab-1',
  title: 'Example Domain',
  url: 'https://example.com/',
  favicon: 'data:image/png;base64,FAVICON'
} as unknown as Tab

describe("a page's share staged for the panel", () => {
  it("shares a link with its title as the host's `link` kind, from the page, with the tab's favicon", () => {
    const request = previewShareRequest('page-link', tab, false)
    expect(request).toMatchObject({
      source: 'page',
      kind: 'link',
      title: 'How the tides work',
      url: 'https://sample.example/how-the-tides-work',
      text: null,
      favicon: 'data:image/png;base64,FAVICON',
      image: null,
      tabId: 'tab-1',
      private: false
    })
    expect(request.targets.length).toBeGreaterThan(0)
  })

  it("shares text alone as the host's `text` kind with no title and no link", () => {
    const request = previewShareRequest('page-text', tab, false)
    expect(request).toMatchObject({ source: 'page', kind: 'text', title: null, url: null })
    expect(request.text).toMatch(/moon/)
  })

  it("shares text with a link as `text`, the title kept for the sheet's subject line", () => {
    const request = previewShareRequest('page-text-link', tab, true)
    expect(request).toMatchObject({
      source: 'page',
      kind: 'text',
      title: 'How the tides work',
      url: 'https://sample.example/how-the-tides-work',
      private: true
    })
    expect(request.text).toMatch(/moon/)
  })

  it('stands without a tab: no id, no favicon', () => {
    const request = previewShareRequest('page-link', null, false)
    expect(request.tabId).toBeNull()
    expect(request.favicon).toBeNull()
  })

  it("keeps the menu's shares as the menu's", () => {
    expect(previewShareRequest('link', tab, false).source).toBe('menu')
    expect(previewShareRequest('text', tab, false).source).toBe('menu')
    expect(previewShareRequest('image', tab, false).source).toBe('menu')
  })
})

describe("what a page's awaited share hears for the panel's action", () => {
  it('hears `shared` for an app that took the share, `aborted` for one that would not start', () => {
    expect(awaitedPanelAnswer('target')).toBe('shared')
    expect(awaitedPanelAnswer('target', false)).toBe('aborted')
  })

  it("hears `shared` for the browser's own chips, QR code and Copy image (Chrome's first-party tap)", () => {
    expect(awaitedPanelAnswer('chip')).toBe('shared')
    expect(awaitedPanelAnswer('qr')).toBe('shared')
    expect(awaitedPanelAnswer('copyImage')).toBe('shared')
  })

  it("hears nothing for More – the system sheet's word is the answer", () => {
    expect(awaitedPanelAnswer('more')).toBeNull()
  })

  it('hears `aborted` for a dismissal', () => {
    expect(awaitedPanelAnswer('dismiss')).toBe('aborted')
  })
})
