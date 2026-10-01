// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Tab, UIState } from '@shared/types'
import {
  rememberCard,
  rememberThumbnail,
  resetThumbnails,
  trackTabs
} from '@renderer/lib/thumbnails'
import { TabPreview } from '../TabPreview'

vi.mock('@renderer/lib/api', () => ({
  cmd: vi.fn(),
  run: vi.fn(),
  onEvent: vi.fn(() => () => undefined)
}))

/*
 * The Settings tab's card (`TabPreview`): the host's picture of the page when there is one –
 * the section or the drill-in page the tab is on, as the Android host copies it
 * (`chrome.snapshot`) – and until then the page drawn as its address names it, never the landing
 * for a tab that is not on it. Before, every chrome page's card was the landing's drawing,
 * whatever the tab's address and whatever picture the host had.
 */

function tab(url: string): Tab {
  return {
    id: 'settings-tab',
    spaceId: 'space',
    containerId: 'default',
    url,
    title: 'Settings',
    favicon: null,
    pinned: false,
    essential: false,
    pinnedUrl: null,
    customTitle: null,
    customIcon: null,
    windowId: null,
    folderId: null,
    loading: false,
    canGoBack: true,
    canGoForward: false,
    audible: false,
    muted: false,
    discarded: false,
    frozen: false,
    cpuThrottle: 1,
    zoom: 1,
    splitGroupId: null,
    createdAt: 0,
    lastActiveAt: 0,
    errorCode: null,
    bookmarked: false,
    readerable: false,
    blockedCount: 0
  } as Tab
}

function card(t: Tab, cover = false): string {
  return renderToStaticMarkup(createElement(TabPreview, { tab: t, cover }))
}

const PICTURE = 'data:image/jpeg;base64,c2l0ZS1kYXRh'

beforeEach(() => {
  resetThumbnails()
})

describe("the Settings tab's card", () => {
  it('draws the drill-in the tab is on while the host has no picture of the page', () => {
    const updates = card(tab('zen://settings/updates'))
    expect(updates).toContain('data-route="drill-in"')
    expect(updates).toContain('Updates')
    expect(updates).not.toContain('Find in Settings')
    const siteData = card(tab('zen://settings/privacy/site-data'))
    expect(siteData).toContain('data-route="drill-in"')
    expect(siteData).toContain('Site data')
    expect(siteData).not.toContain('<img')
  })

  it('draws the landing for a tab on the landing', () => {
    const landing = card(tab('zen://settings'))
    expect(landing).toContain('data-route="landing"')
    expect(landing).toContain('Find in Settings')
  })

  it("shows the host's picture of the page once there is one, as a page's card does", () => {
    const t = tab('zen://settings/privacy/site-data')
    trackTabs({ platform: 'android', tabs: { [t.id]: t } } as unknown as UIState)
    rememberCard(t.id, { data: PICTURE, width: 344, height: 704 })
    const markup = card(t)
    expect(markup).toContain('<img')
    expect(markup).toContain(`src="${PICTURE}"`)
    expect(markup).not.toContain('zen-settings-preview')
  })

  it('shows the cover the chrome captured as the overview opened, standing in for the live page', () => {
    const t = tab('zen://settings/updates')
    rememberThumbnail(t.id, PICTURE)
    const markup = card(t, true)
    expect(markup).toContain(`src="${PICTURE}"`)
    expect(markup).not.toContain('zen-settings-preview')
  })
})
