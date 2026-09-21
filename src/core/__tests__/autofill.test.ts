import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FormsCommand, FormsEvent } from '../../shared/forms'
import type { Rect, Tab } from '../../shared/types'
import { emptyPasswordsDevice } from '../../shared/types'
import { sanitizeAutofillSettings, sanitizePasswordSettings } from '../../shared/defaults'
import { AutofillService } from '../autofill'
import type { Browser } from '../browser'
import { PasswordService } from '../credentials/service'
import { FakeKeyWrap, MemoryIO } from '../credentials/__tests__/fakes'
import type { AutofillHost, ReauthHost, SystemAutofillStatus } from '../platform'

/** A tab's view: remembers the forms commands the core sent it. */
class FakeView {
  commands: FormsCommand[] = []
  destroyed = false
  isDestroyed(): boolean {
    return this.destroyed
  }
  sendFormsCommand(command: FormsCommand): void {
    this.commands.push(command)
  }
  executeJavaScript = vi.fn<(code: string) => Promise<undefined>>(async () => undefined)
  fills(): Extract<FormsCommand, { type: 'fill' }>[] {
    return this.commands.filter(
      (c): c is Extract<FormsCommand, { type: 'fill' }> => c.type === 'fill'
    )
  }
}

class FakeReauth implements ReauthHost {
  enabled = false
  answer = true
  verified: string[] = []
  async available(): Promise<boolean> {
    return this.enabled
  }
  async verify(reason: string): Promise<boolean> {
    this.verified.push(reason)
    return this.answer
  }
}

class FakeAutofillHost implements AutofillHost {
  status: SystemAutofillStatus = { enabled: false, service: null }
  providers: string[] = []
  listener: ((status: SystemAutofillStatus) => void) | null = null
  async systemStatus(): Promise<SystemAutofillStatus> {
    return this.status
  }
  setProvider(provider: 'system' | 'zenium'): void {
    this.providers.push(provider)
  }
  onSystemStatusChanged(listener: (status: SystemAutofillStatus) => void): void {
    this.listener = listener
  }
}

const VIEW_RECT: Rect = { x: 0, y: 84, width: 1200, height: 700 }

/**
 * The host's network as the leak check and the change-password probe see it: a range request
 * answers with the fixture for its prefix ('' when none: clean), null fails it; a well-known
 * probe answers whether its URL is in `probes`.
 */
interface FakeNet {
  ranges: Record<string, string | null>
  probes: Record<string, boolean>
  requests: string[]
  /** A range request waits on this before it answers: the check caught in flight. */
  hold: Promise<void> | null
}

interface World {
  browser: Browser
  autofill: AutofillService
  passwords: PasswordService
  reauth: FakeReauth
  io: MemoryIO
  keys: FakeKeyWrap
  clipboard: { writeText: ReturnType<typeof vi.fn>; clearText: ReturnType<typeof vi.fn> }
  confirm: ReturnType<typeof vi.fn>
  toast: ReturnType<typeof vi.fn>
  net: FakeNet
  /** `state.commit` (the device-local checkup summary is written through it). */
  commit: ReturnType<typeof vi.fn>
  navigate: ReturnType<typeof vi.fn>
  openPage: ReturnType<typeof vi.fn>
  tabs: Map<string, Tab>
  views: Map<string, FakeView>
  /** The window's popup surface (a host with one): where the picker was placed, focus calls. */
  win: { setPopupSurface: ReturnType<typeof vi.fn>; focusContent: ReturnType<typeof vi.fn> }
  addTab: (id: string, url: string, containerId?: string) => FakeView
  /** Deliver a forms event from the page of `tabId`. */
  event: (tabId: string, event: FormsEvent) => void
  settle: () => Promise<void>
}

/** Just enough of a `Browser` for the autofill service and the password service under it. */
function setup(
  options: {
    autofillHost?: FakeAutofillHost
    locales?: string[]
    io?: MemoryIO
    keys?: FakeKeyWrap
    /** The window can float the popup surface (desktop). */
    popupSurface?: boolean
  } = {}
): World {
  const io = options.io ?? new MemoryIO()
  const keys = options.keys ?? new FakeKeyWrap()
  const reauth = new FakeReauth()
  const tabs = new Map<string, Tab>()
  const views = new Map<string, FakeView>()
  const clipboard = {
    writeText: vi.fn(),
    clearText: vi.fn(async () => undefined),
    writeImageFromUrl: vi.fn()
  }
  const confirm = vi.fn(async () => true)
  const toast = vi.fn()
  const net: FakeNet = { ranges: {}, probes: {}, requests: [], hold: null }
  const fetchText = async (url: string): Promise<{ ok: boolean; status: number; text: string }> => {
    net.requests.push(url)
    const range = url.match(/\/range\/([0-9A-F]{5})$/i)
    if (range) {
      if (net.hold) await net.hold
      const text = net.ranges[range[1].toUpperCase()]
      if (text === null) return { ok: false, status: 503, text: '' }
      return { ok: true, status: 200, text: text ?? '' }
    }
    return net.probes[url]
      ? { ok: true, status: 200, text: '' }
      : { ok: false, status: 404, text: '' }
  }
  const commit = vi.fn()
  const navigate = vi.fn()
  const openPage = vi.fn()
  const win = {
    viewRect: () => VIEW_RECT,
    hasPopupSurface: options.popupSurface === true,
    viewportSize: () => ({ width: 1280, height: 800 }),
    setPopupSurface: vi.fn(),
    focusContent: vi.fn()
  }
  const browser = {
    platform: {
      io,
      clipboard,
      dialogs: { confirm },
      autofill: options.autofillHost,
      translate: { locales: options.locales ?? ['en-US'] },
      net: { fetchText }
    },
    state: {
      settings: {
        passwords: sanitizePasswordSettings(undefined),
        autofill: sanitizeAutofillSettings(undefined)
      },
      passwordsDevice: emptyPasswordsDevice(),
      commit,
      commitVolatile: vi.fn()
    },
    history: { faviconsByDomain: () => new Map<string, string>() },
    pages: { open: openPage },
    toast,
    tabs: {
      tab: (id: string) => tabs.get(id),
      view: (id: string) => views.get(id),
      windowFor: () => win,
      isPrivate: (tab: Tab) => tab.containerId === 'private',
      allViews: () => views.entries(),
      navigate
    }
  } as unknown as Browser & { passwords: PasswordService; autofill: AutofillService }
  const passwords = new PasswordService(browser, { keys, reauth })
  browser.passwords = passwords
  const autofill = new AutofillService(browser)
  autofill.nativePrompts = false
  browser.autofill = autofill
  const addTab = (id: string, url: string, containerId = 'default'): FakeView => {
    tabs.set(id, { id, url, containerId, zoom: 1, errorCode: null } as Tab)
    const view = new FakeView()
    views.set(id, view)
    return view
  }
  // Wait for the work itself (the vault's start-up unlock, then whatever the page events set
  // off, prompts included), not a guessed number of ticks: the store's crypto takes longer than
  // five on a loaded runner.
  const settle = async (): Promise<void> => {
    await passwords.whenSettled()
    await autofill.whenSettled()
    await passwords.leaks.whenSettled()
  }
  return {
    browser,
    autofill,
    passwords,
    reauth,
    io,
    keys,
    clipboard,
    confirm,
    toast,
    net,
    commit,
    navigate,
    openPage,
    tabs,
    views,
    win,
    addTab,
    event: (tabId, event) => autofill.handleEvent(tabId, event),
    settle
  }
}

const FIELD: Rect = { x: 100, y: 200, width: 240, height: 32 }

function focusLogin(
  overrides: Partial<Extract<FormsEvent, { type: 'focus' }>> = {}
): Extract<FormsEvent, { type: 'focus' }> {
  return {
    type: 'focus',
    group: 'login',
    formId: 'f1',
    fieldId: 'f2',
    kind: 'username',
    rect: FIELD,
    hasValue: false,
    fields: [
      { id: 'f2', kind: 'username', hasValue: false },
      { id: 'f3', kind: 'password', hasValue: false }
    ],
    ...overrides
  }
}

function loginSubmit(
  overrides: Partial<Extract<FormsEvent, { type: 'submit'; group: 'login' }>> = {}
): Extract<FormsEvent, { type: 'submit'; group: 'login' }> {
  return {
    type: 'submit',
    group: 'login',
    formId: 'f1',
    username: 'ada',
    password: 'hunter2',
    newPassword: false,
    ...overrides
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('AutofillService: the account picker', () => {
  it('opens a picker anchored in the chrome for a field with saved logins, and closes it on blur', async () => {
    const w = setup()
    await w.passwords.unlock()
    w.passwords.add({ url: 'https://example.com/login', username: 'ada', password: 'pw-a' })
    w.passwords.add({
      url: 'https://accounts.example.com/login',
      username: 'sib',
      password: 'pw-s'
    })
    w.addTab('t1', 'https://example.com/login')

    w.event('t1', focusLogin())
    const picker = w.autofill.uiState().picker
    expect(picker).not.toBeNull()
    expect(picker).toMatchObject({
      tabId: 't1',
      group: 'login',
      field: 'username',
      manageLabel: 'Manage passwords'
    })
    expect(picker?.anchor).toEqual({ x: 100, y: 284, width: 240, height: 32 })
    expect(picker?.items.map((i) => [i.title, i.subtitle])).toEqual([
      ['ada', ''],
      ['sib', 'accounts.example.com']
    ])
    // No OS re-authentication and no passphrase yet: the picker does not claim a passphrase step.
    expect(picker?.items[0].needsPassphrase).toBe(false)

    vi.useFakeTimers()
    w.event('t1', { type: 'blur' })
    expect(w.autofill.uiState().picker).not.toBeNull()
    await vi.advanceTimersByTimeAsync(500)
    expect(w.autofill.uiState().picker).toBeNull()
  })

  it('follows the field when the page scrolls and closes on navigation', () => {
    const w = setup()
    w.addTab('t1', 'https://example.com/login')
    void w.passwords.unlock()
    return (async () => {
      await w.passwords.unlock()
      w.passwords.add({ url: 'https://example.com', username: 'ada', password: 'pw' })
      w.event('t1', focusLogin())
      w.event('t1', { type: 'moved', fieldId: 'f2', rect: { ...FIELD, y: 20 } })
      expect(w.autofill.uiState().picker?.anchor.y).toBe(104)
      w.autofill.onNavigated('t1')
      expect(w.autofill.uiState().picker).toBeNull()
    })()
  })

  it('shows nothing for a locked vault, for a site without logins, or in a new-password field', async () => {
    const w = setup()
    w.addTab('t1', 'https://example.com/login')
    w.event('t1', focusLogin())
    expect(w.autofill.uiState().picker).toBeNull()
    await w.passwords.unlock()
    w.event('t1', focusLogin())
    expect(w.autofill.uiState().picker).toBeNull()
    w.passwords.add({ url: 'https://example.com', username: 'ada', password: 'pw' })
    w.event('t1', focusLogin({ kind: 'new-password' }))
    expect(w.autofill.uiState().picker).toBeNull()
    w.event('t1', focusLogin({ kind: 'password' }))
    expect(w.autofill.uiState().picker?.items).toHaveLength(1)
  })

  it('fills the picked login through the OS re-authentication once per session and marks it used', async () => {
    const w = setup()
    w.reauth.enabled = true
    w.passwords.start()
    await w.settle()
    await w.passwords.unlock()
    const saved = w.passwords.add({
      url: 'https://example.com/login',
      username: 'ada',
      password: 'hunter2'
    })
    const view = w.addTab('t1', 'https://example.com/login')
    w.event('t1', focusLogin())
    const picker = w.autofill.uiState().picker!
    expect(await w.autofill.pick(picker.id, saved.id)).toEqual({ status: 'ok', value: null })
    expect(w.reauth.verified).toEqual(['Fill the password for example.com'])
    expect(view.fills()).toEqual([
      {
        type: 'fill',
        formId: 'f1',
        values: { username: 'ada', password: 'hunter2' },
        labels: undefined
      }
    ])
    expect(w.autofill.uiState().picker).toBeNull()
    expect(w.passwords.store.get(saved.id)?.lastUsedAt).not.toBeNull()

    // The grace period has passed; the session's authorisation still holds for fills.
    w.browser.state.settings.passwords.reauthGraceSeconds = 0
    w.event('t1', focusLogin())
    await w.autofill.pick(w.autofill.uiState().picker!.id, saved.id)
    expect(w.reauth.verified).toHaveLength(1)
    expect(view.fills()).toHaveLength(2)
  })

  it('refuses a fill the user did not authorise, and closes with null', async () => {
    const w = setup()
    w.reauth.enabled = true
    w.reauth.answer = false
    w.passwords.start()
    await w.settle()
    await w.passwords.unlock()
    const saved = w.passwords.add({
      url: 'https://example.com/login',
      username: 'ada',
      password: 'hunter2'
    })
    const view = w.addTab('t1', 'https://example.com/login')
    w.event('t1', focusLogin())
    const picker = w.autofill.uiState().picker!
    expect(await w.autofill.pick(picker.id, saved.id)).toEqual({ status: 'denied' })
    expect(view.fills()).toEqual([])
    expect(w.autofill.uiState().picker).toBeNull()

    w.event('t1', focusLogin())
    const again = w.autofill.uiState().picker!
    expect(await w.autofill.pick('stale', saved.id)).toEqual({ status: 'denied' })
    expect(await w.autofill.pick(again.id, null)).toEqual({ status: 'ok', value: null })
    expect(w.autofill.uiState().picker).toBeNull()
  })

  it('asks for the vault passphrase when that is the only gate, keeps the picker, and fills with it', async () => {
    const w = setup()
    await w.passwords.unlock()
    const saved = w.passwords.add({
      url: 'https://example.com/login',
      username: 'ada',
      password: 'hunter2'
    })
    await w.passwords.setPassphrase('open sesame please', undefined)
    w.browser.state.settings.passwords.reauthGraceSeconds = 0
    const view = w.addTab('t1', 'https://example.com/login')
    w.event('t1', focusLogin())
    const picker = w.autofill.uiState().picker!
    expect(picker.items[0].needsPassphrase).toBe(true)
    expect(await w.autofill.pick(picker.id, saved.id)).toEqual({ status: 'passphrase' })
    expect(w.autofill.uiState().picker?.id).toBe(picker.id)
    expect(await w.autofill.pick(picker.id, saved.id, 'wrong')).toEqual({ status: 'denied' })
    w.event('t1', focusLogin())
    const second = w.autofill.uiState().picker!
    expect(await w.autofill.pick(second.id, saved.id, 'open sesame please')).toEqual({
      status: 'ok',
      value: null
    })
    expect(view.fills()).toHaveLength(1)
  })

  it('signs in automatically with the one saved login when the setting is on, once per page', async () => {
    const w = setup()
    w.browser.state.settings.passwords.autoSignIn = true
    w.reauth.enabled = true
    w.passwords.start()
    await w.settle()
    await w.passwords.unlock()
    w.passwords.add({ url: 'https://example.com/login', username: 'ada', password: 'hunter2' })
    const view = w.addTab('t1', 'https://example.com/login')
    w.event('t1', focusLogin())
    await w.settle()
    expect(w.autofill.uiState().picker).toBeNull()
    expect(view.fills()).toHaveLength(1)
    // Focusing again on the same page opens the picker instead of filling again.
    w.event('t1', focusLogin({ hasValue: true }))
    await w.settle()
    expect(view.fills()).toHaveLength(1)
    expect(w.autofill.uiState().picker).not.toBeNull()
    // A second saved login: no automatic choice.
    w.passwords.add({ url: 'https://example.com/login', username: 'bob', password: 'x' })
    w.autofill.onNavigated('t1')
    w.event('t1', focusLogin())
    await w.settle()
    expect(view.fills()).toHaveLength(1)
    expect(w.autofill.uiState().picker?.items).toHaveLength(2)
  })

  it('falls back to the picker when the automatic sign-in cannot be authorized', async () => {
    const w = setup()
    w.browser.state.settings.passwords.autoSignIn = true
    await w.passwords.unlock()
    w.passwords.add({ url: 'https://example.com/login', username: 'ada', password: 'hunter2' })
    await w.passwords.setPassphrase('open sesame please', undefined)
    w.browser.state.settings.passwords.reauthGraceSeconds = 0
    const view = w.addTab('t1', 'https://example.com/login')
    // The page moved on while the gate was pending: no picker for a field that is gone.
    w.event('t1', focusLogin())
    w.autofill.onNavigated('t1')
    await w.settle()
    expect(w.autofill.uiState().picker).toBeNull()
    expect(view.fills()).toEqual([])

    w.event('t1', focusLogin())
    await w.settle()
    expect(view.fills()).toEqual([])
    const picker = w.autofill.uiState().picker!
    expect(picker.items.map((i) => i.needsPassphrase)).toEqual([true])
    expect(await w.autofill.pick(picker.id, picker.items[0].id, 'open sesame please')).toEqual({
      status: 'ok',
      value: null
    })
    expect(view.fills()).toHaveLength(1)
  })

  it('offers addresses and cards for their fields, honouring the autofill settings', async () => {
    const w = setup()
    w.reauth.enabled = true
    w.passwords.start()
    await w.settle()
    await w.passwords.unlock()
    const address = w.autofill.addAddress({
      country: 'US',
      name: 'Ada Lovelace',
      organization: '',
      streetAddress: '1600 Amphitheatre Pkwy\nBuilding 43',
      locality: 'Mountain View',
      region: 'CA',
      postalCode: '94043',
      sortingCode: '',
      phone: '555',
      email: ''
    })
    const card = w.autofill.addCard({
      number: '4242 4242 4242 4242',
      expMonth: 3,
      expYear: 29,
      name: 'Ada',
      nickname: ''
    })
    expect(card).toMatchObject({ last4: '4242', network: 'visa', expYear: 2029, expired: false })
    const view = w.addTab('t1', 'https://shop.example/checkout')

    w.event('t1', focusLogin({ group: 'address', kind: 'address-line1', fields: [] }))
    let picker = w.autofill.uiState().picker!
    expect(picker.items.map((i) => [i.title, i.subtitle])).toEqual([
      ['Ada Lovelace', '1600 Amphitheatre Pkwy, Building 43, Mountain View, CA 94043']
    ])
    expect(picker.manageLabel).toBe('Manage addresses')
    await w.autofill.pick(picker.id, address.id)
    expect(w.reauth.verified).toEqual([])
    expect(view.fills().at(-1)).toMatchObject({
      formId: 'f1',
      values: {
        'address-line1': '1600 Amphitheatre Pkwy',
        'address-line2': 'Building 43',
        'address-level1': 'CA',
        tel: '555'
      },
      labels: { countryName: 'United States', regionName: 'California' }
    })

    w.event('t1', focusLogin({ group: 'card', kind: 'cc-number', fields: [] }))
    picker = w.autofill.uiState().picker!
    expect(picker.items.map((i) => [i.title, i.subtitle])).toEqual([
      ['Visa •••• 4242', 'Ada, 03/29']
    ])
    await w.autofill.pick(picker.id, card.id)
    expect(w.reauth.verified).toEqual(['Fill the card ending in 4242'])
    expect(view.fills().at(-1)?.values).toEqual({
      'cc-number': '4242424242424242',
      'cc-exp': '03/2029',
      'cc-exp-month': '03',
      'cc-exp-year': '2029',
      'cc-name': 'Ada'
    })

    w.browser.state.settings.autofill.cards = false
    w.event('t1', focusLogin({ group: 'card', kind: 'cc-number', fields: [] }))
    expect(w.autofill.uiState().picker).toBeNull()
    w.browser.state.settings.autofill.addresses = false
    w.event('t1', focusLogin({ group: 'address', kind: 'postal-code', fields: [] }))
    expect(w.autofill.uiState().picker).toBeNull()
  })
})

describe('AutofillService: saving logins', () => {
  it('offers to save a submitted login once the page moved on, and saves on the answer', async () => {
    const w = setup()
    await w.passwords.unlock()
    w.addTab('t1', 'https://example.com/login')
    w.event('t1', loginSubmit())
    expect(w.autofill.uiState().prompts).toEqual([])
    w.tabs.get('t1')!.url = 'https://example.com/home'
    w.autofill.onNavigated('t1')
    await w.settle()
    const [prompt] = w.autofill.uiState().prompts
    expect(prompt).toMatchObject({
      kind: 'save-login',
      tabId: 't1',
      origin: 'https://example.com',
      site: 'example.com',
      username: 'ada',
      existingId: null
    })
    w.autofill.respond(prompt.id, { action: 'save', username: 'ada@example.com' })
    await w.settle()
    expect(w.autofill.uiState().prompts).toEqual([])
    const [saved] = w.passwords.store.list()
    expect(saved).toMatchObject({
      origin: 'https://example.com',
      url: 'https://example.com/login',
      username: 'ada@example.com',
      password: 'hunter2'
    })
    expect(w.toast).toHaveBeenCalledWith('Password saved', 'info', expect.anything())
  })

  it('offers an update for a changed password and records a use for an unchanged one', async () => {
    const w = setup()
    await w.passwords.unlock()
    const saved = w.passwords.add({
      url: 'https://example.com/login',
      username: 'ada',
      password: 'old'
    })
    w.addTab('t1', 'https://example.com/login')

    w.event('t1', loginSubmit({ password: 'old' }))
    w.autofill.onNavigated('t1')
    await w.settle()
    expect(w.autofill.uiState().prompts).toEqual([])
    expect(w.passwords.store.get(saved.id)?.lastUsedAt).not.toBeNull()

    w.event('t1', loginSubmit({ password: 'new' }))
    w.autofill.onNavigated('t1')
    await w.settle()
    const [prompt] = w.autofill.uiState().prompts
    expect(prompt).toMatchObject({ kind: 'update-login', existingId: saved.id, username: 'ada' })
    w.autofill.respond(prompt.id, { action: 'save' })
    await w.settle()
    expect(w.passwords.store.get(saved.id)?.password).toBe('new')
    expect(w.passwords.store.count()).toBe(1)
  })

  it('confirms a single-page sign-in through the settled event, and only for the submitted form', async () => {
    const w = setup()
    await w.passwords.unlock()
    w.addTab('t1', 'https://app.example/')
    w.event('t1', loginSubmit({ formId: 'f9' }))
    w.event('t1', { type: 'settled', formId: 'other' })
    await w.settle()
    expect(w.autofill.uiState().prompts).toEqual([])
    w.event('t1', { type: 'settled', formId: 'f9' })
    await w.settle()
    expect(w.autofill.uiState().prompts).toHaveLength(1)
  })

  it('stays quiet in private tabs, for never-save sites, when the setting is off, and after an error page', async () => {
    const w = setup()
    await w.passwords.unlock()
    w.addTab('p', 'https://example.com/login', 'private')
    w.event('p', loginSubmit())
    w.autofill.onNavigated('p')
    await w.settle()
    expect(w.autofill.uiState().prompts).toEqual([])

    w.addTab('t1', 'https://example.com/login')
    w.passwords.store.neverSaveAdd('https://example.com')
    w.event('t1', loginSubmit())
    w.autofill.onNavigated('t1')
    await w.settle()
    expect(w.autofill.uiState().prompts).toEqual([])

    w.passwords.store.neverSaveRemove('example.com')
    w.browser.state.settings.passwords.offerToSave = false
    w.event('t1', loginSubmit())
    w.autofill.onNavigated('t1')
    await w.settle()
    expect(w.autofill.uiState().prompts).toEqual([])

    w.browser.state.settings.passwords.offerToSave = true
    w.event('t1', loginSubmit())
    w.tabs.get('t1')!.errorCode = -105
    w.autofill.onNavigated('t1')
    await w.settle()
    expect(w.autofill.uiState().prompts).toEqual([])
  })

  it('puts a site on the never-save list on "never" and drops the prompt when the tab goes', async () => {
    const w = setup()
    await w.passwords.unlock()
    w.addTab('t1', 'https://example.com/login')
    w.event('t1', loginSubmit())
    w.autofill.onNavigated('t1')
    await w.settle()
    const [prompt] = w.autofill.uiState().prompts
    w.autofill.respond(prompt.id, { action: 'never' })
    await w.settle()
    expect(w.passwords.store.isNeverSave('https://example.com')).toBe(true)
    expect(w.passwords.store.count()).toBe(0)

    w.passwords.store.neverSaveRemove('example.com')
    w.event('t1', loginSubmit())
    w.autofill.onNavigated('t1')
    await w.settle()
    expect(w.autofill.uiState().prompts).toHaveLength(1)
    w.autofill.onTabGone('t1')
    await w.settle()
    expect(w.autofill.uiState().prompts).toEqual([])
    expect(w.passwords.store.count()).toBe(0)
  })

  it('unlocks a locked OS-protected vault silently before deciding, and renders prompts natively until a chrome takes over', async () => {
    const first = setup()
    await first.passwords.unlock()
    first.passwords.add({ url: 'https://example.com', username: 'ada', password: 'old' })
    await first.passwords.store.flush()
    first.passwords.lock()

    // A second process on the same device: same documents, same device key, vault still locked.
    const w = setup({ io: first.io, keys: first.keys })
    const again = w.passwords
    expect(again.store.exists()).toBe(true)
    expect(again.store.unlocked()).toBe(false)
    w.autofill.nativePrompts = true
    w.confirm.mockResolvedValueOnce(true)
    w.addTab('t1', 'https://example.com/login')
    w.event('t1', loginSubmit({ password: 'new' }))
    w.autofill.onNavigated('t1')
    await w.settle()
    expect(again.store.unlocked()).toBe(true)
    expect(w.confirm).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Update password for example.com?', okLabel: 'Update' }),
      expect.anything()
    )
    expect(again.store.list()[0]?.password).toBe('new')
    expect(w.autofill.uiState().prompts).toEqual([])
  })

  it('shows native prompts one at a time and skips those answered while they waited', async () => {
    const w = setup()
    await w.passwords.unlock()
    w.autofill.nativePrompts = true
    let release: (ok: boolean) => void = () => undefined
    w.confirm.mockImplementationOnce(() => new Promise<boolean>((resolve) => (release = resolve)))
    w.addTab('t1', 'https://shop.example/checkout')
    // A checkout submits its card and its address together.
    w.event('t1', {
      type: 'submit',
      group: 'card',
      formId: 'f1',
      values: { 'cc-number': '4111 1111 1111 1111', 'cc-exp': '12/2031', 'cc-name': 'Ada' }
    })
    w.event('t1', {
      type: 'submit',
      group: 'address',
      formId: 'f1',
      values: {
        name: 'Ada Lovelace',
        'address-line1': '1600 Amphitheatre Pkwy',
        'address-level2': 'Mountain View',
        'address-level1': 'CA',
        'postal-code': '94043',
        country: 'US'
      }
    })
    await w.settle()
    expect(w.autofill.uiState().prompts.map((p) => p.kind)).toEqual(['save-card', 'save-address'])
    expect(w.confirm).toHaveBeenCalledTimes(1)
    expect(w.confirm).toHaveBeenLastCalledWith(
      expect.objectContaining({ message: 'Save card?' }),
      expect.anything()
    )
    // The chrome answers the waiting address prompt itself: no second dialog for it.
    const address = w.autofill.uiState().prompts[1]
    w.autofill.respond(address.id, null)
    release(true)
    await w.settle()
    expect(w.confirm).toHaveBeenCalledTimes(1)
    expect(w.autofill.listCards()).toHaveLength(1)
    expect(w.autofill.listAddresses()).toHaveLength(0)
    expect(w.autofill.uiState().prompts).toEqual([])
  })
})

describe('AutofillService: addresses and cards from checkouts', () => {
  const addressValues = {
    name: 'Ada Lovelace',
    'address-line1': '1600 Amphitheatre Pkwy',
    'address-level2': 'Mountain View',
    'address-level1': '5|California',
    'postal-code': '94043',
    country: 'usa|United States',
    tel: '555'
  }

  it('offers to save a complete address and saves it', async () => {
    const w = setup()
    await w.passwords.unlock()
    w.addTab('t1', 'https://shop.example/checkout')
    w.event('t1', { type: 'submit', group: 'address', formId: 'f1', values: addressValues })
    await w.settle()
    const [prompt] = w.autofill.uiState().prompts
    expect(prompt).toMatchObject({
      kind: 'save-address',
      site: 'shop.example',
      preview: '1600 Amphitheatre Pkwy, Mountain View, CA 94043',
      address: { country: 'US', region: 'CA', name: 'Ada Lovelace', phone: '555' }
    })
    w.autofill.respond(prompt.id, { action: 'save' })
    await w.settle()
    expect(w.autofill.listAddresses()).toHaveLength(1)
    expect(w.autofill.uiState().addressCount).toBe(1)

    // The same address again: no prompt, a use recorded; with a new detail, the saved one grows.
    w.event('t1', {
      type: 'submit',
      group: 'address',
      formId: 'f1',
      values: { ...addressValues, email: 'ada@example.com' }
    })
    await w.settle()
    expect(w.autofill.uiState().prompts).toEqual([])
    expect(w.autofill.listAddresses()[0]).toMatchObject({ email: 'ada@example.com', phone: '555' })
    expect(w.autofill.listAddresses()[0].lastUsedAt).not.toBeNull()
  })

  it('ignores incomplete addresses, private tabs and the setting being off', async () => {
    const w = setup()
    await w.passwords.unlock()
    w.addTab('t1', 'https://shop.example/checkout')
    w.event('t1', {
      type: 'submit',
      group: 'address',
      formId: 'f1',
      values: { ...addressValues, 'postal-code': '' }
    })
    await w.settle()
    expect(w.autofill.uiState().prompts).toEqual([])
    w.addTab('p', 'https://shop.example/checkout', 'private')
    w.event('p', { type: 'submit', group: 'address', formId: 'f1', values: addressValues })
    await w.settle()
    expect(w.autofill.uiState().prompts).toEqual([])
    w.browser.state.settings.autofill.addresses = false
    w.event('t1', { type: 'submit', group: 'address', formId: 'f1', values: addressValues })
    await w.settle()
    expect(w.autofill.uiState().prompts).toEqual([])
  })

  it('assumes the device country for a form without one', async () => {
    const w = setup({ locales: ['de-DE'] })
    await w.passwords.unlock()
    w.addTab('t1', 'https://shop.example/checkout')
    w.event('t1', {
      type: 'submit',
      group: 'address',
      formId: 'f1',
      values: {
        ...addressValues,
        country: undefined,
        'address-level1': '',
        'address-level2': 'Berlin',
        'postal-code': '11011'
      }
    })
    await w.settle()
    expect(w.autofill.uiState().prompts[0]).toMatchObject({
      kind: 'save-address',
      address: { country: 'DE', locality: 'Berlin' }
    })
  })

  it('offers to save a valid, unexpired card and never stores the security code', async () => {
    const w = setup()
    await w.passwords.unlock()
    w.addTab('t1', 'https://shop.example/pay')
    w.event('t1', {
      type: 'submit',
      group: 'card',
      formId: 'f1',
      values: { 'cc-number': '4242 4242 4242 4242', 'cc-exp': '12/39', 'cc-name': 'Ada' }
    })
    await w.settle()
    const [prompt] = w.autofill.uiState().prompts
    expect(prompt).toMatchObject({
      kind: 'save-card',
      last4: '4242',
      network: 'visa',
      expMonth: 12,
      expYear: 2039,
      name: 'Ada'
    })
    w.autofill.respond(prompt.id, { action: 'save' })
    await w.settle()
    const [card] = w.autofill.listCards()
    expect(card).toMatchObject({ last4: '4242', network: 'visa', name: 'Ada' })
    expect(card).not.toHaveProperty('number')
    expect(w.autofill.uiState().cardCount).toBe(1)

    // The same card with a later expiry: the saved one is brought up to date, no prompt.
    w.event('t1', {
      type: 'submit',
      group: 'card',
      formId: 'f1',
      values: { 'cc-number': '4242424242424242', 'cc-exp': '01/45' }
    })
    await w.settle()
    expect(w.autofill.uiState().prompts).toEqual([])
    expect(w.autofill.listCards()[0]).toMatchObject({ expMonth: 1, expYear: 2045 })

    // Bad numbers and expired cards are not offered.
    w.event('t1', {
      type: 'submit',
      group: 'card',
      formId: 'f1',
      values: { 'cc-number': '4242424242424241', 'cc-exp': '12/39' }
    })
    w.event('t1', {
      type: 'submit',
      group: 'card',
      formId: 'f1',
      values: { 'cc-number': '5555555555554444', 'cc-exp': '01/20' }
    })
    await w.settle()
    expect(w.autofill.uiState().prompts).toEqual([])
  })

  it('validates cards in the manager and reveals or copies numbers behind re-authentication', async () => {
    const w = setup()
    w.reauth.enabled = true
    w.passwords.start()
    await w.settle()
    await w.passwords.unlock()
    expect(() =>
      w.autofill.addCard({ number: '1234', expMonth: 1, expYear: 2030, name: '', nickname: '' })
    ).toThrow(/card number/)
    const card = w.autofill.addCard({
      number: '4242424242424242',
      expMonth: 1,
      expYear: 2030,
      name: '',
      nickname: 'Work'
    })
    expect(() => w.autofill.updateCard(card.id, { expMonth: 13 })).toThrow(/month/)
    expect(w.autofill.updateCard(card.id, { expMonth: 6, expYear: 31 })).toMatchObject({
      expMonth: 6,
      expYear: 2031,
      nickname: 'Work'
    })
    expect(w.autofill.updateCard('card_nope', { expMonth: 6 })).toBeNull()

    expect(await w.autofill.revealCard(card.id)).toEqual({
      status: 'ok',
      value: '4242424242424242'
    })
    expect(w.reauth.verified).toEqual(['Show the card ending in 4242'])
    expect(await w.autofill.copyCardNumber(card.id)).toEqual({ status: 'ok', value: null })
    expect(w.clipboard.writeText).toHaveBeenCalledWith('4242424242424242', true)
    expect(w.toast).toHaveBeenCalledWith('Card number copied, clears in 1 min', 'info', undefined)
    expect(await w.autofill.revealCard('card_nope')).toEqual({ status: 'denied' })

    w.autofill.removeCard(card.id)
    expect(w.autofill.listCards()).toEqual([])
    expect(() => w.autofill.addAddress({ country: 'Mars' } as never)).toThrow(/country/)
  })
})

describe('AutofillService: passkeys', () => {
  it('records created passkeys, marks them used on sign-in, and lets the user pick among accounts', async () => {
    const w = setup()
    await w.passwords.unlock()
    w.addTab('t1', 'https://example.com/account')
    const created: FormsEvent = {
      type: 'passkey',
      op: 'create',
      rpId: 'example.com',
      rpName: 'Example',
      userName: 'ada@example.com',
      userDisplayName: 'Ada',
      credentialId: 'AQID-g'
    }
    w.event('t1', created)
    w.event('t1', created)
    expect(w.autofill.listPasskeys()).toHaveLength(1)
    expect(w.autofill.listPasskeys()[0]).toMatchObject({
      rpId: 'example.com',
      userName: 'ada@example.com',
      origin: 'https://example.com',
      lastUsedAt: expect.any(Number)
    })
    expect(w.autofill.uiState().passkeyCount).toBe(1)

    w.event('t1', { ...created, op: 'get', credentialId: 'AQID-g', userName: '' })
    const [record] = w.autofill.listPasskeys()
    expect(record.lastUsedAt).not.toBeNull()

    // The authenticator lists several accounts: the prompt asks, most recently used first.
    const choice = w.autofill.selectPasskeyAccount(
      'example.com',
      [
        { credentialId: 'BBBB', name: 'bob@example.com', displayName: 'Bob' },
        { credentialId: 'AQID-g', name: 'ada@example.com', displayName: 'Ada' }
      ],
      't1'
    )
    await w.settle()
    const [prompt] = w.autofill.uiState().prompts
    expect(prompt).toMatchObject({ kind: 'passkey-account', rpId: 'example.com' })
    expect(
      (prompt as { accounts: { credentialId: string }[] }).accounts.map((a) => a.credentialId)
    ).toEqual(['AQID-g', 'BBBB'])
    w.autofill.respond(prompt.id, { action: 'pick', credentialId: 'BBBB' })
    expect(await choice).toBe('BBBB')

    const cancelled = w.autofill.selectPasskeyAccount(
      'example.com',
      [{ credentialId: 'X', name: 'x', displayName: '' }],
      null
    )
    await w.settle()
    w.autofill.respond(w.autofill.uiState().prompts[0].id, null)
    expect(await cancelled).toBeNull()
    expect(await w.autofill.selectPasskeyAccount('example.com', [], 't1')).toBeNull()

    w.autofill.removePasskey(record.id)
    expect(w.autofill.listPasskeys()).toEqual([])
  })

  it('ignores passkey events while the vault is locked or for pages without an origin', async () => {
    const w = setup()
    w.addTab('t1', 'https://example.com/')
    const created: FormsEvent = {
      type: 'passkey',
      op: 'create',
      rpId: 'example.com',
      rpName: '',
      userName: 'a',
      userDisplayName: '',
      credentialId: 'c'
    }
    w.event('t1', created)
    await w.passwords.unlock()
    expect(w.autofill.listPasskeys()).toEqual([])
    w.addTab('t2', 'about:blank')
    w.event('t2', created)
    expect(w.autofill.listPasskeys()).toEqual([])
  })
})

describe('AutofillService: the Android system autofill provider', () => {
  it('leaves the pages to a system service under the system provider and takes them back under zenium', async () => {
    const host = new FakeAutofillHost()
    host.status = {
      enabled: true,
      service: 'com.google.android.gms/.autofill.service.AutofillService'
    }
    const w = setup({ autofillHost: host })
    const view = w.addTab('t1', 'https://example.com/login')
    w.autofill.start()
    await w.settle()
    expect(host.providers).toEqual(['system', 'system'])
    expect(w.autofill.uiState().systemAutofill).toEqual({
      enabled: true,
      service: 'com.google.android.gms/.autofill.service.AutofillService'
    })
    expect(w.autofill.pagesEnabled()).toBe(false)
    expect(view.commands.at(-1)).toEqual({ type: 'config', enabled: false })

    await w.passwords.unlock()
    w.passwords.add({ url: 'https://example.com', username: 'ada', password: 'pw' })
    w.event('t1', focusLogin())
    expect(w.autofill.uiState().picker).toBeNull()
    w.event('t1', loginSubmit())
    w.autofill.onNavigated('t1')
    await w.settle()
    expect(w.autofill.uiState().prompts).toEqual([])

    w.browser.state.settings.passwords.androidProvider = 'zenium'
    w.autofill.onSettingsChanged()
    expect(host.providers.at(-1)).toBe('zenium')
    expect(w.autofill.pagesEnabled()).toBe(true)
    expect(view.commands.at(-1)).toEqual({ type: 'config', enabled: true })
    w.event('t1', focusLogin())
    expect(w.autofill.uiState().picker).not.toBeNull()

    // The user removes the service in the system settings: Zenium's script works again either way.
    w.browser.state.settings.passwords.androidProvider = 'system'
    host.listener?.({ enabled: false, service: null })
    expect(w.autofill.pagesEnabled()).toBe(true)
    expect(w.autofill.uiState().systemAutofill).toEqual({ enabled: false, service: null })
  })

  it('reports no system autofill on hosts without the framework', () => {
    const w = setup()
    w.autofill.start()
    expect(w.autofill.uiState().systemAutofill).toBeNull()
    expect(w.autofill.pagesEnabled()).toBe(true)
  })
})

describe('AutofillService: page lifecycle', () => {
  it('configures the forms script and installs the passkey observer for web pages only', () => {
    const w = setup()
    const web = w.addTab('t1', 'https://example.com/')
    const internal = w.addTab('t2', 'zen://settings')
    w.autofill.onPageReady('t1')
    w.autofill.onPageReady('t2')
    expect(web.commands).toEqual([{ type: 'config', enabled: true }])
    expect(web.executeJavaScript).toHaveBeenCalledTimes(1)
    expect(String(web.executeJavaScript.mock.calls[0]?.[0])).toContain('__zeniumPasskey')
    expect(internal.commands).toEqual([{ type: 'config', enabled: true }])
    expect(internal.executeJavaScript).not.toHaveBeenCalled()
    w.autofill.onPageReady('nope')
  })

  it('forgets a submitted login that the page never confirmed', async () => {
    vi.useFakeTimers()
    const w = setup()
    await w.passwords.unlock()
    w.addTab('t1', 'https://example.com/login')
    w.event('t1', loginSubmit())
    await vi.advanceTimersByTimeAsync(31_000)
    w.autofill.onNavigated('t1')
    await vi.advanceTimersByTimeAsync(10)
    expect(w.autofill.uiState().prompts).toEqual([])
  })
})

describe('AutofillService: the popup surface (desktop)', () => {
  it('floats the picker under the field on a host with a popup surface and follows its reported height', async () => {
    const w = setup({ popupSurface: true })
    await w.passwords.unlock()
    w.passwords.add({ url: 'https://example.com/login', username: 'ada', password: 'pw-a' })
    w.addTab('t1', 'https://example.com/login')

    w.event('t1', focusLogin())
    const picker = w.autofill.uiState().picker
    expect(picker).not.toBeNull()
    // Opened at the estimate for one one-line row (a login of the site itself has no subtitle).
    expect(w.win.setPopupSurface).toHaveBeenLastCalledWith({
      x: 100 - 8,
      y: 284 + 32 - 8,
      width: 320 + 16,
      height: 105 + 16
    })
    // The document measured itself: the surface follows.
    w.autofill.surfaceSize(picker!.id, 140)
    expect(w.win.setPopupSurface).toHaveBeenLastCalledWith(
      expect.objectContaining({ height: 140 + 16 })
    )
    // Nonsense heights and stale ids change nothing.
    const calls = w.win.setPopupSurface.mock.calls.length
    w.autofill.surfaceSize(picker!.id, Number.NaN)
    w.autofill.surfaceSize('other', 200)
    expect(w.win.setPopupSurface.mock.calls.length).toBe(calls)
    // The field moved (page scroll): the surface moves with it, at the reported height.
    w.event('t1', { type: 'moved', fieldId: 'f2', rect: { ...FIELD, y: 20 } })
    expect(w.win.setPopupSurface).toHaveBeenLastCalledWith(
      expect.objectContaining({ y: 104 + 32 - 8, height: 140 + 16 })
    )
    // Closing takes the surface down.
    w.autofill.onNavigated('t1')
    expect(w.win.setPopupSurface).toHaveBeenLastCalledWith(null)
  })

  it('keeps the picker while the surface holds the keyboard and gives it back to the page after a pick', async () => {
    const w = setup({ popupSurface: true })
    w.reauth.enabled = true
    w.passwords.start()
    await w.settle()
    await w.passwords.unlock()
    w.passwords.add({ url: 'https://example.com/login', username: 'ada', password: 'pw-a' })
    const view = w.addTab('t1', 'https://example.com/login')
    w.event('t1', focusLogin())
    vi.useFakeTimers()
    const picker = w.autofill.uiState().picker!

    // A press on a row: the field blurs first, then the surface reports it took the keyboard.
    w.event('t1', { type: 'blur' })
    w.autofill.surfaceFocus(picker.id, true)
    await vi.advanceTimersByTimeAsync(1000)
    expect(w.autofill.uiState().picker).not.toBeNull()

    const result = await w.autofill.pick(picker.id, picker.items[0]!.id)
    expect(result).toEqual({ status: 'ok', value: null })
    expect(view.fills()).toHaveLength(1)
    expect(w.autofill.uiState().picker).toBeNull()
    expect(w.win.focusContent).toHaveBeenCalledTimes(1)
    expect(w.win.setPopupSurface).toHaveBeenLastCalledWith(null)
  })

  it('closes the picker after the grace once the surface lets the keyboard go with the field unfocused', async () => {
    vi.useFakeTimers()
    const w = setup({ popupSurface: true })
    await w.passwords.unlock()
    w.passwords.add({ url: 'https://example.com/login', username: 'ada', password: 'pw-a' })
    w.addTab('t1', 'https://example.com/login')
    w.event('t1', focusLogin())
    const picker = w.autofill.uiState().picker!

    w.event('t1', { type: 'blur' })
    w.autofill.surfaceFocus(picker.id, true)
    // The user clicked the page elsewhere: the surface blurs, the field is not focused.
    w.autofill.surfaceFocus(picker.id, false)
    expect(w.autofill.uiState().picker).not.toBeNull()
    await vi.advanceTimersByTimeAsync(500)
    expect(w.autofill.uiState().picker).toBeNull()

    // Dismissing from the surface (Escape) hands the keyboard back to the page too.
    w.event('t1', focusLogin())
    const again = w.autofill.uiState().picker!
    w.autofill.surfaceFocus(again.id, true)
    await w.autofill.pick(again.id, null)
    expect(w.autofill.uiState().picker).toBeNull()
    expect(w.win.focusContent).toHaveBeenCalledTimes(1)
  })

  it('draws no surface on a host without one and drops a stale save prompt when the tab leaves the site', async () => {
    const w = setup()
    await w.passwords.unlock()
    w.passwords.add({ url: 'https://example.com/login', username: 'ada', password: 'pw-a' })
    w.addTab('t1', 'https://example.com/login')
    w.event('t1', focusLogin())
    expect(w.autofill.uiState().picker).not.toBeNull()
    expect(w.win.setPopupSurface).not.toHaveBeenCalled()

    // A save prompt left unanswered goes once the tab is on another site.
    w.event('t1', loginSubmit({ username: 'grace', password: 'pw-g' }))
    w.tabs.set('t1', { ...w.tabs.get('t1')!, url: 'https://example.com/home' })
    w.autofill.onNavigated('t1')
    await w.settle()
    expect(w.autofill.uiState().prompts.map((p) => p.kind)).toEqual(['save-login'])
    w.tabs.set('t1', { ...w.tabs.get('t1')!, url: 'https://elsewhere.org/' })
    w.autofill.onNavigated('t1')
    await w.settle()
    expect(w.autofill.uiState().prompts).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// ID-31: the sign-in leak warning
// ---------------------------------------------------------------------------

/** SHA-1 prefix of "password" and the padded range its prefix returns (see checkup.test.ts). */
const BREACHED_PREFIX = '5BAA6'
const RANGE_5BAA6 = [
  '003D68EB55068C33ACE09247EE4C639306B:3',
  '1E4C9B93F3F0682250B6CF8331B7EE68FD8:10434004',
  '1F2B668E8AABEF1C59E9EC6F82E3F3CD786:0',
  ''
].join('\r\n')

describe('AutofillService: the sign-in leak warning (ID-31)', () => {
  /** A world whose breach corpus knows "password" and nothing else. */
  function breachedWorld(): World {
    const w = setup()
    w.net.ranges[BREACHED_PREFIX] = RANGE_5BAA6
    return w
  }

  /** Submit a login in `tabId` and let the page move on, as a sign-in does. */
  async function signIn(
    w: World,
    tabId: string,
    password: string,
    username = 'ada'
  ): Promise<void> {
    w.event(tabId, loginSubmit({ username, password }))
    w.autofill.onNavigated(tabId)
    await w.settle()
  }

  const rangeRequests = (w: World): string[] => w.net.requests.filter((u) => u.includes('/range/'))

  it('warns once a saved login signs in with a breached password, and records the verdict on the login', async () => {
    const w = breachedWorld()
    await w.passwords.unlock()
    const saved = w.passwords.add({
      url: 'https://example.com/login',
      username: 'ada',
      password: 'password'
    })
    w.addTab('t1', 'https://example.com/login')
    expect(w.passwords.status().leaks).toEqual([])

    await signIn(w, 't1', 'password')
    // One padded range request for the five-character prefix, never the password or its hash.
    expect(rangeRequests(w)).toEqual([`https://api.pwnedpasswords.com/range/${BREACHED_PREFIX}`])
    const [warning] = w.passwords.status().leaks
    expect(warning).toMatchObject({
      tabId: 't1',
      origin: 'https://example.com',
      site: 'example.com',
      username: 'ada',
      breachCount: 10_434_004,
      credentialId: saved.id,
      private: false
    })
    const login = w.passwords.store.get(saved.id)!
    expect(login.breached).toBe(10_434_004)
    expect(login.checkedAt).not.toBeNull()
    expect(login.leakWarnedAt).not.toBeNull()
    expect(login.leakIgnoredAt).toBeNull()
    // The manager's summary carries it, and the device's checkup summary counts it without a checkup.
    expect(w.passwords.list()[0]).toMatchObject({ breached: 10_434_004, leakIgnoredAt: null })
    expect(w.passwords.status().checkupSummary).toEqual({
      compromised: 1,
      weak: 0,
      reused: 0,
      checkedAt: null
    })
    expect(w.commit).toHaveBeenCalled()
    // No prompt to save: the login was saved already, and its use is recorded.
    expect(w.autofill.uiState().prompts).toEqual([])
    expect(login.lastUsedAt).not.toBeNull()
  })

  it('warns once per login per password value: not again after the warning, never after Ignore, again after a change', async () => {
    const w = breachedWorld()
    await w.passwords.unlock()
    const saved = w.passwords.add({
      url: 'https://example.com/login',
      username: 'ada',
      password: 'password'
    })
    w.addTab('t1', 'https://example.com/login')

    await signIn(w, 't1', 'password')
    const [first] = w.passwords.status().leaks
    await w.passwords.leakRespond(first.id, 'dismiss')
    expect(w.passwords.status().leaks).toEqual([])
    await signIn(w, 't1', 'password')
    // Warned for this value already: no request, no second warning.
    expect(rangeRequests(w)).toHaveLength(1)
    expect(w.passwords.status().leaks).toEqual([])

    // A second device (or a manual edit) may clear the memory; here the store is told directly.
    w.passwords.store.recordLeak(saved.id, { leakWarnedAt: null })
    await signIn(w, 't1', 'password')
    const [second] = w.passwords.status().leaks
    expect(second).toBeDefined()
    await w.passwords.leakRespond(second.id, 'ignore')
    expect(w.passwords.store.get(saved.id)!.leakIgnoredAt).not.toBeNull()
    // Ignored: out of Safety Check's count, and quiet from now on.
    expect(w.passwords.status().checkupSummary.compromised).toBe(0)
    await signIn(w, 't1', 'password')
    expect(w.passwords.status().leaks).toEqual([])
    expect(rangeRequests(w)).toHaveLength(2)

    // The password changes: the memory is that of one value, so the next sign-in checks again.
    w.passwords.update(saved.id, { password: 'password' })
    expect(w.passwords.store.get(saved.id)!.leakIgnoredAt).not.toBeNull()
    w.passwords.update(saved.id, { password: 'a-brand-new-value' })
    expect(w.passwords.store.get(saved.id)).toMatchObject({
      breached: null,
      checkedAt: null,
      leakWarnedAt: null,
      leakIgnoredAt: null
    })
    await signIn(w, 't1', 'a-brand-new-value')
    expect(rangeRequests(w)).toHaveLength(3)
    expect(w.passwords.status().leaks).toEqual([])
    expect(w.passwords.store.get(saved.id)).toMatchObject({ breached: 0, leakWarnedAt: null })
    expect(w.passwords.store.get(saved.id)!.checkedAt).not.toBeNull()
  })

  it('lists the tab under leakChecks while its check runs – a phone save sheet holds for it – and drops it with either verdict', async () => {
    const w = breachedWorld()
    await w.passwords.unlock()
    w.addTab('t1', 'https://example.com/login')
    w.addTab('t2', 'https://shop.example/login')
    const commits = (): number => vi.mocked(w.browser.state.commitVolatile).mock.calls.length
    expect(w.passwords.status().leakChecks).toEqual([])

    // The breached sign-in: the check is on record from the moment it starts, before the network
    // answers, and the chrome heard about it.
    let release!: () => void
    w.net.hold = new Promise<void>((resolve) => {
      release = resolve
    })
    const before = commits()
    w.event('t1', loginSubmit({ username: 'ada', password: 'password' }))
    w.autofill.onNavigated('t1')
    expect(w.passwords.status().leakChecks).toEqual(['t1'])
    expect(commits()).toBeGreaterThan(before)
    expect(w.passwords.status().leaks).toEqual([])
    release()
    await w.settle()
    // Over: the warning is up and the check is gone, in one state; the save prompt beside it is
    // the core's as before – the phone chrome is what holds the sheet.
    expect(w.passwords.status().leakChecks).toEqual([])
    expect(w.passwords.status().leaks).toHaveLength(1)
    expect(w.autofill.uiState().prompts.map((p) => p.kind)).toEqual(['save-login'])

    // A clean sign-in: listed while it runs, gone once it answered, no warning.
    w.net.hold = new Promise<void>((resolve) => {
      release = resolve
    })
    w.event('t2', loginSubmit({ username: 'bob', password: 'unique-and-clean-9f' }))
    w.autofill.onNavigated('t2')
    expect(w.passwords.status().leakChecks).toEqual(['t2'])
    const during = commits()
    release()
    await w.settle()
    expect(w.passwords.status().leakChecks).toEqual([])
    expect(w.passwords.status().leaks).toHaveLength(1)
    // The chrome heard the check end even though nothing else changed.
    expect(commits()).toBeGreaterThan(during)
    w.net.hold = null
  })

  it('warns nothing and records nothing when the range service cannot be reached, and tries again next time', async () => {
    const w = breachedWorld()
    w.net.ranges[BREACHED_PREFIX] = null
    await w.passwords.unlock()
    const saved = w.passwords.add({
      url: 'https://example.com/login',
      username: 'ada',
      password: 'password'
    })
    w.addTab('t1', 'https://example.com/login')

    await signIn(w, 't1', 'password')
    // The request and its two retries, then silence.
    expect(rangeRequests(w)).toHaveLength(3)
    expect(w.passwords.status().leaks).toEqual([])
    expect(w.passwords.store.get(saved.id)).toMatchObject({
      breached: null,
      checkedAt: null,
      leakWarnedAt: null
    })
    expect(w.passwords.status().checkupSummary.compromised).toBe(0)

    w.net.ranges[BREACHED_PREFIX] = RANGE_5BAA6
    await signIn(w, 't1', 'password')
    expect(rangeRequests(w)).toHaveLength(4)
    expect(w.passwords.status().leaks).toHaveLength(1)
  })

  it('runs no check with the setting off, and a clean password only records the check', async () => {
    const w = breachedWorld()
    await w.passwords.unlock()
    const saved = w.passwords.add({
      url: 'https://example.com/login',
      username: 'ada',
      password: 'password'
    })
    w.addTab('t1', 'https://example.com/login')
    w.browser.state.settings.passwords.leakDetection = false
    await signIn(w, 't1', 'password')
    expect(rangeRequests(w)).toEqual([])
    expect(w.passwords.status().leaks).toEqual([])
    expect(w.passwords.store.get(saved.id)!.checkedAt).toBeNull()

    w.browser.state.settings.passwords.leakDetection = true
    const clean = w.passwords.add({
      url: 'https://shop.example/login',
      username: 'bob',
      password: 'unique-and-clean-9f'
    })
    w.addTab('t2', 'https://shop.example/login')
    await signIn(w, 't2', 'unique-and-clean-9f', 'bob')
    expect(rangeRequests(w)).toHaveLength(1)
    expect(w.passwords.status().leaks).toEqual([])
    expect(w.passwords.store.get(clean.id)).toMatchObject({ breached: 0, leakWarnedAt: null })
    expect(w.passwords.store.get(clean.id)!.checkedAt).not.toBeNull()
  })

  it('checks and warns in a private tab but keeps no memory there', async () => {
    const w = breachedWorld()
    await w.passwords.unlock()
    const saved = w.passwords.add({
      url: 'https://example.com/login',
      username: 'ada',
      password: 'password'
    })
    w.addTab('p1', 'https://example.com/login', 'private')
    await signIn(w, 'p1', 'password')
    const [warning] = w.passwords.status().leaks
    expect(warning).toMatchObject({
      tabId: 'p1',
      private: true,
      credentialId: null,
      breachCount: 10_434_004
    })
    expect(w.passwords.store.get(saved.id)).toMatchObject({
      breached: null,
      checkedAt: null,
      leakWarnedAt: null
    })
    await w.passwords.leakRespond(warning.id, 'ignore')
    expect(w.passwords.store.get(saved.id)!.leakIgnoredAt).toBeNull()
    // Nothing remembered: the next private sign-in asks and warns again.
    await signIn(w, 'p1', 'password')
    expect(rangeRequests(w)).toHaveLength(2)
    expect(w.passwords.status().leaks).toHaveLength(1)
    expect(w.autofill.uiState().prompts).toEqual([])
  })

  it('warns for an unsaved sign-in too, and remembers the verdict on the login once the save prompt is accepted', async () => {
    const w = breachedWorld()
    await w.passwords.unlock()
    w.addTab('t1', 'https://example.com/login')
    await signIn(w, 't1', 'password')
    const [warning] = w.passwords.status().leaks
    expect(warning).toMatchObject({ credentialId: null, private: false, username: 'ada' })
    const [prompt] = w.autofill.uiState().prompts
    expect(prompt.kind).toBe('save-login')
    w.autofill.respond(prompt.id, { action: 'save' })
    await w.settle()
    const [saved] = w.passwords.store.list()
    expect(saved).toMatchObject({ password: 'password', breached: 10_434_004 })
    expect(saved.leakWarnedAt).not.toBeNull()
    // The warning now knows its login, so Ignore sticks.
    expect(w.passwords.status().leaks[0]).toMatchObject({ id: warning.id, credentialId: saved.id })
    await w.passwords.leakRespond(warning.id, 'ignore')
    expect(w.passwords.store.get(saved.id)!.leakIgnoredAt).not.toBeNull()
    expect(w.passwords.status().checkupSummary.compromised).toBe(0)
  })

  it('takes Change password to the well-known page when the site serves one, else to the site, and opens the manager', async () => {
    const w = breachedWorld()
    await w.passwords.unlock()
    w.addTab('t1', 'https://example.com/login')
    w.net.probes['https://example.com/.well-known/change-password'] = true
    await signIn(w, 't1', 'password')
    const [first] = w.passwords.status().leaks
    await w.passwords.leakRespond(first.id, 'changePassword')
    expect(w.navigate).toHaveBeenCalledWith(
      't1',
      'https://example.com/.well-known/change-password',
      { transition: 'link' }
    )
    expect(w.passwords.status().leaks).toEqual([])

    // A site that answers 200 to anything proves nothing: the site itself opens.
    w.net.probes[
      'https://example.com/.well-known/resource-that-should-not-exist-whose-status-code-should-not-be-200'
    ] = true
    await signIn(w, 't1', 'password')
    const [second] = w.passwords.status().leaks
    await w.passwords.leakRespond(second.id, 'changePassword')
    expect(w.navigate).toHaveBeenLastCalledWith('t1', 'https://example.com/', {
      transition: 'link'
    })

    await signIn(w, 't1', 'password')
    const [third] = w.passwords.status().leaks
    await w.passwords.leakRespond(third.id, 'openManager')
    expect(w.openPage).toHaveBeenCalledWith('settings', 'autofill', w.win)
    expect(w.passwords.status().leaks).toEqual([])
    // An answer to a warning that is gone is nothing.
    await w.passwords.leakRespond(third.id, 'ignore')
  })

  it('keeps a warning while the tab stays on the site and drops it when the tab leaves or closes', async () => {
    const w = breachedWorld()
    await w.passwords.unlock()
    w.addTab('t1', 'https://accounts.example.com/login')
    await signIn(w, 't1', 'password')
    expect(w.passwords.status().leaks).toHaveLength(1)
    w.tabs.get('t1')!.url = 'https://www.example.com/home'
    w.autofill.onNavigated('t1')
    expect(w.passwords.status().leaks).toHaveLength(1)
    w.tabs.get('t1')!.url = 'https://elsewhere.test/'
    w.autofill.onNavigated('t1')
    expect(w.passwords.status().leaks).toEqual([])

    w.addTab('t2', 'https://example.com/login')
    await signIn(w, 't2', 'password')
    expect(w.passwords.status().leaks).toHaveLength(1)
    w.autofill.onTabGone('t2')
    expect(w.passwords.status().leaks).toEqual([])
  })

  it('checks a sign-in while the vault is locked, remembering nothing, and never blocks on the vault', async () => {
    const w = breachedWorld()
    await w.passwords.unlock()
    w.passwords.add({ url: 'https://example.com/login', username: 'ada', password: 'password' })
    await w.passwords.store.flush()
    w.passwords.lock()
    w.keys.available = false
    w.addTab('t1', 'https://example.com/login')
    await signIn(w, 't1', 'password')
    expect(w.passwords.status().locked).toBe(true)
    expect(w.passwords.status().leaks[0]).toMatchObject({ credentialId: null, private: false })
    // The device summary cannot read a locked vault: it stays what it was.
    expect(w.passwords.status().checkupSummary.compromised).toBe(0)
  })
})
