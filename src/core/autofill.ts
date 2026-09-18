import type {
  AddressEntry,
  AddressInput,
  AutofillPicker,
  AutofillPickerItem,
  AutofillPrompt,
  AutofillPromptResponse,
  AutofillUIState,
  Credential,
  FormFieldKind,
  FormGroup,
  PasskeyAccountPrompt,
  PasskeyEntry,
  PaymentCard,
  PaymentCardInput,
  PaymentCardSummary,
  ReauthOutcome,
  Rect,
  SaveAddressPrompt,
  SaveCardPrompt,
  SaveLoginPrompt
} from '../shared/types'
import type { FormFieldInfo, FormValues, FormsEvent } from '../shared/forms'
import { PASSKEY_OBSERVER_SOURCE } from '../shared/passkeyObserver'
import { newId } from '../shared/ids'
import type { Browser } from './browser'
import type { ConfirmOptions, SystemAutofillStatus } from './platform'
import type { ZenWindow } from './window'
import {
  addressComplete,
  addressFromForm,
  addressPreview,
  addressToForm,
  defaultCountry,
  extendsAddress,
  normalizeCountry,
  sameAddress
} from './credentials/address'
import {
  NETWORK_NAMES,
  cardDigits,
  cardExpired,
  cardFromForm,
  cardLabel,
  cardNetwork,
  cardSummary,
  expiryLabel,
  fullYear,
  last4Of,
  validateCard
} from './credentials/card'
import {
  anchorInChrome,
  decideSave,
  orderLoginsForPicker,
  type LoginCandidate
} from './credentials/fill'
import { domainOf, normalizeOrigin, siteLabel } from './credentials/origins'

/** How long a submitted login waits for its page to move on before it is forgotten. */
const CANDIDATE_TTL_MS = 30_000
/**
 * A field losing focus closes its picker after this pause: a click on a picker row blurs the
 * field first and the chrome's `autofill.pick` arrives a moment later.
 */
const PICKER_BLUR_GRACE_MS = 400

interface FocusContext {
  tabId: string
  origin: string
  url: string
  formId: string
  fieldId: string
  kind: FormFieldKind
  group: FormGroup
  rect: Rect
  hasValue: boolean
  fields: FormFieldInfo[]
}

interface PendingLogin extends LoginCandidate {
  tabId: string
  formId: string
  at: number
}

type PickerEntry =
  | { kind: 'login'; credential: Credential }
  | { kind: 'address'; address: AddressEntry }
  | { kind: 'card'; card: PaymentCard }

interface PendingPrompt {
  prompt: AutofillPrompt
  resolve: (response: AutofillPromptResponse | null) => void
}

/**
 * In-page autofill on top of the credential store: the forms script reports focused fields and
 * submits (`handleEvent`); this service answers with the account / address / card picker in the
 * UI state, fills what the user picked (`pick`, behind the store's re-authentication), queues
 * save and update prompts after a sign-in or a checkout, keeps the passkey records, and owns the
 * `autofill.*` commands of the managers. On Android it also decides whether the system autofill
 * service or Zenium is in charge of the pages.
 *
 * Prompts live in `UIState.autofill.prompts` for the chrome to render; until a chrome does,
 * `nativePrompts` shows them through the host's confirm dialog so saving works everywhere.
 */
export class AutofillService {
  private readonly pending: PendingPrompt[] = []
  private picker: AutofillPicker | null = null
  private pickerEntries = new Map<string, PickerEntry>()
  private pickerContext: FocusContext | null = null
  private pickerCloseTimer: ReturnType<typeof setTimeout> | null = null
  private readonly focus = new Map<string, FocusContext>()
  private readonly candidates = new Map<string, PendingLogin>()
  /** `tabId|formId` of forms auto sign-in already filled once for this page load. */
  private readonly autoFilled = new Set<string>()
  private systemAutofill: SystemAutofillStatus | null = null
  private revision = 0
  /** The first password fill of a session goes through re-authentication; later ones do not. */
  private fillAuthorized = false
  /** Engine surface: prompts open as host dialogs. The chrome sets this false once it renders the queue. */
  nativePrompts = true
  private nativeQueue: Promise<void> = Promise.resolve()

  constructor(private readonly browser: Browser) {}

  /** Probe the system autofill framework (Android) and apply the provider setting. */
  start(): void {
    const host = this.browser.platform.autofill
    if (!host) return
    this.applyProvider()
    host.onSystemStatusChanged?.((status) => {
      this.systemAutofill = status
      this.applyProvider()
      this.bump()
    })
    void host
      .systemStatus()
      .then((status) => {
        this.systemAutofill = status
        this.applyProvider()
        this.bump()
      })
      .catch(() => undefined)
  }

  uiState(): AutofillUIState {
    const store = this.browser.passwords.store
    return {
      prompts: this.pending.map((p) => p.prompt),
      picker: this.picker,
      addressCount: store.unlocked() ? store.listAddresses().length : 0,
      cardCount: store.unlocked() ? store.listCards().length : 0,
      passkeyCount: store.unlocked() ? store.listPasskeys().length : 0,
      systemAutofill: this.systemAutofill
        ? { enabled: this.systemAutofill.enabled, service: this.systemAutofill.service }
        : null,
      revision: this.revision
    }
  }

  /** Settings → Passwords / Autofill changed: the provider and the pages' script follow. */
  onSettingsChanged(): void {
    this.applyProvider()
  }

  /**
   * Whether Zenium's forms script works in pages: always, except on an Android device whose
   * system autofill service is set and chosen as the provider (then the framework saves and fills).
   */
  pagesEnabled(): boolean {
    if (!this.systemAutofill?.enabled) return true
    return this.browser.state.settings.passwords.androidProvider !== 'system'
  }

  private applyProvider(): void {
    const host = this.browser.platform.autofill
    host?.setProvider(this.browser.state.settings.passwords.androidProvider)
    const enabled = this.pagesEnabled()
    for (const [, view] of this.browser.tabs.allViews())
      if (!view.isDestroyed()) view.sendFormsCommand?.({ type: 'config', enabled })
    if (!enabled) this.closePicker()
  }

  // ---------------------------------------------------------------------------
  // Tab lifecycle
  // ---------------------------------------------------------------------------

  /** A page's DOM is ready: configure its forms script and watch its WebAuthn calls. */
  onPageReady(tabId: string): void {
    const view = this.browser.tabs.view(tabId)
    const tab = this.browser.tabs.tab(tabId)
    if (!view || !tab) return
    view.sendFormsCommand?.({ type: 'config', enabled: this.pagesEnabled() })
    if (/^https?:/i.test(tab.url))
      void view.executeJavaScript(PASSKEY_OBSERVER_SOURCE).catch(() => undefined)
  }

  /** The tab committed a navigation: a submitted login is judged now, the picker is moot. */
  onNavigated(tabId: string): void {
    this.focus.delete(tabId)
    for (const key of this.autoFilled) if (key.startsWith(`${tabId}|`)) this.autoFilled.delete(key)
    if (this.picker?.tabId === tabId) this.closePicker()
    // Hosts without a dom-ready signal (Android) learn the configuration for the new document here.
    this.browser.tabs
      .view(tabId)
      ?.sendFormsCommand?.({ type: 'config', enabled: this.pagesEnabled() })
    this.evaluateCandidate(tabId)
  }

  onTabGone(tabId: string): void {
    this.focus.delete(tabId)
    this.candidates.delete(tabId)
    if (this.picker?.tabId === tabId) this.closePicker()
    for (const p of this.pending.filter((p) => p.prompt.tabId === tabId))
      this.respond(p.prompt.id, null)
  }

  // ---------------------------------------------------------------------------
  // Events from the forms script
  // ---------------------------------------------------------------------------

  handleEvent(tabId: string, event: FormsEvent): void {
    if (event.type === 'passkey') {
      this.onPasskey(tabId, event)
      return
    }
    if (!this.pagesEnabled()) return
    switch (event.type) {
      case 'focus':
        this.onFocus(tabId, event)
        return
      case 'moved':
        if (this.picker && this.picker.tabId === tabId && this.pickerContext) {
          this.pickerContext.rect = event.rect
          this.picker = { ...this.picker, anchor: this.anchorFor(tabId, event.rect) }
          this.browser.state.commitVolatile()
        }
        return
      case 'blur':
        this.onBlur(tabId)
        return
      case 'submit':
        if (event.group === 'login') this.onLoginSubmit(tabId, event)
        else void this.onDataSubmit(tabId, event.group, event.values)
        return
      case 'settled':
        this.evaluateCandidate(tabId, event.formId)
        return
    }
  }

  private onFocus(tabId: string, event: Extract<FormsEvent, { type: 'focus' }>): void {
    const tab = this.browser.tabs.tab(tabId)
    if (!tab) return
    const origin = normalizeOrigin(tab.url)
    if (!origin) return
    const context: FocusContext = {
      tabId,
      origin,
      url: tab.url,
      formId: event.formId,
      fieldId: event.fieldId,
      kind: event.kind,
      group: event.group,
      rect: event.rect,
      hasValue: event.hasValue,
      fields: event.fields
    }
    this.focus.set(tabId, context)
    this.cancelPickerClose()
    const store = this.browser.passwords.store
    if (!store.unlocked()) {
      this.closePicker()
      return
    }
    const entries = this.entriesFor(context)
    if (entries.length === 0) {
      this.closePicker()
      return
    }
    const formKey = `${tabId}|${context.formId}`
    const settings = this.browser.state.settings
    if (
      context.group === 'login' &&
      settings.passwords.autoSignIn &&
      entries.length === 1 &&
      entries[0].kind === 'login' &&
      !context.hasValue &&
      !context.fields.some((f) => f.hasValue) &&
      !this.autoFilled.has(formKey)
    ) {
      this.autoFilled.add(formKey)
      this.closePicker()
      void this.fillEntry(context, entries[0], undefined, this.browser.tabs.windowFor(tabId)).then(
        (result) => {
          // Not authorized (a dismissed prompt, a passphrase to ask for): the picker takes over so
          // the chrome can ask, as long as the field is still the focused one.
          if (result.status !== 'ok' && this.focus.get(tabId) === context)
            this.openPicker(context, entries)
        }
      )
      return
    }
    this.openPicker(context, entries)
  }

  private onBlur(tabId: string): void {
    if (this.picker?.tabId !== tabId) return
    this.cancelPickerClose()
    this.pickerCloseTimer = setTimeout(() => {
      this.pickerCloseTimer = null
      this.closePicker()
    }, PICKER_BLUR_GRACE_MS)
  }

  private cancelPickerClose(): void {
    if (this.pickerCloseTimer) clearTimeout(this.pickerCloseTimer)
    this.pickerCloseTimer = null
  }

  /** The store entries that can fill the focused form, in picker order. */
  private entriesFor(context: FocusContext): PickerEntry[] {
    const store = this.browser.passwords.store
    const settings = this.browser.state.settings
    switch (context.group) {
      case 'login': {
        // A sign-up form gets no saved login pushed into its new-password field.
        if (context.kind === 'new-password') return []
        return orderLoginsForPicker(store.findForOrigin(context.origin), context.origin).map(
          ({ credential }) => ({ kind: 'login', credential })
        )
      }
      case 'address':
        if (!settings.autofill.addresses) return []
        return store.listAddresses().map((address) => ({ kind: 'address', address }))
      case 'card':
        if (!settings.autofill.cards) return []
        return store.listCards().map((card) => ({ kind: 'card', card }))
    }
  }

  private openPicker(context: FocusContext, entries: PickerEntry[]): void {
    const passwords = this.browser.passwords
    const favicons = this.browser.history.faviconsByDomain()
    const askPassphrase = passwords.wouldAskPassphrase()
    const items: AutofillPickerItem[] = []
    this.pickerEntries = new Map()
    for (const entry of entries) {
      let item: AutofillPickerItem
      switch (entry.kind) {
        case 'login': {
          const c = entry.credential
          item = {
            id: c.id,
            title: c.username || 'No username',
            subtitle: c.origin === context.origin ? '' : siteLabel(c.origin),
            favicon: favicons.get(domainOf(c.origin)) ?? null,
            needsPassphrase: !this.fillAuthorized && askPassphrase
          }
          break
        }
        case 'address': {
          const a = entry.address
          item = {
            id: a.id,
            title: a.name || a.organization || a.streetAddress.split('\n')[0],
            subtitle: addressPreview(a),
            favicon: null
          }
          break
        }
        case 'card': {
          const summary = cardSummary(entry.card)
          item = {
            id: entry.card.id,
            title: cardLabel(summary),
            subtitle: [entry.card.name, expiryLabel(entry.card.expMonth, entry.card.expYear)]
              .filter(Boolean)
              .join(', '),
            favicon: null,
            needsPassphrase: askPassphrase
          }
          break
        }
      }
      items.push(item)
      this.pickerEntries.set(item.id, entry)
    }
    this.pickerContext = context
    this.picker = {
      id: newId('picker'),
      tabId: context.tabId,
      group: context.group,
      field: context.kind,
      anchor: this.anchorFor(context.tabId, context.rect),
      items,
      manageLabel:
        context.group === 'login'
          ? 'Manage passwords'
          : context.group === 'address'
            ? 'Manage addresses'
            : 'Manage payment methods'
    }
    this.browser.state.commitVolatile()
  }

  private anchorFor(tabId: string, rect: Rect): Rect {
    const tab = this.browser.tabs.tab(tabId)
    const win = this.browser.tabs.windowFor(tabId)
    const view = win.viewRect(tabId)
    if (!view) return rect
    return anchorInChrome(rect, view, tab?.zoom ?? 1)
  }

  private closePicker(): void {
    this.cancelPickerClose()
    if (!this.picker) return
    this.picker = null
    this.pickerEntries = new Map()
    this.pickerContext = null
    this.browser.state.commitVolatile()
  }

  // ---------------------------------------------------------------------------
  // Filling
  // ---------------------------------------------------------------------------

  /** The chrome picked a row (or closed the picker with null). */
  async pick(
    id: string,
    itemId: string | null,
    passphrase?: string,
    win?: ZenWindow
  ): Promise<ReauthOutcome<null>> {
    if (!this.picker || this.picker.id !== id) return { status: 'denied' }
    if (itemId === null) {
      this.closePicker()
      return { status: 'ok', value: null }
    }
    const entry = this.pickerEntries.get(itemId)
    const context = this.pickerContext
    if (!entry || !context) {
      this.closePicker()
      return { status: 'denied' }
    }
    this.cancelPickerClose()
    const result = await this.fillEntry(context, entry, passphrase, win)
    // A passphrase step keeps the picker so the chrome can ask and call again with the answer.
    if (result.status !== 'passphrase') this.closePicker()
    return result
  }

  private async fillEntry(
    context: FocusContext,
    entry: PickerEntry,
    passphrase: string | undefined,
    win: ZenWindow | undefined
  ): Promise<ReauthOutcome<null>> {
    const view = this.browser.tabs.view(context.tabId)
    if (!view || view.isDestroyed() || !view.sendFormsCommand) return { status: 'denied' }
    const passwords = this.browser.passwords
    const store = passwords.store
    let values: FormValues
    let labels: { countryName?: string; regionName?: string } | undefined
    switch (entry.kind) {
      case 'login': {
        if (!this.fillAuthorized) {
          const gate = await passwords.authorize(
            `Fill the password for ${siteLabel(context.origin)}`,
            passphrase,
            win
          )
          if (gate.status !== 'ok') return gate
          this.fillAuthorized = true
        }
        values = { username: entry.credential.username, password: entry.credential.password }
        store.markUsed(entry.credential.id)
        break
      }
      case 'address': {
        ;({ values, labels } = addressToForm(entry.address))
        store.markAddressUsed(entry.address.id)
        break
      }
      case 'card': {
        const gate = await passwords.authorize(
          `Fill the card ending in ${last4Of(entry.card.number)}`,
          passphrase,
          win
        )
        if (gate.status !== 'ok') return gate
        const month = String(entry.card.expMonth).padStart(2, '0')
        const year = String(entry.card.expYear)
        values = {
          'cc-number': entry.card.number,
          'cc-exp': `${month}/${year}`,
          'cc-exp-month': month,
          'cc-exp-year': year,
          'cc-name': entry.card.name
        }
        store.markCardUsed(entry.card.id)
        break
      }
    }
    view.sendFormsCommand({ type: 'fill', formId: context.formId, values, labels })
    return { status: 'ok', value: null }
  }

  // ---------------------------------------------------------------------------
  // Saving logins
  // ---------------------------------------------------------------------------

  private onLoginSubmit(
    tabId: string,
    event: Extract<FormsEvent, { type: 'submit'; group: 'login' }>
  ): void {
    const tab = this.browser.tabs.tab(tabId)
    if (!tab || !event.password) return
    const origin = normalizeOrigin(tab.url)
    if (!origin) return
    this.candidates.set(tabId, {
      tabId,
      formId: event.formId,
      origin,
      url: tab.url,
      username: event.username,
      password: event.password,
      newPassword: event.newPassword,
      at: Date.now()
    })
  }

  /**
   * The page moved on after a login submit (navigation or a settled single-page sign-in): now
   * the credentials are worth offering. A candidate the page never confirmed expires.
   */
  private evaluateCandidate(tabId: string, formId?: string): void {
    const candidate = this.candidates.get(tabId)
    if (!candidate) return
    if (formId !== undefined && candidate.formId !== formId) return
    this.candidates.delete(tabId)
    if (Date.now() - candidate.at > CANDIDATE_TTL_MS) return
    const tab = this.browser.tabs.tab(tabId)
    if (!tab || tab.errorCode !== null) return
    void this.offerLogin(candidate)
  }

  private async ensureUnlocked(): Promise<boolean> {
    const passwords = this.browser.passwords
    if (passwords.store.unlocked()) return true
    const result = await passwords.unlock()
    return result.status === 'ok'
  }

  private async offerLogin(candidate: PendingLogin): Promise<void> {
    if (!(await this.ensureUnlocked())) return
    const store = this.browser.passwords.store
    const tab = this.browser.tabs.tab(candidate.tabId)
    const decision = decideSave(candidate, {
      offerToSave: this.browser.state.settings.passwords.offerToSave,
      isPrivate: tab ? this.browser.tabs.isPrivate(tab) : false,
      neverSave: store.isNeverSave(candidate.origin),
      matches: store.findForOrigin(candidate.origin)
    })
    if (decision.kind === 'none') {
      if (decision.existing) store.markUsed(decision.existing.id)
      return
    }
    const site = siteLabel(candidate.origin)
    const prompt: SaveLoginPrompt = {
      id: newId('autofill'),
      kind: decision.kind === 'save' ? 'save-login' : 'update-login',
      tabId: candidate.tabId,
      origin: candidate.origin,
      site,
      username: candidate.username,
      existingId: decision.kind === 'update' ? decision.existing.id : null
    }
    const win = this.windowOf(candidate.tabId)
    const response = await this.show(prompt, win)
    if (!response || !store.unlocked()) return
    if (response.action === 'never') {
      store.neverSaveAdd(candidate.origin)
      this.browser.toast(`Zenium will not offer to save passwords for ${site}`, 'info', win)
      return
    }
    if (response.action !== 'save') return
    const username = response.username ?? candidate.username
    if (decision.kind === 'update') {
      store.update(decision.existing.id, { username, password: candidate.password })
      this.browser.toast('Password updated', 'info', win)
    } else {
      store.add({ url: candidate.url, username, password: candidate.password })
      this.browser.toast('Password saved', 'info', win)
    }
  }

  // ---------------------------------------------------------------------------
  // Saving addresses and cards
  // ---------------------------------------------------------------------------

  private async onDataSubmit(
    tabId: string,
    group: 'address' | 'card',
    values: FormValues
  ): Promise<void> {
    const tab = this.browser.tabs.tab(tabId)
    if (!tab || this.browser.tabs.isPrivate(tab)) return
    const origin = normalizeOrigin(tab.url)
    if (!origin) return
    const settings = this.browser.state.settings.autofill
    if (group === 'address' ? !settings.addresses : !settings.cards) return
    if (!(await this.ensureUnlocked())) return
    const store = this.browser.passwords.store
    const win = this.windowOf(tabId)
    const site = siteLabel(origin)
    if (group === 'address') {
      const input = addressFromForm(
        values,
        defaultCountry(this.browser.platform.translate?.locales ?? [])
      )
      if (!input || !addressComplete(input)) return
      const existing = store.listAddresses().find((a) => sameAddress(a, input))
      if (existing) {
        if (extendsAddress(input, existing))
          store.updateAddress(existing.id, {
            phone: existing.phone || input.phone,
            email: existing.email || input.email,
            organization: existing.organization || input.organization
          })
        store.markAddressUsed(existing.id)
        this.bump()
        return
      }
      const prompt: SaveAddressPrompt = {
        id: newId('autofill'),
        kind: 'save-address',
        tabId,
        origin,
        site,
        address: input,
        preview: addressPreview(input)
      }
      const response = await this.show(prompt, win)
      if (response?.action === 'save' && store.unlocked()) {
        store.addAddress(input)
        this.bump()
        this.browser.toast('Address saved', 'info', win)
      }
      return
    }
    const input = cardFromForm(values)
    if (!input || cardExpired(input.expMonth, input.expYear)) return
    const existing = store.listCards().find((c) => c.number === input.number)
    if (existing) {
      if (
        existing.expMonth !== input.expMonth ||
        existing.expYear !== input.expYear ||
        (input.name && !existing.name)
      )
        store.updateCard(existing.id, {
          expMonth: input.expMonth,
          expYear: input.expYear,
          name: existing.name || input.name
        })
      store.markCardUsed(existing.id)
      this.bump()
      return
    }
    const prompt: SaveCardPrompt = {
      id: newId('autofill'),
      kind: 'save-card',
      tabId,
      origin,
      site,
      last4: last4Of(input.number),
      network: cardNetwork(input.number),
      expMonth: input.expMonth,
      expYear: input.expYear,
      name: input.name
    }
    const response = await this.show(prompt, win)
    if (response?.action === 'save' && store.unlocked()) {
      store.addCard(input)
      this.bump()
      this.browser.toast('Card saved', 'info', win)
    }
  }

  // ---------------------------------------------------------------------------
  // Passkeys
  // ---------------------------------------------------------------------------

  private onPasskey(tabId: string, event: Extract<FormsEvent, { type: 'passkey' }>): void {
    const store = this.browser.passwords.store
    if (!store.unlocked()) return
    const tab = this.browser.tabs.tab(tabId)
    const origin = tab ? normalizeOrigin(tab.url) : ''
    if (!origin || !event.rpId) return
    const existing = store.findPasskey(event.rpId, event.credentialId, event.userName)
    if (event.op === 'create') {
      if (existing) store.markPasskeyUsed(existing.id)
      else
        store.addPasskey({
          rpId: event.rpId,
          rpName: event.rpName,
          userName: event.userName,
          userDisplayName: event.userDisplayName,
          credentialId: event.credentialId,
          origin
        })
    } else if (existing) store.markPasskeyUsed(existing.id)
    this.bump()
  }

  /**
   * Several discoverable passkeys match a sign-in and the authenticator wants the user to choose
   * (Electron's `select-webauthn-account`). Resolves with the chosen credential id, or null to
   * cancel the request.
   */
  async selectPasskeyAccount(
    rpId: string,
    accounts: { credentialId: string; name: string; displayName: string }[],
    tabId: string | null
  ): Promise<string | null> {
    if (accounts.length === 0) return null
    const store = this.browser.passwords.store
    const records = store.unlocked() ? store.listPasskeys() : []
    const recency = (credentialId: string): number =>
      records.find((p) => p.credentialId === credentialId)?.lastUsedAt ?? 0
    const ordered = [...accounts].sort((a, b) => recency(b.credentialId) - recency(a.credentialId))
    const prompt: PasskeyAccountPrompt = {
      id: newId('autofill'),
      kind: 'passkey-account',
      tabId,
      rpId,
      accounts: ordered.map((a) => ({
        credentialId: a.credentialId,
        userName: a.name || a.displayName || 'Passkey'
      }))
    }
    const response = await this.show(prompt, tabId ? this.windowOf(tabId) : undefined)
    if (response?.action !== 'pick') return null
    const chosen = accounts.find((a) => a.credentialId === response.credentialId)
    if (chosen && store.unlocked()) {
      const record = store.findPasskey(rpId, chosen.credentialId)
      if (record) store.markPasskeyUsed(record.id)
    }
    return chosen?.credentialId ?? null
  }

  // ---------------------------------------------------------------------------
  // Prompts
  // ---------------------------------------------------------------------------

  /** The chrome answered (or dismissed) a prompt. */
  respond(id: string, response: AutofillPromptResponse | null): void {
    const i = this.pending.findIndex((p) => p.prompt.id === id)
    if (i < 0) return
    const [entry] = this.pending.splice(i, 1)
    this.browser.state.commitVolatile()
    entry.resolve(response)
  }

  private show(prompt: AutofillPrompt, win?: ZenWindow): Promise<AutofillPromptResponse | null> {
    return new Promise((resolve) => {
      this.pending.push({ prompt, resolve })
      this.browser.state.commitVolatile()
      // One host dialog at a time: a checkout submits its card and its address together.
      if (this.nativePrompts)
        this.nativeQueue = this.nativeQueue.then(() => this.showNative(prompt, win))
    })
  }

  /** The engine's own rendering: the host's confirm dialog, two buttons, until the chrome takes over. */
  private async showNative(prompt: AutofillPrompt, win?: ZenWindow): Promise<void> {
    // Answered while it waited (the chrome took over, the tab went away): nothing left to show.
    if (!this.pending.some((p) => p.prompt.id === prompt.id)) return
    let options: ConfirmOptions
    let onOk: AutofillPromptResponse
    switch (prompt.kind) {
      case 'save-login':
        options = {
          message: `Save password for ${prompt.site}?`,
          detail: prompt.username ? `Zenium saves the password for ${prompt.username}.` : undefined,
          okLabel: 'Save',
          cancelLabel: 'Not now'
        }
        onOk = { action: 'save' }
        break
      case 'update-login':
        options = {
          message: `Update password for ${prompt.site}?`,
          detail: prompt.username
            ? `The saved password for ${prompt.username} changes.`
            : undefined,
          okLabel: 'Update',
          cancelLabel: 'Not now'
        }
        onOk = { action: 'save' }
        break
      case 'save-address':
        options = {
          message: 'Save address?',
          detail: [prompt.address.name, prompt.preview].filter(Boolean).join('\n'),
          okLabel: 'Save',
          cancelLabel: 'Not now'
        }
        onOk = { action: 'save' }
        break
      case 'save-card':
        options = {
          message: 'Save card?',
          detail: `${NETWORK_NAMES[prompt.network]} \u2022\u2022\u2022\u2022 ${prompt.last4}, expires ${expiryLabel(prompt.expMonth, prompt.expYear)}`,
          okLabel: 'Save',
          cancelLabel: 'Not now'
        }
        onOk = { action: 'save' }
        break
      case 'passkey-account': {
        const account = prompt.accounts[0]
        options = {
          message: `Sign in to ${prompt.rpId} with a passkey?`,
          detail:
            prompt.accounts.length > 1
              ? `${account.userName} (${prompt.accounts.length} passkeys saved for this site)`
              : account.userName,
          okLabel: 'Continue',
          cancelLabel: 'Cancel'
        }
        onOk = { action: 'pick', credentialId: account.credentialId }
        break
      }
    }
    let ok = false
    try {
      ok = await this.browser.platform.dialogs.confirm(options, win)
    } catch {
      ok = false
    }
    this.respond(prompt.id, ok ? onOk : null)
  }

  private windowOf(tabId: string): ZenWindow | undefined {
    try {
      return this.browser.tabs.windowFor(tabId)
    } catch {
      return undefined
    }
  }

  // ---------------------------------------------------------------------------
  // Managers (the `autofill.*` commands)
  // ---------------------------------------------------------------------------

  listAddresses(): AddressEntry[] {
    const store = this.browser.passwords.store
    return store.unlocked() ? store.listAddresses() : []
  }

  addAddress(input: AddressInput): AddressEntry {
    const country = normalizeCountry(input.country)
    if (!country) throw new Error('Choose a country for the address.')
    const address = this.browser.passwords.store.addAddress({ ...input, country })
    this.bump()
    return address
  }

  updateAddress(id: string, patch: Partial<AddressInput>): AddressEntry | null {
    if (patch.country !== undefined && !normalizeCountry(patch.country))
      throw new Error('Choose a country for the address.')
    const address = this.browser.passwords.store.updateAddress(id, patch)
    this.bump()
    return address
  }

  removeAddress(id: string): void {
    this.browser.passwords.store.removeAddress(id)
    this.bump()
  }

  listCards(): PaymentCardSummary[] {
    const store = this.browser.passwords.store
    return store.unlocked() ? store.listCards().map((c) => cardSummary(c)) : []
  }

  addCard(input: PaymentCardInput): PaymentCardSummary {
    const card: PaymentCardInput = {
      ...input,
      number: cardDigits(input.number),
      expYear: fullYear(input.expYear)
    }
    const error = validateCard(card)
    if (error) throw new Error(error)
    const saved = this.browser.passwords.store.addCard(card)
    this.bump()
    return cardSummary(saved)
  }

  updateCard(id: string, patch: Partial<PaymentCardInput>): PaymentCardSummary | null {
    const store = this.browser.passwords.store
    const current = store.getCard(id)
    if (!current) return null
    const next: PaymentCardInput = {
      number: patch.number !== undefined ? cardDigits(patch.number) : current.number,
      expMonth: patch.expMonth ?? current.expMonth,
      expYear: fullYear(patch.expYear ?? current.expYear),
      name: patch.name ?? current.name,
      nickname: patch.nickname ?? current.nickname
    }
    const error = validateCard(next)
    if (error) throw new Error(error)
    const card = store.updateCard(id, next)
    this.bump()
    return card ? cardSummary(card) : null
  }

  removeCard(id: string): void {
    this.browser.passwords.store.removeCard(id)
    this.bump()
  }

  async revealCard(
    id: string,
    passphrase?: string,
    win?: ZenWindow
  ): Promise<ReauthOutcome<string>> {
    const card = this.browser.passwords.store.getCard(id)
    if (!card) return { status: 'denied' }
    const gate = await this.browser.passwords.authorize(
      `Show the card ending in ${last4Of(card.number)}`,
      passphrase,
      win
    )
    if (gate.status !== 'ok') return gate
    return { status: 'ok', value: card.number }
  }

  async copyCardNumber(
    id: string,
    passphrase?: string,
    win?: ZenWindow
  ): Promise<ReauthOutcome<null>> {
    const card = this.browser.passwords.store.getCard(id)
    if (!card) return { status: 'denied' }
    const gate = await this.browser.passwords.authorize(
      `Copy the card ending in ${last4Of(card.number)}`,
      passphrase,
      win
    )
    if (gate.status !== 'ok') return gate
    this.browser.passwords.copySecret(card.number, 'Card number', win)
    return { status: 'ok', value: null }
  }

  listPasskeys(): PasskeyEntry[] {
    const store = this.browser.passwords.store
    return store.unlocked() ? store.listPasskeys() : []
  }

  removePasskey(id: string): void {
    this.browser.passwords.store.removePasskey(id)
    this.bump()
  }

  private bump(): void {
    this.revision++
    this.browser.state.commitVolatile()
  }
}
