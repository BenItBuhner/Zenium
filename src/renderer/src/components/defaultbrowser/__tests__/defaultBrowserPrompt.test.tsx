// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Platform, UIState } from '@shared/types'
import { FrameDialogHost } from '@renderer/lib/portals'
import { browserStore, uiStore } from '@renderer/lib/ui'
import { describeDefaultBrowserRequest } from '@renderer/lib/defaultBrowser'

/*
 * The desktop's default-browser surfaces on v2 (styling pass 5): the strip under the toolbar –
 * a window surface with no glyph, Not now then the primary Make default (§9.11, §9.29) – and
 * the prompt its Make default raises before the OS hand-off (`AskDialog` in
 * DefaultBrowserPrompt.tsx): the §9.23 composition on the frame's dialog host with the app icon
 * at 48 over the title block, one sentence per OS, focus on the primary, Escape closing it and
 * giving focus back to the strip's button, the primary running the request and taking the
 * strip down for this release.
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const run = vi.fn()
const cmd = vi.fn<(name: string, args: unknown) => Promise<unknown>>()
vi.mock('@renderer/lib/api', () => ({
  run: (...args: unknown[]) => run(...args),
  cmd: (name: string, args: unknown) => cmd(name, args),
  onEvent: () => () => undefined
}))

const { DefaultBrowserBanner } = await import('../../content/DefaultBrowserBanner')
const { DefaultBrowserLayer } = await import('../DefaultBrowserPrompt')

function state(platform: Platform): UIState {
  return {
    platform,
    version: '0.3.77',
    tabs: {},
    spaces: [{ id: 's1', activeTabId: null, tabIds: [] }],
    activeSpaceId: 's1',
    essentialTabIds: [],
    settings: { appIcon: 'indigo', defaultBrowserPromptDismissed: null, onboardingDone: true },
    capabilities: { defaultBrowser: true },
    defaultBrowser: { isDefault: false, prompt: null },
    window: { kind: 'normal', fullscreen: false }
  } as unknown as UIState
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
    <DefaultBrowserBanner state={s} />
    <DefaultBrowserLayer />
  </>
)

beforeEach(() => {
  run.mockClear()
  cmd.mockReset()
  cmd.mockResolvedValue(true)
  uiStore.set({ defaultBrowserAsk: null, defaultBrowserPrompt: false })
  browserStore.set({ state: state('linux') })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  uiStore.set({ defaultBrowserAsk: null, defaultBrowserPrompt: false })
})

describe('the default-browser strip', () => {
  it('is a window surface with the sentence, no glyph, and Not now before the primary Make default', () => {
    render(view(state('linux')))
    const strip = container.querySelector<HTMLElement>('.zen-frame-strip')!
    expect(strip.getAttribute('data-surface')).toBe('window')
    expect(strip.getAttribute('role')).toBe('status')
    expect(strip.querySelector('svg')).toBeNull()
    expect(strip.querySelector('.zen-frame-strip-text')!.textContent).toBe(
      'Make Zenium your default browser'
    )
    const [notNow, makeDefault] = buttons(strip)
    expect(buttons(strip)).toHaveLength(2)
    expect(notNow.textContent).toBe('Not now')
    expect(notNow.classList.contains('zen-v2-button')).toBe(true)
    expect(notNow.hasAttribute('data-primary')).toBe(false)
    expect(makeDefault.textContent).toBe('Make default')
    expect(makeDefault.classList.contains('zen-v2-button')).toBe(true)
    expect(makeDefault.hasAttribute('data-primary')).toBe(true)
  })

  it('remembers Not now for this feature release and asks nothing of the OS', () => {
    render(view(state('linux')))
    click(buttons(container.querySelector('.zen-frame-strip')!)[0])
    expect(run).toHaveBeenCalledWith('settings.update', {
      defaultBrowserPromptDismissed: '0.3.77'
    })
    expect(cmd).not.toHaveBeenCalled()
    expect(uiStore.get().defaultBrowserAsk).toBeNull()
  })

  it('raises the prompt on Make default instead of handing off blind', () => {
    render(view(state('linux')))
    click(buttons(container.querySelector('.zen-frame-strip')!)[1])
    expect(uiStore.get().defaultBrowserAsk).toBe('banner')
    expect(cmd).not.toHaveBeenCalledWith('defaultBrowser.request', expect.anything())
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
    click(buttons(container.querySelector('.zen-frame-strip')!)[1])
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
    const [notNow, makeDefault] = buttons(d)
    expect(buttons(d)).toHaveLength(2)
    expect(notNow.textContent).toBe('Not now')
    expect(makeDefault.textContent).toBe('Make default')
    expect(makeDefault.hasAttribute('data-primary')).toBe(true)
    expect(document.activeElement).toBe(makeDefault)
    // Up over the page's picture: the host hides the view meanwhile.
    expect(uiStore.get().defaultBrowserPrompt).toBe(true)
  })

  it('closes on Escape without asking the OS, and focus goes back to the strip’s button once the chrome is back', async () => {
    render(view(state('linux')))
    const strip = container.querySelector<HTMLElement>('.zen-frame-strip')!
    const opener = buttons(strip)[1]
    act(() => opener.focus())
    click(opener)
    await settle()
    expect(dialog()).not.toBeNull()
    // The strip is window chrome: inert under the dialog (§9.5, §9.22).
    expect(strip.hasAttribute('inert')).toBe(true)
    escape()
    await settle()
    expect(dialog()).toBeNull()
    expect(uiStore.get().defaultBrowserAsk).toBeNull()
    expect(uiStore.get().defaultBrowserPrompt).toBe(false)
    expect(cmd).not.toHaveBeenCalledWith('defaultBrowser.request', expect.anything())
    expect(run).not.toHaveBeenCalledWith('settings.update', expect.anything())
    // The host keeps the panel through its pop exit, inert and hidden from assistive technology,
    // and the chrome stays inert with it (#188): the strip cannot take the focus back yet.
    const panel = leaving()!
    expect(panel).not.toBeNull()
    expect(panel.hasAttribute('inert')).toBe(true)
    expect(panel.getAttribute('aria-hidden')).toBe('true')
    expect(strip.hasAttribute('inert')).toBe(true)
    expect(document.activeElement).toBe(document.body)
    // The exit ends: the panel goes, the chrome comes back and the opener takes the focus.
    await act(async () => {
      panel.dispatchEvent(new Event('animationend'))
      await Promise.resolve()
    })
    await settle()
    expect(leaving()).toBeNull()
    expect(strip.hasAttribute('inert')).toBe(false)
    expect(document.activeElement).toBe(opener)
  })

  it('closes on Not now and leaves the strip up', async () => {
    render(view(state('linux')))
    click(buttons(container.querySelector('.zen-frame-strip')!)[1])
    await settle()
    click(buttons(dialog()!)[0])
    await settle()
    expect(dialog()).toBeNull()
    expect(cmd).not.toHaveBeenCalledWith('defaultBrowser.request', expect.anything())
    expect(run).not.toHaveBeenCalledWith('settings.update', expect.anything())
    expect(container.querySelector('.zen-frame-strip')).not.toBeNull()
  })

  it('runs the request from the strip and takes the strip down for this release on Make default', async () => {
    render(view(state('linux')))
    click(buttons(container.querySelector('.zen-frame-strip')!)[1])
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
  })
})
