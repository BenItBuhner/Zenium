import { describe, expect, it } from 'vitest'
import type { MenuItemDescriptor, SharePanelRequest } from '@shared/types'
import {
  SHARE_ROW_KEY,
  SHARE_SEAM_BUSY_MS,
  SHARE_SEAM_GUARD_MS,
  SHARE_SEAM_OUT_MS,
  handsOverToSharePanel,
  shareSeamStep,
  type ShareSeam
} from '../shareSeam'

/*
 * The menu-to-panel seam's state machine (v2 draft §9.38's hand-off; `lib/shareSeam.ts`), as
 * data: which row hands its sheet over, and how the seam moves from the Share row's pick through
 * the host's request to the panel's answer – or lets the menu go when the request is not its own.
 */

function row(over: Partial<MenuItemDescriptor> = {}): MenuItemDescriptor {
  return {
    id: 'menu_1_7',
    type: 'normal',
    label: 'Share…',
    enabled: true,
    checked: false,
    submenu: null,
    key: SHARE_ROW_KEY,
    ...over
  }
}

function request(over: Partial<SharePanelRequest> = {}): SharePanelRequest {
  return {
    id: 'share-panel-1',
    kind: 'link',
    title: 'Example Domain',
    url: 'https://example.com/',
    text: null,
    favicon: null,
    image: null,
    tabId: 'tab-1',
    private: false,
    source: 'menu',
    targets: [],
    ...over
  }
}

const gathering: ShareSeam = { phase: 'gathering', menuId: 'menu_1', itemId: 'menu_1_7' }
const hosting: ShareSeam = { phase: 'hosting', menuId: 'menu_1', panelId: 'share-panel-1' }

describe('which row hands its sheet to the share panel', () => {
  it("is the app menu's Share row, on a host whose panel stands in for the system sheet", () => {
    expect(handsOverToSharePanel(row(), { sharePanel: true })).toBe(true)
  })

  it('is no row where the system sheet is the share sheet (Android 14 and later, the desktop): the menu leaves first, as for every pick', () => {
    expect(handsOverToSharePanel(row(), { sharePanel: false })).toBe(false)
    expect(handsOverToSharePanel(row(), null)).toBe(false)
    expect(handsOverToSharePanel(row(), undefined)).toBe(false)
  })

  it('is no other row of the menu, and not a row that opens a submenu', () => {
    expect(
      handsOverToSharePanel(row({ key: 'row.print', label: 'Print…' }), { sharePanel: true })
    ).toBe(false)
    expect(handsOverToSharePanel(row({ key: undefined }), { sharePanel: true })).toBe(false)
    expect(handsOverToSharePanel(row({ submenu: [row({ key: 'x' })] }), { sharePanel: true })).toBe(
      false
    )
  })
})

describe("the seam's steps", () => {
  it("hands the menu's own request over: a request from the menu, arriving while the menu that asked still stands", () => {
    expect(
      shareSeamStep(gathering, { type: 'panel', request: request(), menuId: 'menu_1' })
    ).toEqual({
      seam: hosting,
      effect: 'host'
    })
  })

  it("lets a page's request rise on its own: a `navigator.share` is not the menu's, whatever menu stands", () => {
    const page = request({ source: 'page', id: 'share-panel-9' })
    expect(shareSeamStep(gathering, { type: 'panel', request: page, menuId: 'menu_1' })).toEqual({
      seam: null,
      effect: 'standalone'
    })
    expect(shareSeamStep(null, { type: 'panel', request: page, menuId: null })).toEqual({
      seam: null,
      effect: 'standalone'
    })
  })

  it('lets a request rise on its own when no menu is gathering for it, or another menu stands than the one that asked', () => {
    expect(shareSeamStep(null, { type: 'panel', request: request(), menuId: null })).toEqual({
      seam: null,
      effect: 'standalone'
    })
    expect(shareSeamStep(null, { type: 'panel', request: request(), menuId: 'menu_2' })).toEqual({
      seam: null,
      effect: 'standalone'
    })
    expect(
      shareSeamStep(gathering, { type: 'panel', request: request(), menuId: 'menu_2' })
    ).toEqual({ seam: null, effect: 'standalone' })
    expect(shareSeamStep(gathering, { type: 'panel', request: request(), menuId: null })).toEqual({
      seam: null,
      effect: 'standalone'
    })
  })

  it('does not hand a second request to a sheet already hosting one: the newer share rises on its own', () => {
    expect(
      shareSeamStep(hosting, {
        type: 'panel',
        request: request({ id: 'share-panel-2' }),
        menuId: 'menu_1'
      })
    ).toEqual({ seam: null, effect: 'standalone' })
  })

  it('lets a menu leave that waited for nothing when its guard runs out, and leaves every other seam alone', () => {
    expect(shareSeamStep(gathering, { type: 'guard', menuId: 'menu_1' })).toEqual({
      seam: null,
      effect: 'dismissMenu'
    })
    expect(shareSeamStep(gathering, { type: 'guard', menuId: 'menu_2' })).toEqual({
      seam: gathering,
      effect: 'none'
    })
    expect(shareSeamStep(hosting, { type: 'guard', menuId: 'menu_1' })).toEqual({
      seam: hosting,
      effect: 'none'
    })
    expect(shareSeamStep(null, { type: 'guard', menuId: 'menu_1' })).toEqual({
      seam: null,
      effect: 'none'
    })
  })

  it("closes the menu with the panel it hosts once that panel is answered, and not for any other panel's answer", () => {
    expect(shareSeamStep(hosting, { type: 'answered', panelId: 'share-panel-1' })).toEqual({
      seam: null,
      effect: 'closeMenu'
    })
    expect(shareSeamStep(hosting, { type: 'answered', panelId: 'share-panel-2' })).toEqual({
      seam: hosting,
      effect: 'none'
    })
    expect(shareSeamStep(gathering, { type: 'answered', panelId: 'share-panel-1' })).toEqual({
      seam: gathering,
      effect: 'none'
    })
    expect(shareSeamStep(null, { type: 'answered', panelId: 'share-panel-1' })).toEqual({
      seam: null,
      effect: 'none'
    })
  })

  it('walks the whole hand-off: pick, request, answer', () => {
    let seam: ShareSeam | null = gathering
    const arrived = shareSeamStep(seam, { type: 'panel', request: request(), menuId: 'menu_1' })
    expect(arrived.effect).toBe('host')
    seam = arrived.seam
    // The guard firing late finds nothing to dismiss: the request came.
    expect(shareSeamStep(seam, { type: 'guard', menuId: 'menu_1' }).effect).toBe('none')
    const answered = shareSeamStep(seam, { type: 'answered', panelId: 'share-panel-1' })
    expect(answered).toEqual({ seam: null, effect: 'closeMenu' })
  })

  it("keeps §11's lengths: the rows leave over 120 ms, the tapped row says busy after 150 ms of the gather (§9.30), and a menu waits longer than any gather for a request that does not come", () => {
    expect(SHARE_SEAM_OUT_MS).toBe(120)
    expect(SHARE_SEAM_BUSY_MS).toBe(150)
    expect(SHARE_SEAM_GUARD_MS).toBeGreaterThanOrEqual(2000)
    expect(SHARE_SEAM_BUSY_MS).toBeLessThan(SHARE_SEAM_GUARD_MS)
  })
})
