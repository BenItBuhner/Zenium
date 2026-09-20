import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../api', () => ({
  cmd: vi.fn(async () => null),
  run: vi.fn(),
  onEvent: vi.fn(() => () => undefined)
}))

import type { WebAppInstallPrompt } from '@shared/types'
import { run } from '../api'
import {
  chromeNeedsKeyboard,
  closeClearBrowsingData,
  openClearBrowsingData,
  openInstallSheet,
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
    install: null
  })
  vi.mocked(run).mockClear()
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
  it('opens for a Home-screen prompt and not for a desktop one, whose dialog is still to land', async () => {
    // A desktop prompt (a chrome that registered the install surface on a host with windows would
    // be one) shows nothing here: the phone's sheet is not the desktop's dialog.
    await openInstallSheet({ ...INSTALL_PROMPT, surface: 'desktop' })
    expect(idle().install).toBeNull()
    expect(run).not.toHaveBeenCalled()
    await openInstallSheet(INSTALL_PROMPT)
    expect(idle().install?.tabId).toBe('t1')
    expect(run).toHaveBeenCalledWith('focus.chrome', undefined)
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
