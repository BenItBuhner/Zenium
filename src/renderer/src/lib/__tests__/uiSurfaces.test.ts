import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../api', () => ({
  cmd: vi.fn(async () => null),
  run: vi.fn(),
  onEvent: vi.fn(() => () => undefined)
}))

import type { WebAppInstallPrompt } from '@shared/types'
import { cmd, run } from '../api'
import {
  chromeNeedsKeyboard,
  closeClearBrowsingData,
  closeMediaSheet,
  openClearBrowsingData,
  openInstallSheet,
  openMediaSheet,
  overlayCoversContent,
  panelAloneOverContent,
  uiStore,
  type UiState
} from '../ui'

const idle = (): UiState => uiStore.get()

afterEach(() => {
  uiStore.set({
    overlay: 'none',
    siteInfoOpen: false,
    permissionPromptOpen: false,
    clearBrowsingDataOpen: false,
    barMenuOpen: false,
    starDialog: null,
    snapshot: null,
    snapshotTabId: null,
    install: null,
    mediaSheet: null
  })
  vi.mocked(run).mockClear()
  vi.mocked(cmd).mockClear()
})

const INSTALL_PROMPT: WebAppInstallPrompt = {
  tabId: 't1',
  title: 'Sketch',
  url: 'https://sketch.example/',
  origin: 'sketch.example',
  icon: null,
  info: null,
  tint: null,
  surface: 'homeScreen'
}

describe('the install sheet', () => {
  it('opens for a Home-screen prompt and for a desktop one alike, over the page with the chrome focused', async () => {
    // One store entry serves both chromes: the phone's `InstallLayer` shows a sheet for it, the
    // desktop's `InstallDialogLayer` a dialog – each on its own host only.
    await openInstallSheet({ ...INSTALL_PROMPT, surface: 'desktop' })
    expect(idle().install?.surface).toBe('desktop')
    expect(run).toHaveBeenCalledWith('focus.chrome', undefined)
    uiStore.set({ install: null })
    vi.mocked(run).mockClear()
    await openInstallSheet(INSTALL_PROMPT)
    expect(idle().install?.tabId).toBe('t1')
    expect(run).toHaveBeenCalledWith('focus.chrome', undefined)
  })
})

describe('the media sheet', () => {
  it('holds a picture of the tab on screen, not of the media’s tab, and shows the media’s tab', async () => {
    vi.mocked(cmd).mockResolvedValueOnce('data:image/jpeg;base64,AAAA' as never)
    // The media plays in t1 while t2 is on screen: the recede starts on t2's page, and the
    // capture is named for it, so the host hides that view and no other.
    await openMediaSheet('t1', 't2')
    expect(cmd).toHaveBeenCalledWith('overlay.snapshot', { tabId: 't2' })
    expect(cmd).not.toHaveBeenCalledWith('overlay.snapshot', { tabId: 't1' })
    expect(idle().snapshotTabId).toBe('t2')
    expect(idle().mediaSheet).toBe('t1')
    expect(overlayCoversContent(idle())).toBe(true)
    expect(run).toHaveBeenCalledWith('focus.chrome', undefined)
    closeMediaSheet()
    expect(idle().mediaSheet).toBeNull()
  })
})

describe('chrome surfaces over the content', () => {
  it('counts the Clear browsing data dialog as a surface that covers the page and holds the keyboard', () => {
    expect(overlayCoversContent(idle())).toBe(false)
    expect(chromeNeedsKeyboard()).toBe(false)
    uiStore.set({ clearBrowsingDataOpen: true })
    expect(overlayCoversContent(idle())).toBe(true)
    expect(chromeNeedsKeyboard()).toBe(true)
    // A dialog dims the page: it is not a lone panel.
    expect(panelAloneOverContent(idle())).toBe(false)
  })

  it('treats site information and the permission prompt as panels that draw no dim of their own', () => {
    // A popover on a mouse (no scrim, §9.5), a chassis sheet on a phone whose own scrim is the
    // one dim over the page (§11.5): either way the capture behind them shows undimmed.
    uiStore.set({ siteInfoOpen: true })
    expect(panelAloneOverContent(idle())).toBe(true)
    uiStore.set({ siteInfoOpen: false, permissionPromptOpen: true })
    expect(panelAloneOverContent(idle())).toBe(true)
    // Over Settings the popover is not alone: the overlay dims.
    uiStore.set({ overlay: 'settings' })
    expect(panelAloneOverContent(idle())).toBe(false)
  })

  it('opens Clear browsing data once, taking the keyboard, and gives it back on close', async () => {
    await openClearBrowsingData(null)
    expect(idle().clearBrowsingDataOpen).toBe(true)
    expect(run).toHaveBeenCalledWith('focus.chrome', undefined)
    vi.mocked(run).mockClear()
    await openClearBrowsingData(null)
    expect(run).not.toHaveBeenCalled()
    closeClearBrowsingData()
    expect(idle().clearBrowsingDataOpen).toBe(false)
    expect(run).toHaveBeenCalledWith('focus.content', undefined)
    vi.mocked(run).mockClear()
    closeClearBrowsingData()
    expect(run).not.toHaveBeenCalled()
  })
})
