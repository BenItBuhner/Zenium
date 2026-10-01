// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type JSX, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Platform, UIState } from '@shared/types'
import { FrameDialogHost } from '@renderer/lib/portals'
import { browserStore, uiStore } from '@renderer/lib/ui'
import { viewportStore } from '@renderer/lib/formFactor'
import { BAND_HEIGHT_ONE_LINE } from '@renderer/lib/motion/band'
import type { BandHost } from '../../band/PageEdgeBand'

/*
 * The desktop's default-browser surfaces on v2: the page-edge band's state (motion spec §3.4;
 * `content/useDefaultBrowserBand.ts` – the strip under the toolbar before W8-M2) – a page
 * surface with the Settings section's globe, the sentence, the one action Set as default and
 * the × named Dismiss as on every band (§3.1, §9.29; the Lead's ruling on #740) – whose Set as
 * default asks the OS directly and holds (the Design Lead's ruling on the band's tenants, W8-M3:
 * the dialog the desktop raised before the hand-off is dropped); on Windows, where the hand-off
 * opens Windows Settings, the band re-words itself in place – Open Windows Settings its action,
 * the hand-off again (the Lead's gate on #754, §10) – and leaves when the role is confirmed or
 * on ×, which there remembers nothing. Then the phone's campaign promo (`PromoSheet`, the core's `prompt: 'sheet'` on a
 * coarse pointer): the §9.23 composition as a
 * sheet – the 48 app icon above the chassis' title block, no glyph on the title (§9.23 as the
 * #264 verdict wrote it; the primitives pass 3, #272) – and its mouse form (`HostedDialog`),
 * the icon over the block.
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const run = vi.fn()
const cmd = vi.fn<(name: string, args: unknown) => Promise<unknown>>()
vi.mock('@renderer/lib/api', () => ({
  run: (...args: unknown[]) => run(...args),
  cmd: (name: string, args: unknown) => cmd(name, args),
  onEvent: () => () => undefined
}))

const { PageEdgeBand } = await import('../../band/PageEdgeBand')
const { useDefaultBrowserBand } = await import('../../content/useDefaultBrowserBand')
const { bandStore, chooseBand, resetBands, setBandFrame } = await import('@renderer/lib/band')
const { DefaultBrowserLayer } = await import('../DefaultBrowserPrompt')

function state(platform: Platform, dismissed: string | null = null): UIState {
  return {
    platform,
    version: '0.3.77',
    tabs: {},
    spaces: [{ id: 's1', activeTabId: null, tabIds: [] }],
    activeSpaceId: 's1',
    essentialTabIds: [],
    settings: { appIcon: 'indigo', defaultBrowserPromptDismissed: dismissed, onboardingDone: true },
    capabilities: { defaultBrowser: true },
    defaultBrowser: { isDefault: false, prompt: null },
    window: { kind: 'normal', fullscreen: false }
  } as unknown as UIState
}

/** The same window once the OS names Zenium: the state the band stands for has ended. */
function confirmed(platform: Platform): UIState {
  return { ...state(platform), defaultBrowser: { isDefault: true, prompt: null } } as UIState
}

/** The page under the band stands still here: the seam is the host's business (PageBandHost's tests). */
const HOST: BandHost = { translate: () => undefined, rest: () => undefined }

/** The band on a desktop page tab: the tenant's hook, then the band standing what the model chose. */
function Band({ state }: { state: UIState }): JSX.Element {
  useDefaultBrowserBand(state)
  return <PageEdgeBand host={HOST} />
}

let container: HTMLDivElement
let root: Root

function render(el: ReactElement): void {
  act(() => root.render(el))
}

/** Let a request's promise settle through the tenant's `then`. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

/** The prompt while it is open; a closed one the host keeps through its exit is `data-leaving` (#188). */
const dialog = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('[role="dialog"]:not([data-leaving])')
const buttons = (scope: ParentNode): HTMLButtonElement[] => [
  ...scope.querySelectorAll<HTMLButtonElement>('button')
]
const click = (el: Element | null): void => {
  act(() => {
    el!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

const view = (s: UIState): ReactElement => (
  <>
    <FrameDialogHost frame />
    <Band state={s} />
    <DefaultBrowserLayer />
  </>
)

/** The band standing in the frame, its action and its ×. */
const band = (): HTMLElement => container.querySelector<HTMLElement>('.zen-band')!
/** The band's content that is current: not the tenant fading out after a re-wording. */
const content = (): HTMLElement =>
  band().querySelector<HTMLElement>('.zen-band-content:not([data-leaving])')!
const title = (): string => content().querySelector('.zen-band-title')!.textContent ?? ''
const setDefaultButton = (): HTMLButtonElement | null =>
  content().querySelector<HTMLButtonElement>('.zen-band-button')
/** The band's ×: "Dismiss" on every band (the Lead's ruling on #740), the one refusal remembered. */
const dismissButton = (): HTMLButtonElement =>
  content().querySelector<HTMLButtonElement>('.zen-band-close')!
/** What the tenant asked of the core: the requests out, the refusal remembered. */
const requests = (): unknown[][] =>
  cmd.mock.calls.filter(([name]) => name === 'defaultBrowser.request')
const remembered = (): unknown[][] => run.mock.calls.filter(([c]) => c === 'settings.update')

beforeEach(() => {
  run.mockClear()
  cmd.mockReset()
  cmd.mockResolvedValue(true)
  // The band's travel is the clock's; nothing here paints a frame, so the band stands where it
  // mounted (its content's opacity is the driver's, not what these tests read).
  vi.stubGlobal('requestAnimationFrame', () => 1)
  vi.stubGlobal('cancelAnimationFrame', () => undefined)
  uiStore.set({ defaultBrowserPrompt: false })
  browserStore.set({ state: state('linux') })
  resetBands()
  // A page tab in front, a band welcome on it.
  setBandFrame({ front: 't1', ok: true })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  resetBands()
  vi.unstubAllGlobals()
  uiStore.set({ defaultBrowserPrompt: false })
})

describe('the default-browser band (the strip under the toolbar until W8-M2)', () => {
  it('is the page-edge band’s state: a page surface with the globe, the sentence, the one action Set as default and the × named Dismiss, as on every band (§3.1, §9.29: the one name for the act)', () => {
    render(view(state('linux')))
    const el = band()
    expect(el).not.toBeNull()
    expect(el.getAttribute('data-surface')).toBe('page')
    expect(el.getAttribute('role')).toBe('status')
    expect(el.dataset.form).toBe('state')
    // No alarm: the glyph keeps the deemphasised ink (no tone), and it is the Settings section's globe.
    expect(el.dataset.tone).toBeUndefined()
    expect(el.querySelector('.zen-band-glyph')).not.toBeNull()
    expect(title()).toBe('Make Zenium your default browser')
    expect(el.querySelector('.zen-band-detail')).toBeNull()
    expect(buttons(el)).toHaveLength(2)
    expect(setDefaultButton()!.textContent).toBe('Set as default')
    // The × is every band's "Dismiss": no "Not now" on the band (the Lead's ruling on #740).
    expect(dismissButton().getAttribute('aria-label')).toBe('Dismiss')
    // Nothing of the strip remains in the frame.
    expect(container.querySelector('.zen-frame-strip')).toBeNull()
  })

  it('remembers the × (Dismiss) for this feature release and asks nothing of the OS', () => {
    render(view(state('linux')))
    click(dismissButton())
    expect(remembered()).toEqual([['settings.update', { defaultBrowserPromptDismissed: '0.3.77' }]])
    expect(cmd).not.toHaveBeenCalled()
    // The prompt is gone from the model: the band is on its way out.
    expect(chooseBand(bandStore.get())).toBeNull()
  })

  it('Escape with focus in the band puts it away for now and remembers nothing (the Lead’s ruling, §3.2 / §9.6): the × alone is the refusal kept', () => {
    render(view(state('linux')))
    act(() => {
      const close = dismissButton()
      close.focus()
      close.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(chooseBand(bandStore.get())).toBeNull()
    expect(remembered()).toEqual([])
    expect(cmd).not.toHaveBeenCalled()
    // Nothing kept against it: the band stands again at the next eligible moment – here the
    // hook mounting again on the same window state (the next window, the next launch).
    act(() => root.render(null))
    render(view(state('linux')))
    expect(band()).not.toBeNull()
    expect(chooseBand(bandStore.get())).not.toBeNull()
  })

  it('stands again once the answer is for an older release, and not while it is this one’s', () => {
    render(view(state('linux', '0.3.77')))
    expect(container.querySelector('.zen-band')).toBeNull()
    expect(chooseBand(bandStore.get())).toBeNull()
    render(view(state('linux', '0.2.9')))
    expect(band()).not.toBeNull()
  })

  it('asks the OS directly on Set as default – no prompt before the hand-off, nothing over the page – and holds through the request', async () => {
    // The OS has not answered within the host's poll window: the role is unknown for now.
    cmd.mockResolvedValue(null)
    render(view(state('linux')))
    click(setDefaultButton())
    expect(requests()).toEqual([['defaultBrowser.request', { source: 'banner' }]])
    await settle()
    expect(dialog()).toBeNull()
    expect(uiStore.get().defaultBrowserPrompt).toBe(false)
    // A state, not an answer: the band stands as it was, its words unchanged off Windows, and
    // nothing is remembered – the role ends the state, or the ×.
    expect(chooseBand(bandStore.get())!.key).toBe('default-browser')
    expect(title()).toBe('Make Zenium your default browser')
    expect(setDefaultButton()).not.toBeNull()
    expect(remembered()).toEqual([])
  })

  it('leaves when the role is confirmed, remembering nothing: the settings keep no answer the OS gave', () => {
    render(view(state('darwin')))
    click(setDefaultButton())
    render(view(confirmed('darwin')))
    expect(chooseBand(bandStore.get())).toBeNull()
    expect(remembered()).toEqual([])
    // The role lost again later (another browser took it): the band stands again – nothing was kept.
    render(view(state('darwin')))
    expect(chooseBand(bandStore.get())!.key).toBe('default-browser')
  })

  it('a second Set as default is a second request: the band is a state, not a one-shot button', () => {
    cmd.mockResolvedValue(null)
    render(view(state('darwin')))
    click(setDefaultButton())
    click(setDefaultButton())
    expect(requests()).toHaveLength(2)
    expect(chooseBand(bandStore.get())!.key).toBe('default-browser')
  })
})

describe('the band on Windows, where the hand-off opens Windows Settings', () => {
  it('re-words itself in place on Set as default – the same band, its content cross-fading to "Press Set default in Windows Settings" with Open Windows Settings and the × – and stands so while the user has not decided', async () => {
    cmd.mockResolvedValue(null)
    render(view(state('win32')))
    const before = chooseBand(bandStore.get())!
    click(setDefaultButton())
    // The request went out as on any OS; the band did not leave for it.
    expect(requests()).toEqual([['defaultBrowser.request', { source: 'banner' }]])
    const after = chooseBand(bandStore.get())!
    expect(after.key).toBe('default-browser')
    expect(after.id).not.toBe(before.id)
    // One band, re-targeted: no second `.zen-band`, the ask's words fading out over the
    // instruction coming in (the band's 120 ms swap), the height one line still.
    expect(container.querySelectorAll('.zen-band')).toHaveLength(1)
    const leaving = band().querySelector<HTMLElement>('.zen-band-content[data-leaving]')!
    expect(leaving).not.toBeNull()
    expect(leaving.querySelector('.zen-band-title')!.textContent).toBe(
      'Make Zenium your default browser'
    )
    expect(content().hasAttribute('data-swap')).toBe(true)
    expect(title()).toBe('Press Set default in Windows Settings')
    expect(band().querySelector('.zen-band-detail')).toBeNull()
    expect(band().style.getPropertyValue('--zen-band-height')).toBe(`${BAND_HEIGHT_ONE_LINE}px`)
    // An instruction: the user finishes in Windows Settings, so the band's one action is the
    // hand-off again, named for where it goes (the Lead's gate on #754, §10); the × stays, by
    // its one name.
    expect(buttons(content())).toHaveLength(2)
    expect(setDefaultButton()!.textContent).toBe('Open Windows Settings')
    expect(dismissButton().getAttribute('aria-label')).toBe('Dismiss')
    // The poll window closed without an answer: the instruction stands (the core reads the role
    // again on the next return to the foreground).
    await settle()
    expect(title()).toBe('Press Set default in Windows Settings')
    expect(dialog()).toBeNull()
    expect(uiStore.get().defaultBrowserPrompt).toBe(false)
    expect(remembered()).toEqual([])
  })

  it('leaves when the role is confirmed – the status flipping under it – and remembers nothing', async () => {
    cmd.mockResolvedValue(true)
    render(view(state('win32')))
    click(setDefaultButton())
    await settle()
    expect(title()).toBe('Press Set default in Windows Settings')
    render(view(confirmed('win32')))
    expect(chooseBand(bandStore.get())).toBeNull()
    expect(remembered()).toEqual([])
    // The hand-off is forgotten with the state: should the role be lost again, the band asks
    // afresh, in the ask's words.
    render(view(state('win32')))
    expect(title()).toBe('Make Zenium your default browser')
    expect(setDefaultButton()).not.toBeNull()
  })

  it('Open Windows Settings on the instruction is the hand-off again – the same request out, the instruction standing as it was with no re-wording', async () => {
    cmd.mockResolvedValue(null)
    render(view(state('win32')))
    click(setDefaultButton())
    await settle()
    const standing = chooseBand(bandStore.get())!
    // The one swap so far is the ask's words fading out under the instruction.
    const swaps = band().querySelectorAll('.zen-band-content').length
    click(setDefaultButton())
    expect(requests()).toEqual([
      ['defaultBrowser.request', { source: 'banner' }],
      ['defaultBrowser.request', { source: 'banner' }]
    ])
    // The same entry holds: nothing swapped under the words already there.
    expect(chooseBand(bandStore.get())!.id).toBe(standing.id)
    expect(band().querySelectorAll('.zen-band-content')).toHaveLength(swaps)
    expect(title()).toBe('Press Set default in Windows Settings')
    expect(setDefaultButton()!.textContent).toBe('Open Windows Settings')
    await settle()
    expect(title()).toBe('Press Set default in Windows Settings')
    expect(remembered()).toEqual([])
  })

  it('the × on the instruction is a plain put-away (§10): the user has Windows Settings open, not refused, so nothing is remembered and the band asks afresh in the ask’s words', async () => {
    cmd.mockResolvedValue(null)
    render(view(state('win32')))
    click(setDefaultButton())
    click(dismissButton())
    expect(remembered()).toEqual([])
    expect(chooseBand(bandStore.get())).toBeNull()
    await settle()
    expect(chooseBand(bandStore.get())).toBeNull()
    // The next eligible moment: the hook mounting again on the same window state.
    act(() => root.render(null))
    render(view(state('win32')))
    expect(title()).toBe('Make Zenium your default browser')
    expect(setDefaultButton()!.textContent).toBe('Set as default')
  })

  it('the ask’s × alone keeps the refusal: on Windows as anywhere, before the hand-off', () => {
    render(view(state('win32')))
    click(dismissButton())
    expect(remembered()).toEqual([['settings.update', { defaultBrowserPromptDismissed: '0.3.77' }]])
    expect(cmd).not.toHaveBeenCalled()
    expect(chooseBand(bandStore.get())).toBeNull()
  })

  it('a hand-off refused on the spot – Windows Settings never opened – takes the ask’s words back', async () => {
    cmd.mockResolvedValue(false)
    render(view(state('win32')))
    click(setDefaultButton())
    expect(title()).toBe('Press Set default in Windows Settings')
    await settle()
    expect(chooseBand(bandStore.get())!.key).toBe('default-browser')
    expect(title()).toBe('Make Zenium your default browser')
    expect(setDefaultButton()).not.toBeNull()
    expect(remembered()).toEqual([])
  })

  it('a refusal arriving after the band has gone stands nothing up again', async () => {
    cmd.mockResolvedValue(false)
    render(view(state('win32')))
    click(setDefaultButton())
    click(dismissButton())
    await settle()
    expect(chooseBand(bandStore.get())).toBeNull()
    expect(bandStore.get().entries).toEqual([])
  })
})

describe('the campaign promo (§9.23: a prompt about Zenium itself)', () => {
  /** The core says a sheet is due; with no tab to capture the prompt goes up on the next frame. */
  function due(platform: Platform): UIState {
    const s = state(platform)
    return { ...s, defaultBrowser: { isDefault: false, prompt: 'sheet' } } as UIState
  }

  /** Frames asked for and not yet painted: the layer's one before its capture, the sheet's spring. */
  let frames: FrameRequestCallback[] = []

  /**
   * One frame – the layer captures the (absent) page and puts the prompt up – then the microtasks
   * of the capture; the sheet's own frames stay unpainted, so it stands where it mounted (as the
   * PhoneSheet tests keep it) instead of springing through happy-dom's zero-height layout.
   */
  async function raise(): Promise<void> {
    await act(async () => {
      for (const frame of frames.splice(0)) frame(0)
      await Promise.resolve()
      await Promise.resolve()
    })
    await settle()
  }

  beforeEach(() => {
    frames = []
    vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => frames.push(fn))
    vi.stubGlobal('cancelAnimationFrame', () => undefined)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    viewportStore.set({ ...viewportStore.get(), formFactor: 'desktop', coarse: false })
  })

  it('on a phone is the sheet: the 48 app icon above the chassis title block, the block itself with no glyph, Not now then Set as default', async () => {
    // The viewport re-derives itself from the window on every browser-state change: the state
    // goes in first, then the finger.
    browserStore.set({ state: due('android') })
    viewportStore.set({ ...viewportStore.get(), formFactor: 'phone', coarse: true })
    render(
      <>
        <FrameDialogHost frame />
        <DefaultBrowserLayer />
      </>
    )
    await raise()
    const sheet = document.querySelector<HTMLElement>('.zen-sheet[role="dialog"]')!
    expect(sheet).not.toBeNull()
    const body = sheet.querySelector<HTMLElement>('.zen-sheet-scroll')!
    // The icon's box is the body's first content, the title block straight after it – the
    // mouse dialog's order, the one composition (§9.23).
    const icon = body.querySelector<HTMLElement>('.zen-sheet-app-icon')!
    expect(icon).not.toBeNull()
    expect(icon.parentElement?.firstElementChild).toBe(icon)
    const mark = icon.firstElementChild!
    expect(mark.tagName.toLowerCase()).toBe('svg')
    expect(mark.getAttribute('aria-hidden')).toBe('true')
    const block = body.querySelector<HTMLElement>('.zen-sheet-title-block')!
    expect(icon.nextElementSibling).toBe(block)
    // No glyph on the title's start: the icon stands in for it.
    expect(block.querySelector('h2 svg')).toBeNull()
    expect(block.querySelector('h2')?.textContent).toBe('Make Zenium your default browser')
    expect(sheet.getAttribute('aria-labelledby')).toBe(block.querySelector('h2')!.id)
    expect(block.querySelector('p')?.textContent).toMatch(/^Links from other apps open in Zenium/)
    // No 48 header: a prompt sheet opens on its block.
    expect(sheet.querySelector('.zen-sheet-header')).toBeNull()
    const [notNow, setDefault] = buttons(block.parentElement!)
    expect(notNow.textContent).toBe('Not now')
    expect(setDefault.textContent).toBe('Set as default')
    expect(setDefault.hasAttribute('data-primary')).toBe(true)
  })

  it('on a mouse is the dialog with the same icon over its title block, no glyph', async () => {
    browserStore.set({ state: due('android') })
    viewportStore.set({ ...viewportStore.get(), formFactor: 'desktop', coarse: false })
    render(
      <>
        <FrameDialogHost frame />
        <DefaultBrowserLayer />
      </>
    )
    await raise()
    const d = dialog()!
    expect(d).not.toBeNull()
    expect(d.classList.contains('zen-v2-dialog')).toBe(true)
    const [icon, block] = [...d.children]
    expect(icon.tagName.toLowerCase()).toBe('svg')
    expect(icon.classList.contains('zen-default-browser-prompt-icon')).toBe(true)
    expect(block.classList.contains('zen-v2-title-block')).toBe(true)
    expect(block.querySelector('.zen-v2-title-block-title svg')).toBeNull()
    expect(block.querySelector('.zen-v2-title-block-title')!.textContent).toBe(
      'Make Zenium your default browser'
    )
  })
})
