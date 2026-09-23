// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Tab, UIState } from '@shared/types'
import type { SiteInfoSnapshot } from '@shared/siteInfo'

/*
 * The site-information popover's two confirmations – "Clear site data?" one level in from the
 * overview, "Clear cookies?" one in from the cookies level (components/siteControls/
 * SiteInfoPopover.tsx `ConfirmLevel`) – wear the confirmation primitive's keyboard (§9.22 as
 * amended on #392; `useConfirmKeyboard`, W4-14): the level holds its container as it comes, no
 * verb preselected (not Cancel, which `Level`'s first-control rule would arm); Tab enters at
 * Cancel and Shift+Tab at the danger verb; Enter from the held container is inert – a
 * destructive prompt has no default – and confirms nothing; Escape is one hop back to the level
 * the confirmation came from, the popover staying up, with the focus on the footer verb that
 * opened it, as Cancel's button does – the control recorded as the level was pushed, found again
 * by name in the re-mounted footer, the footer's first danger verb only as the fallback (#413
 * A2); each landing is ONE move – `Level`'s `focus` names the container on the way in and the
 * opener on the way back, nothing queued behind a first-control focus (#413 ruling 5) – and the
 * deed is in the danger ink (`data-danger`), no primary. The primitive's own contract is
 * dialogs/__tests__/confirmDialog.test.tsx's.
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const cmd = vi.fn<(name: string, args?: unknown) => Promise<unknown>>()
vi.mock('@renderer/lib/api', () => ({
  cmd: (name: string, args?: unknown) => cmd(name, args),
  run: vi.fn(),
  onEvent: vi.fn(() => () => undefined)
}))

const { closeAllPopovers } = await import('@renderer/lib/portals')
const { SiteInfoPopover } = await import('../SiteInfoPopover')

const snapshot: SiteInfoSnapshot = {
  tabId: 't1',
  url: 'https://example.com/',
  host: 'example.com',
  site: 'example.com',
  origin: 'https://example.com',
  containerId: 'default',
  security: { state: 'secure', certificate: null, mixedContent: false },
  cookies: {
    items: [
      {
        name: 'sid',
        domain: 'example.com',
        path: '/',
        secure: true,
        httpOnly: true,
        session: false,
        size: 24
      },
      {
        name: 'lang',
        domain: '.example.com',
        path: '/',
        secure: false,
        httpOnly: false,
        session: true,
        size: 7
      }
    ],
    thirdParty: []
  },
  storage: {
    usageBytes: null,
    quotaBytes: null,
    origins: [],
    localStorageItems: null,
    sessionStorageItems: null,
    serviceWorkers: null
  },
  permissions: [],
  siteData: { state: 'default', pattern: null, addable: '[*.]example.com', default: 'allow' },
  blocking: { blockedCount: 0, enabled: false, excepted: false, available: false },
  isPrivate: false
}

const tab = {
  id: 't1',
  url: 'https://example.com/',
  title: 'Example',
  loading: false,
  favicon: null,
  containerId: 'default'
} as unknown as Tab
const state = {
  platform: 'linux',
  tabs: { t1: tab },
  containers: [{ id: 'default', name: 'No Container', color: 'toolbar', icon: 'circle' }],
  extensions: [],
  deviceGrants: [],
  siteData: { clearsAtNextLaunch: false },
  settings: {}
} as unknown as UIState

let root: Root | null = null
let mount: HTMLElement | null = null
const onDismiss = vi.fn()

function render(el: ReactElement): void {
  mount = document.createElement('div')
  document.body.appendChild(mount)
  root = createRoot(mount)
  act(() => root!.render(el))
}

/** The snapshot arrives, the level mounts, the effects and their microtasks settle. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

const popover = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('[data-testid="site-info"]')
const level = (name: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(`[data-confirm="${name}"]`)
const buttonNamed = (text: string): HTMLButtonElement => {
  const all = [...popover()!.querySelectorAll<HTMLButtonElement>('button')]
  const found = all.find((b) => b.textContent === text)
  expect(found, text).toBeDefined()
  return found!
}
/** A click as the mouse alone delivers it here: no focus moves (happy-dom has no mousedown focus). */
const clickOnly = (el: Element): void => {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}
/** A click as Chromium delivers it: the control takes the focus on mousedown, then the click. */
const click = (el: Element): void => {
  if (el instanceof HTMLElement && el.tabIndex >= 0) act(() => el.focus())
  clickOnly(el)
}
function press(from: Element, key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
  act(() => {
    from.dispatchEvent(e)
  })
  return e
}
const pressEscape = (): void => {
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })
}

async function open(): Promise<void> {
  render(
    <SiteInfoPopover
      tab={tab}
      state={state}
      anchor={{ x: 300, y: 40, width: 24, height: 24 }}
      bar={{ x: 200, y: 32, width: 600, height: 40 }}
      closing={false}
      onDismiss={onDismiss}
      onClosed={() => undefined}
    />
  )
  await settle()
  await settle()
}

beforeEach(() => {
  cmd.mockReset()
  cmd.mockImplementation((name) => {
    if (name === 'siteInfo.snapshot') return Promise.resolve(snapshot)
    if (name === 'site.clearCookies') return Promise.resolve({ removed: 2 })
    return Promise.resolve(null)
  })
  onDismiss.mockClear()
})

afterEach(async () => {
  act(() => root?.unmount())
  mount?.remove()
  root = null
  mount = null
  document.getElementById('zen-chrome-layer')?.remove()
  closeAllPopovers()
  await new Promise((resolve) => setTimeout(resolve, 0))
})

describe('the site-information popover’s confirmations', () => {
  it('"Clear site data?" holds its container as it comes – no verb preselected – with Cancel then the danger verb, no primary; Tab enters at Cancel, Shift+Tab at the verb; Enter from the container is inert', async () => {
    await open()
    expect(popover()!.dataset.level).toBe('overview')
    const opener = buttonNamed('Clear site data')
    expect(opener.hasAttribute('data-danger')).toBe(true)
    act(() => opener.focus())
    click(opener)
    await settle()
    const d = level('clear-data')!
    expect(d).not.toBeNull()
    expect(popover()!.dataset.level).toBe('clear-data')
    expect(d.tabIndex).toBe(-1)
    expect(d.dataset.destructive).toBe('true')
    expect(document.activeElement).toBe(d)
    const [cancel, verb] = [...d.querySelectorAll<HTMLButtonElement>('button')]
    expect(d.querySelectorAll('button')).toHaveLength(2)
    expect(cancel.textContent).toBe('Cancel')
    expect(verb.textContent).toBe('Clear site data')
    expect(verb.getAttribute('aria-label')).toBe('Confirm clear site data')
    expect(verb.classList.contains('zen-v2-button')).toBe(true)
    expect(verb.hasAttribute('data-danger')).toBe(true)
    expect(d.querySelector('[data-primary]')).toBeNull()
    // Enter from the held container: consumed, and nothing is cleared.
    expect(press(d, 'Enter').defaultPrevented).toBe(true)
    expect(cmd).not.toHaveBeenCalledWith('site.clearData', expect.anything())
    expect(document.activeElement).toBe(d)
    expect(level('clear-data')).toBe(d)
    // Tab → Cancel, Shift+Tab → the verb (the popover's wrap); a button's own Enter is its own.
    expect(press(d, 'Tab').defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(cancel)
    act(() => d.focus())
    expect(press(d, 'Tab', { shiftKey: true }).defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(verb)
    expect(press(verb, 'Enter').defaultPrevented).toBe(false)
    expect(cmd).not.toHaveBeenCalledWith('site.clearData', expect.anything())
    expect(onDismiss).not.toHaveBeenCalled()
  })

  it('Escape is one hop back to the overview with the focus on "Clear site data", the popover staying up; the next Escape is the popover’s', async () => {
    await open()
    click(buttonNamed('Clear site data'))
    await settle()
    expect(document.activeElement).toBe(level('clear-data'))
    pressEscape()
    await settle()
    expect(level('clear-data')).toBeNull()
    expect(popover()).not.toBeNull()
    expect(popover()!.dataset.level).toBe('overview')
    expect(onDismiss).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(buttonNamed('Clear site data'))
    pressEscape()
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('Cancel’s button goes back the same way; "Clear cookies?" returns to the cookies level’s "Clear cookies"', async () => {
    await open()
    click(buttonNamed('Clear site data'))
    await settle()
    click(buttonNamed('Cancel'))
    await settle()
    expect(popover()!.dataset.level).toBe('overview')
    expect(document.activeElement).toBe(buttonNamed('Clear site data'))

    // Into the cookies level, then its confirmation.
    const cookiesRow = [
      ...popover()!.querySelectorAll<HTMLElement>('button, [role="button"]')
    ].find((el) => el.textContent?.startsWith('Cookies and site data'))!
    click(cookiesRow)
    await settle()
    expect(popover()!.dataset.level).toBe('cookies')
    click(buttonNamed('Clear cookies'))
    await settle()
    const d = level('clear-cookies')!
    expect(document.activeElement).toBe(d)
    expect(d.querySelector('.zen-v2-title-block-title, h2')!.textContent).toBe('Clear cookies?')
    pressEscape()
    await settle()
    expect(popover()!.dataset.level).toBe('cookies')
    expect(document.activeElement).toBe(buttonNamed('Clear cookies'))
  })

  it('the verb’s own press confirms – site.clearCookies runs – and the level returns nothing of its own; while the deed is at work Cancel is disabled and Escape is inert', async () => {
    let finish: (value: { removed: number }) => void = () => undefined
    cmd.mockImplementation((name) => {
      if (name === 'siteInfo.snapshot') return Promise.resolve(snapshot)
      if (name === 'site.clearCookies') return new Promise((resolve) => (finish = resolve))
      return Promise.resolve(null)
    })
    await open()
    const cookiesRow = [
      ...popover()!.querySelectorAll<HTMLElement>('button, [role="button"]')
    ].find((el) => el.textContent?.startsWith('Cookies and site data'))!
    click(cookiesRow)
    await settle()
    click(buttonNamed('Clear cookies'))
    await settle()
    const d = level('clear-cookies')!
    const [cancel, verb] = [...d.querySelectorAll<HTMLButtonElement>('button')]
    click(verb)
    await settle()
    expect(cmd).toHaveBeenCalledWith('site.clearCookies', { tabId: 't1' })
    expect(verb.getAttribute('aria-busy')).toBe('true')
    expect(cancel.disabled).toBe(true)
    pressEscape()
    await settle()
    expect(level('clear-cookies')).toBe(d)
    expect(onDismiss).not.toHaveBeenCalled()
    await act(async () => {
      finish({ removed: 2 })
      await Promise.resolve()
    })
    await settle()
    await settle()
    expect(level('clear-cookies')).toBeNull()
    expect(popover()!.dataset.level).toBe('cookies')
  })

  it('each transition lands the keyboard in ONE move (#413 ruling 5): exactly one focusin as the confirmation comes, on its container; exactly one as it is cancelled, on the verb that opened it', async () => {
    await open()
    const landings: EventTarget[] = []
    const onFocusIn = (e: FocusEvent): void => {
      if (e.target) landings.push(e.target)
    }
    const opener = buttonNamed('Clear site data')
    act(() => opener.focus())
    document.addEventListener('focusin', onFocusIn)
    try {
      clickOnly(opener)
      await settle()
      const d = level('clear-data')!
      expect(document.activeElement).toBe(d)
      expect(landings).toEqual([d])

      landings.length = 0
      pressEscape()
      await settle()
      expect(popover()!.dataset.level).toBe('overview')
      const back = buttonNamed('Clear site data')
      expect(document.activeElement).toBe(back)
      expect(landings).toEqual([back])

      // Into the cookies level (a list level: its first control, the back button, one landing),
      // its confirmation, and Cancel's button back – one move each.
      landings.length = 0
      const cookiesRow = [
        ...popover()!.querySelectorAll<HTMLElement>('button, [role="button"]')
      ].find((el) => el.textContent?.startsWith('Cookies and site data'))!
      clickOnly(cookiesRow)
      await settle()
      expect(popover()!.dataset.level).toBe('cookies')
      expect(landings).toHaveLength(1)
      expect(landings[0]).toBe(document.activeElement)

      const cookiesOpener = buttonNamed('Clear cookies')
      act(() => cookiesOpener.focus())
      landings.length = 0
      clickOnly(cookiesOpener)
      await settle()
      const c = level('clear-cookies')!
      expect(document.activeElement).toBe(c)
      expect(landings).toEqual([c])

      const cancel = buttonNamed('Cancel')
      act(() => cancel.focus())
      landings.length = 0
      clickOnly(cancel)
      await settle()
      expect(popover()!.dataset.level).toBe('cookies')
      const cookiesBack = buttonNamed('Clear cookies')
      expect(document.activeElement).toBe(cookiesBack)
      expect(landings).toEqual([cookiesBack])
    } finally {
      document.removeEventListener('focusin', onFocusIn)
    }
  })

  it('the return is to the control that opened the level – recorded as it was pushed and found again by name in the re-mounted footer, not the footer’s first danger verb; only an open that recorded nothing falls to that heuristic', async () => {
    await open()
    // A decoy: a foreign footer standing first in the popover, with a danger verb of its own – the
    // first `[data-footer] .zen-v2-button[data-danger]` in the document, so the heuristic alone
    // would land on it.
    const decoy = document.createElement('div')
    decoy.dataset.footer = 'panel'
    decoy.innerHTML = '<button class="zen-v2-button" data-danger type="button">Clear other</button>'
    popover()!.prepend(decoy)
    const decoyVerb = decoy.querySelector('button')!

    // Opened from the focused verb (the keyboard's path; the mouse's too, Chromium focusing a
    // button on mousedown): recorded as the level is pushed.
    const opener = buttonNamed('Clear site data')
    click(opener)
    await settle()
    expect(document.activeElement).toBe(level('clear-data'))
    // One level at a time: the recorded element is out of the document while the level stands.
    expect(opener.isConnected).toBe(false)
    pressEscape()
    await settle()
    expect(popover()!.dataset.level).toBe('overview')
    const back = buttonNamed('Clear site data')
    expect(back).not.toBe(opener)
    expect(document.activeElement).toBe(back)
    expect(document.activeElement).not.toBe(decoyVerb)

    // Opened with nothing tellable holding the focus (a click that moved none, the focus on
    // body): nothing recorded, and the return falls to the heuristic – the first danger verb, the
    // decoy.
    act(() => back.blur())
    expect(document.activeElement).toBe(document.body)
    clickOnly(back)
    await settle()
    expect(document.activeElement).toBe(level('clear-data'))
    pressEscape()
    await settle()
    expect(popover()!.dataset.level).toBe('overview')
    expect(document.activeElement).toBe(decoyVerb)
    decoy.remove()
  })
})
