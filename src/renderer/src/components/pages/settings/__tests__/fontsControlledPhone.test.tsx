// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { DEFAULT_FONT_SETTINGS, type PageFontSettings } from '@shared/fonts'
import type { ExtensionControl, UIState } from '@shared/types'
import { browserStore } from '@renderer/lib/browserStore'
import { extensionRevealStore } from '@renderer/lib/extensions/manage'
import { fontsGroups } from '../fonts'
import { onLayout } from '../model'
import { GroupList } from '../rows'

/*
 * The phone's Settings › Fonts page under an extension's control (W6-C6, Android's half of the
 * `chrome.fontSettings` item): the real rows (`fontsGroups`, the phone layout – Font size,
 * Minimum font size, Standard font; Android's `capabilities.genericFontFamilies` is off) with
 * `UIState.extensionControls` holding them the way the host publishes a `fontSettings` layer.
 * The held rows draw disabled at the EXTENSION's value – the one a page gets – and the preview
 * shows that value too; one "Controlled by <name>" action row stands under the run and its press
 * opens the extension's own page (Settings › Extensions, the details sheet with its switch – the
 * lead's ruling on #500, §10.5); when the layer goes the user's own values stand again, nothing
 * of theirs having been written. The generic row is pinned in `controlledRow.test.tsx`; this is
 * the page.
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const invoke = vi.fn<(name: string, args?: unknown) => Promise<null>>(async () => null)
Object.assign(window, { zen: { invoke, on: () => () => undefined } })

let root: Root | null = null
let host: HTMLElement | null = null

function render(element: ReactElement): HTMLElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root?.render(element))
  return host
}

beforeEach(() => invoke.mockClear())

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
  browserStore.set({ state: null })
  extensionRevealStore.set({ id: null })
})

const ctx = { open: () => undefined }

const EXTENSION = 'caclkomlalccbpcdllchkeecicepbmbm'
const NAME = 'Advanced Font Settings'
const SINGLE = 'An extension sets this. Disable it to use your own value.'
const RUN = 'An extension sets these.'

const held = (value: string | number): ExtensionControl => ({
  extensionId: EXTENSION,
  name: NAME,
  value
})

/** The layer the bridge would publish for the fixture's `fonts` variant: all three phone rows held. */
const ALL_THREE: Record<string, ExtensionControl> = {
  'fonts.standard': held('sans-serif'),
  'fonts.size': held(18),
  'fonts.minimumSize': held(12)
}

/** The user's own fonts: the defaults, or a chosen face and size, kept under the layer. */
const OWN: PageFontSettings = {
  ...DEFAULT_FONT_SETTINGS,
  standard: 'serif',
  size: 20,
  minimumSize: 0
}

/** The phone host's state as the group reads it, with Settings a page tab (`capabilities.pageTabs`). */
function phoneState(
  fonts: PageFontSettings,
  extensionControls: Record<string, ExtensionControl>
): UIState {
  return {
    platform: 'android',
    capabilities: { genericFontFamilies: false, pageTabs: true },
    settings: { fonts },
    extensionControls,
    tabs: {},
    spaces: [{ id: 's', tabIds: [], activeTabId: null }],
    activeSpaceId: 's'
  } as unknown as UIState
}

function page(fonts: PageFontSettings, controls: Record<string, ExtensionControl>): HTMLElement {
  const state = phoneState(fonts, controls)
  browserStore.set({ state })
  const set = vi.fn()
  const groups = onLayout(fontsGroups({ state, set }), 'phone')
  return render(<GroupList groups={groups} ctx={ctx} />)
}

function rowIds(el: HTMLElement): string[] {
  return [...el.querySelectorAll<HTMLElement>('[data-row]')].map((r) => r.getAttribute('data-row')!)
}

function row(el: HTMLElement, id: string): HTMLElement {
  const found = el.querySelector<HTMLElement>(`[data-row="${id}"]`)
  if (!found) throw new Error(`no row ${id} among ${rowIds(el).join(', ')}`)
  return found
}

function sliderValue(el: HTMLElement, id: string): string | null | undefined {
  return row(el, id).querySelector('.zen-settings-slider-value')?.textContent
}

function previewVars(el: HTMLElement): { family: string; size: string } {
  const preview = row(el, 'fonts-preview')
  return {
    family: preview.style.getPropertyValue('--zen-settings-preview-family'),
    size: preview.style.getPropertyValue('--zen-settings-preview-size')
  }
}

describe('the phone’s Fonts page under an extension’s control', () => {
  it('draws the three held rows at the extension’s values, the preview in them, and ONE "Controlled by" row under the run', () => {
    const el = page(OWN, ALL_THREE)
    // The run of three, then its one indicator, then the preview; the Reset row stands since
    // the USER's own fonts are not the defaults (theirs are what Reset touches, not the layer).
    expect(rowIds(el)).toEqual([
      'fonts-size-phone',
      'fonts-minimum-size-phone',
      'fonts-standard-phone',
      'fonts-standard-phone-controlled',
      'fonts-preview',
      'fonts-reset'
    ])

    // Font size: the slider disabled at 18 px – the extension's, over the user's 20. The thumb
    // is the node TalkBack reads (`role="slider"`, the name and the value on it), so the disabled
    // state is on it too: Radix alone leaves it there unfocusable but reading as one that moves.
    const size = row(el, 'fonts-size-phone')
    expect(size.classList.contains('zen-settings-row-disabled')).toBe(true)
    expect(size.querySelector('.zen-zoom-slider')?.hasAttribute('data-disabled')).toBe(true)
    const thumb = size.querySelector<HTMLElement>('[role="slider"]')!
    expect(thumb.getAttribute('aria-disabled')).toBe('true')
    expect(thumb.getAttribute('aria-valuetext')).toBe('18 px')
    expect(thumb.hasAttribute('tabindex')).toBe(false)
    expect(sliderValue(el, 'fonts-size-phone')).toBe('18 px')
    // Minimum font size: 12 px over the user's none.
    const minimum = row(el, 'fonts-minimum-size-phone')
    expect(minimum.classList.contains('zen-settings-row-disabled')).toBe(true)
    expect(sliderValue(el, 'fonts-minimum-size-phone')).toBe('12 px')
    // Standard font: the action row takes no press (aria-disabled, §9.30's one .4) and names the
    // extension's family as the picker would – Sans-serif – over the user's Serif.
    const standard = row(el, 'fonts-standard-phone')
    expect(standard.tagName.toLowerCase()).toBe('button')
    expect(standard.getAttribute('aria-disabled')).toBe('true')
    expect(standard.classList.contains('zen-settings-row-disabled')).toBe(true)
    expect(standard.querySelector('.zen-settings-description')?.textContent).toBe('Sans-serif')

    // The preview draws what a page gets: the extension's face and size.
    expect(previewVars(el)).toEqual({ family: expect.stringContaining('sans-serif'), size: '18px' })

    // The one indicator: full ink, a pressable row named for the extension, its words the run's,
    // the chevron alone trailing – TalkBack reads the label and the description as the row's name.
    const indicator = row(el, 'fonts-standard-phone-controlled')
    expect(indicator.tagName.toLowerCase()).toBe('button')
    expect(indicator.classList.contains('zen-settings-row-pressable')).toBe(true)
    expect(indicator.classList.contains('zen-settings-row-disabled')).toBe(false)
    expect(indicator.hasAttribute('aria-disabled')).toBe(false)
    expect(indicator.querySelector('.zen-settings-label')?.textContent).toBe(
      `Controlled by ${NAME}`
    )
    expect(indicator.querySelector('.zen-settings-description')?.textContent).toBe(RUN)
    const trailing = indicator.querySelector<HTMLElement>('.zen-settings-trailing')!
    const glyphs = [...trailing.children]
    expect(glyphs.map((c) => c.tagName.toLowerCase())).toEqual(['svg'])
    expect(glyphs[0]!.classList.contains('lucide-chevron-right')).toBe(true)
    expect(glyphs[0]!.getAttribute('aria-hidden')).toBe('true')
    expect(indicator.querySelector('button')).toBeNull()
    expect(el.querySelectorAll('[data-row$="-controlled"]')).toHaveLength(1)
  })

  it('opens the extension’s own page on the indicator’s press – Settings › Extensions with its details asked for – and disables nothing', () => {
    const el = page(OWN, ALL_THREE)
    act(() => row(el, 'fonts-standard-phone-controlled').click())
    expect(invoke).toHaveBeenCalledWith('page.open', { id: 'settings', section: 'extensions' })
    expect(invoke).not.toHaveBeenCalledWith('extension.setEnabled', expect.anything())
    expect(invoke).not.toHaveBeenCalledWith('settings.update', expect.anything())
    expect(extensionRevealStore.get().id).toBe(EXTENSION)
  })

  it('holds one row alone with its own indicator right after it, the other rows free', () => {
    const el = page(OWN, { 'fonts.size': held(18) })
    expect(rowIds(el)).toEqual([
      'fonts-size-phone',
      'fonts-size-phone-controlled',
      'fonts-minimum-size-phone',
      'fonts-standard-phone',
      'fonts-preview',
      'fonts-reset'
    ])
    expect(sliderValue(el, 'fonts-size-phone')).toBe('18 px')
    expect(
      row(el, 'fonts-size-phone-controlled').querySelector('.zen-settings-description')?.textContent
    ).toBe(SINGLE)
    const minimum = row(el, 'fonts-minimum-size-phone')
    expect(minimum.classList.contains('zen-settings-row-disabled')).toBe(false)
    expect(minimum.querySelector('.zen-zoom-slider')?.hasAttribute('data-disabled')).toBe(false)
    const freeThumb = minimum.querySelector<HTMLElement>('[role="slider"]')!
    expect(freeThumb.hasAttribute('aria-disabled')).toBe(false)
    expect(freeThumb.getAttribute('tabindex')).toBe('0')
    const standard = row(el, 'fonts-standard-phone')
    expect(standard.hasAttribute('aria-disabled')).toBe(false)
    expect(standard.querySelector('.zen-settings-description')?.textContent).toBe('Serif')
    // The preview: the extension's size, the user's own face.
    expect(previewVars(el)).toEqual({ family: expect.stringContaining('serif'), size: '18px' })
  })

  it('keeps the standard family held even when the extension names the engine’s own (no value): the row shows the user’s face, disabled', () => {
    const el = page(OWN, { 'fonts.standard': { extensionId: EXTENSION, name: NAME } })
    const standard = row(el, 'fonts-standard-phone')
    expect(standard.getAttribute('aria-disabled')).toBe('true')
    expect(standard.querySelector('.zen-settings-description')?.textContent).toBe('Serif')
    expect(rowIds(el)).toContain('fonts-standard-phone-controlled')
  })

  it('lets the user’s own values stand again once the layer is gone, nothing of theirs written', () => {
    const el = page(OWN, {})
    expect(rowIds(el)).toEqual([
      'fonts-size-phone',
      'fonts-minimum-size-phone',
      'fonts-standard-phone',
      'fonts-preview',
      'fonts-reset'
    ])
    for (const id of ['fonts-size-phone', 'fonts-minimum-size-phone', 'fonts-standard-phone'])
      expect(row(el, id).classList.contains('zen-settings-row-disabled')).toBe(false)
    expect(sliderValue(el, 'fonts-size-phone')).toBe('20 px')
    expect(sliderValue(el, 'fonts-minimum-size-phone')).toBe('None')
    expect(
      row(el, 'fonts-standard-phone').querySelector('.zen-settings-description')?.textContent
    ).toBe('Serif')
    expect(previewVars(el).size).toBe('20px')
    expect(invoke).not.toHaveBeenCalledWith('settings.update', expect.anything())
  })

  it('shows the defaults free of any layer with no Reset row: the page as most phones have it', () => {
    const el = page(DEFAULT_FONT_SETTINGS, {})
    expect(rowIds(el)).toEqual([
      'fonts-size-phone',
      'fonts-minimum-size-phone',
      'fonts-standard-phone',
      'fonts-preview'
    ])
    expect(sliderValue(el, 'fonts-size-phone')).toBe('16 px')
    expect(
      row(el, 'fonts-standard-phone').querySelector('.zen-settings-description')?.textContent
    ).toBe('System default')
  })
})
