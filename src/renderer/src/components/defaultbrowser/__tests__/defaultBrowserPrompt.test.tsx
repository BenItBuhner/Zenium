// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type JSX, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Platform, UIState } from '@shared/types'
import { FrameDialogHost } from '@renderer/lib/portals'
import { browserStore, uiStore } from '@renderer/lib/ui'
import { describeDefaultBrowserRequest } from '@renderer/lib/defaultBrowser'
import { viewportStore } from '@renderer/lib/formFactor'
import type { BandHost } from '../../band/PageEdgeBand'

/*
 * The desktop's default-browser surfaces on v2: the page-edge band's state (motion spec §3.4;
 * `content/useDefaultBrowserBand.ts` – the strip under the toolbar before W8-M2) – a page
 * surface with the Settings section's globe, the sentence, the one action Set as default and
 * the × named Not now (§3.1, §9.29) – and the prompt its Set as default raises before the OS
 * hand-off (`AskDialog` in DefaultBrowserPrompt.tsx): the §9.23 composition on the frame's
 * dialog host with the app icon at 48 over the title block, one sentence per OS, focus on the
 * primary, Escape closing it and giving focus back to the band's button, the primary running
 * the request and taking the band down for this release. Then the phone's campaign promo
 * (`PromoSheet`, the core's `prompt: 'sheet'` on a coarse pointer): the same composition as a
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

/** Let the prompt's wait for the page's picture resolve (at once with no page) and it come up. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

/** The prompt while it is open; a closed one the host keeps through its exit is `data-leaving` (#188). */
const dialog = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('[role="dialog"]:not([data-leaving])')
const leaving = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('[role="dialog"][data-leaving]')
const buttons = (scope: ParentNode): HTMLButtonElement[] => [
  ...scope.querySelectorAll<HTMLButtonElement>('button')
]
const click = (el: Element | null): void => {
  act(() => {
    el!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}
const escape = (): void => {
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
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
const setDefaultButton = (): HTMLButtonElement =>
  band().querySelector<HTMLButtonElement>('.zen-band-button')!
const notNowButton = (): HTMLButtonElement =>
  band().querySelector<HTMLButtonElement>('.zen-band-close')!

beforeEach(() => {
  run.mockClear()
  cmd.mockReset()
  cmd.mockResolvedValue(true)
  // The band's travel is the clock's; nothing here paints a frame, so the band stands where it
  // mounted (its content's opacity is the driver's, not what these tests read).
  vi.stubGlobal('requestAnimationFrame', () => 1)
  vi.stubGlobal('cancelAnimationFrame', () => undefined)
  uiStore.set({ defaultBrowserAsk: null, defaultBrowserPrompt: false })
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
  uiStore.set({ defaultBrowserAsk: null, defaultBrowserPrompt: false })
})

describe('the default-browser band (the strip under the toolbar until W8-M2)', () => {
  it('is the page-edge band’s state: a page surface with the globe, the sentence, the one action Set as default and the × named Not now (§3.1, §9.29: the one name for the act)', () => {
    render(view(state('linux')))
    const el = band()
    expect(el).not.toBeNull()
    expect(el.getAttribute('data-surface')).toBe('page')
    expect(el.getAttribute('role')).toBe('status')
    expect(el.dataset.form).toBe('state')
    // No alarm: the glyph keeps the deemphasised ink (no tone), and it is the Settings section's globe.
    expect(el.dataset.tone).toBeUndefined()
    expect(el.querySelector('.zen-band-glyph')).not.toBeNull()
    expect(el.querySelector('.zen-band-title')!.textContent).toBe(
      'Make Zenium your default browser'
    )
    expect(el.querySelector('.zen-band-detail')).toBeNull()
    expect(buttons(el)).toHaveLength(2)
    expect(setDefaultButton().textContent).toBe('Set as default')
    expect(notNowButton().getAttribute('aria-label')).toBe('Not now')
    // Nothing of the strip remains in the frame.
    expect(container.querySelector('.zen-frame-strip')).toBeNull()
  })

  it('remembers Not now (the ×) for this feature release and asks nothing of the OS', () => {
    render(view(state('linux')))
    click(notNowButton())
    expect(run).toHaveBeenCalledWith('settings.update', {
      defaultBrowserPromptDismissed: '0.3.77'
    })
    expect(cmd).not.toHaveBeenCalled()
    expect(uiStore.get().defaultBrowserAsk).toBeNull()
    // The prompt is gone from the model: the band is on its way out.
    expect(chooseBand(bandStore.get())).toBeNull()
  })

  it('Escape with focus in the band puts it away for now and remembers nothing (the Lead’s ruling, §3.2 / §9.6): the × alone is the refusal kept', () => {
    render(view(state('linux')))
    act(() => {
      const close = notNowButton()
      close.focus()
      close.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(chooseBand(bandStore.get())).toBeNull()
    expect(run).not.toHaveBeenCalledWith('settings.update', expect.anything())
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

  it('raises the prompt on Set as default instead of handing off blind, and holds through it', () => {
    render(view(state('linux')))
    click(setDefaultButton())
    expect(uiStore.get().defaultBrowserAsk).toBe('banner')
    expect(cmd).not.toHaveBeenCalledWith('defaultBrowser.request', expect.anything())
    expect(chooseBand(bandStore.get())).not.toBeNull()
  })
})

describe('the desktop prompt', () => {
  it.each<[Platform, string]>([
    ['win32', 'Windows will open Default apps, where you can choose Zenium.'],
    ['darwin', 'macOS will ask you to confirm.'],
    ['linux', 'Zenium will register itself with your desktop.']
  ])('says in one sentence what %s does once the user says yes', (platform, sentence) => {
    expect(describeDefaultBrowserRequest(platform)).toBe(sentence)
  })

  it('is the §9.23 composition on the dialog host: app icon, title block with the OS sentence, Not now then the primary, focus on the primary', async () => {
    browserStore.set({ state: state('win32') })
    render(view(state('win32')))
    click(setDefaultButton())
    await settle()
    const d = dialog()!
    expect(d).not.toBeNull()
    expect(d.classList.contains('zen-v2-dialog')).toBe(true)
    expect(d.style.width).toBe('400px')
    expect(d.getAttribute('aria-modal')).toBe('true')
    // The app icon at the top of the block, then the title block – nothing else before them.
    const [icon, block] = [...d.children]
    expect(icon.tagName.toLowerCase()).toBe('svg')
    expect(icon.classList.contains('zen-default-browser-prompt-icon')).toBe(true)
    expect(block.classList.contains('zen-v2-title-block')).toBe(true)
    expect(block.querySelector('.zen-v2-title-block-title')!.textContent).toBe(
      'Make Zenium your default browser'
    )
    expect(block.querySelector('.zen-v2-title-block-title svg')).toBeNull()
    const description = block.querySelector('.zen-v2-title-block-description')!
    expect(description.textContent).toBe(
      'Windows will open Default apps, where you can choose Zenium.'
    )
    expect(d.getAttribute('aria-labelledby')).toBe(block.querySelector('h2')!.id)
    expect(d.getAttribute('aria-describedby')).toBe(description.id)
    const [notNow, setDefault] = buttons(d)
    expect(buttons(d)).toHaveLength(2)
    expect(notNow.textContent).toBe('Not now')
    // The band's word again (§9.29): one flow, one name for the act.
    expect(setDefault.textContent).toBe('Set as default')
    expect(setDefault.hasAttribute('data-primary')).toBe(true)
    expect(document.activeElement).toBe(setDefault)
    // Up over the page's picture: the host hides the view meanwhile.
    expect(uiStore.get().defaultBrowserPrompt).toBe(true)
  })

  it('closes on Escape without asking the OS, and focus goes back to the band’s button once the frame is back', async () => {
    render(view(state('linux')))
    const opener = setDefaultButton()
    act(() => opener.focus())
    click(opener)
    await settle()
    expect(dialog()).not.toBeNull()
    // The band is in the frame behind the dialog host: covered with the rest of the frame
    // (a11y-32, `holdFrameInert`) – no press, focus or Tab reaches it while the prompt stands
    // – and it stands through the prompt (the state holds).
    expect(band().hasAttribute('inert')).toBe(true)
    expect(chooseBand(bandStore.get())).not.toBeNull()
    escape()
    await settle()
    expect(dialog()).toBeNull()
    expect(uiStore.get().defaultBrowserAsk).toBeNull()
    expect(uiStore.get().defaultBrowserPrompt).toBe(false)
    expect(cmd).not.toHaveBeenCalledWith('defaultBrowser.request', expect.anything())
    expect(run).not.toHaveBeenCalledWith('settings.update', expect.anything())
    // The host keeps the panel through its pop exit, inert and hidden from assistive technology,
    // and the frame stays covered with it (#188): the band cannot take the focus back yet.
    const panel = leaving()!
    expect(panel).not.toBeNull()
    expect(panel.hasAttribute('inert')).toBe(true)
    expect(panel.getAttribute('aria-hidden')).toBe('true')
    expect(band().hasAttribute('inert')).toBe(true)
    expect(document.activeElement).toBe(document.body)
    // The exit ends: the panel goes, the frame comes back and the opener takes the focus.
    await act(async () => {
      panel.dispatchEvent(new Event('animationend'))
      await Promise.resolve()
    })
    await settle()
    expect(leaving()).toBeNull()
    expect(band().hasAttribute('inert')).toBe(false)
    expect(document.activeElement).toBe(opener)
  })

  it('closes on Not now and leaves the band up', async () => {
    render(view(state('linux')))
    click(setDefaultButton())
    await settle()
    click(buttons(dialog()!)[0])
    await settle()
    expect(dialog()).toBeNull()
    expect(cmd).not.toHaveBeenCalledWith('defaultBrowser.request', expect.anything())
    expect(run).not.toHaveBeenCalledWith('settings.update', expect.anything())
    expect(container.querySelector('.zen-band')).not.toBeNull()
    expect(chooseBand(bandStore.get())).not.toBeNull()
  })

  it('runs the request from the band and takes the band down for this release on Set as default', async () => {
    render(view(state('linux')))
    click(setDefaultButton())
    await settle()
    click(buttons(dialog()!)[1])
    await settle()
    expect(cmd).toHaveBeenCalledWith('defaultBrowser.request', { source: 'banner' })
    expect(run).toHaveBeenCalledWith('settings.update', {
      defaultBrowserPromptDismissed: '0.3.77'
    })
    expect(dialog()).toBeNull()
    expect(uiStore.get().defaultBrowserAsk).toBeNull()
    expect(uiStore.get().defaultBrowserPrompt).toBe(false)
    // The settings come back with the answer: the state ends, and with it the band.
    render(view(state('linux', '0.3.77')))
    expect(chooseBand(bandStore.get())).toBeNull()
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
    // desktop `AskDialog`'s order, the one composition (§9.23).
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
