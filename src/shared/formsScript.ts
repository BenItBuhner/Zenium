import type { FormFieldKind, FormGroup, Rect } from './types'
import {
  FILLABLE_KINDS,
  groupOfKind,
  type FormFieldInfo,
  type FormValues,
  type FormsCommand,
  type FormsEvent
} from './forms'

/**
 * Runs inside every web page next to `pageScript`: finds login, sign-up, address and payment
 * forms, tells the browser when one of their fields is focused (so it can offer saved entries),
 * fills what the browser chose, and reports submits so the browser can offer to save. Nothing
 * here decides what to save or show; that is the core's `AutofillService`.
 *
 * The transport is injected like the page script's: Electron's isolated world talks IPC, the
 * Android WebView the `__zenPageBridge` message listener. No page-visible globals are created.
 */
export interface FormsTransport {
  send(event: FormsEvent): void
  onCommand(listener: (command: FormsCommand) => void): void
}

// ---------------------------------------------------------------------------
// Classification (pure; exercised by the unit tests on fixture forms)
// ---------------------------------------------------------------------------

/** What is known about a control before it is classified. */
export interface FieldSignals {
  tag: 'input' | 'select' | 'textarea'
  /** Lower-case `type` of an input; '' for other tags. */
  type: string
  autocomplete: string
  name: string
  id: string
  placeholder: string
  /** Visible label text (`<label>`, `aria-label`, `aria-labelledby`, the parent's own text). */
  label: string
  maxLength: number
}

const AUTOCOMPLETE_KINDS: Record<string, FormFieldKind> = {
  username: 'username',
  'current-password': 'password',
  'new-password': 'new-password',
  'one-time-code': 'one-time-code',
  name: 'name',
  'given-name': 'given-name',
  'additional-name': 'given-name',
  'family-name': 'family-name',
  organization: 'organization',
  'street-address': 'street-address',
  'address-line1': 'address-line1',
  'address-line2': 'address-line2',
  'address-line3': 'address-line2',
  'address-level1': 'address-level1',
  'address-level2': 'address-level2',
  'postal-code': 'postal-code',
  country: 'country',
  'country-name': 'country',
  tel: 'tel',
  'tel-national': 'tel',
  email: 'email',
  'cc-name': 'cc-name',
  'cc-given-name': 'cc-name',
  'cc-family-name': 'cc-name',
  'cc-number': 'cc-number',
  'cc-exp': 'cc-exp',
  'cc-exp-month': 'cc-exp-month',
  'cc-exp-year': 'cc-exp-year',
  'cc-csc': 'cc-csc'
}

/** `autocomplete="section-blue shipping tel"` → `tel`; `off`, `on` and unknown tokens → null. */
export function kindFromAutocomplete(autocomplete: string): FormFieldKind | null {
  for (const token of autocomplete.trim().toLowerCase().split(/\s+/)) {
    const kind = AUTOCOMPLETE_KINDS[token]
    if (kind) return kind
  }
  return null
}

interface Rule {
  kind: FormFieldKind
  test: RegExp
  /** Only when the form also has a password field. */
  loginOnly?: boolean
}

/**
 * Name / id / label heuristics in priority order (a field matching several takes the first).
 * Patterns are matched against a normalised bag of the attributes, so `card_number`,
 * `cardNumber` and "Card number" all read as `card number`.
 */
const RULES: Rule[] = [
  { kind: 'cc-csc', test: /\b(cvc|cvv|cvn|csc|cid|security code|card code|verification (code|value))\b/ },
  { kind: 'cc-number', test: /\b(card number|cardnumber|cc ?number|ccnum|card no|pan|credit card|debit card)\b/ },
  { kind: 'cc-exp-month', test: /\b(exp(iry|iration)?( date)? ?month|exp ?mm|ccmonth|cc ?exp ?m|mm)\b/ },
  { kind: 'cc-exp-year', test: /\b(exp(iry|iration)?( date)? ?year|exp ?yy(yy)?|ccyear|cc ?exp ?y|yy(yy)?)\b/ },
  { kind: 'cc-exp', test: /\b(exp(iry|iration)?( date)?|valid (thru|until|to)|mm ?\/ ?yy(yy)?|cc ?exp)\b/ },
  { kind: 'cc-name', test: /\b(card ?holder|name on card|cardholder name|cc ?name|card name)\b/ },
  { kind: 'one-time-code', test: /\b(one time code|otp|verification code|2fa|two factor|totp|mfa code|security code)\b/ },
  { kind: 'postal-code', test: /\b(zip|zip ?code|postal|postal ?code|post ?code|pin ?code|postcode|eircode)\b/ },
  { kind: 'address-line2', test: /\b(address ?(line)? ?2|addr2|address2|apt|apartment|suite|unit|floor|building)\b/ },
  { kind: 'address-line1', test: /\b(address ?(line)? ?1|addr1|address1|street ?address|street|address|shipping address|billing address|house number)\b/ },
  { kind: 'address-level2', test: /\b(city|town|locality|suburb|municipality|village)\b/ },
  { kind: 'address-level1', test: /\b(state|province|region|county|prefecture|territory)\b/ },
  { kind: 'country', test: /\b(country|nation)\b/ },
  { kind: 'organization', test: /\b(company|organi[sz]ation|business|employer|firm)\b/ },
  { kind: 'given-name', test: /\b(first ?name|given ?name|fname|forename|firstname)\b/ },
  { kind: 'family-name', test: /\b(last ?name|surname|family ?name|lname|lastname)\b/ },
  { kind: 'email', test: /\b(e ?mail|email address)\b/ },
  { kind: 'tel', test: /\b(phone|telephone|mobile|cell|tel|phone number)\b/ },
  { kind: 'name', test: /\b(full ?name|your name|name|contact name|recipient)\b/ },
  {
    kind: 'username',
    test: /\b(user ?name|username|login|log in|user ?id|userid|account|identifier|screen ?name|handle|member ?id|customer ?id|nickname|uid|user)\b/,
    loginOnly: true
  }
]

const SEARCH_LIKE = /\b(search|query|q|keyword|find|lookup|filter)\b/

/** Turn an attribute bag into lower-case words (`cardNumber` → `card number`, `cc_exp-mm` → `cc exp mm`). */
export function normaliseSignal(text: string): string {
  return text
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_\-.[\]:/]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/**
 * Classify one control. `autocomplete` wins; then the input type; then the heuristics on name,
 * id, placeholder and label. `hasPasswordField` says whether the surrounding form has one, which
 * lets a bare text field count as a username there and not on a search page.
 */
export function classifyField(
  signals: FieldSignals,
  context: { hasPasswordField: boolean }
): FormFieldKind | null {
  const fromAutocomplete = kindFromAutocomplete(signals.autocomplete)
  if (signals.type === 'password') {
    if (fromAutocomplete === 'new-password') return 'new-password'
    const bag = normaliseSignal(`${signals.name} ${signals.id} ${signals.placeholder} ${signals.label}`)
    if (/\b(new|confirm|repeat|retype|verify|create|choose|again|register|signup|sign up)\b/.test(bag))
      return 'new-password'
    return 'password'
  }
  if (fromAutocomplete) {
    // A password token on a non-password control is a mistake in the page; keep the text kinds.
    if (fromAutocomplete === 'password' || fromAutocomplete === 'new-password') return null
    return fromAutocomplete
  }
  if (signals.tag === 'input') {
    if (
      [
        'hidden',
        'submit',
        'button',
        'reset',
        'image',
        'checkbox',
        'radio',
        'file',
        'range',
        'color',
        'date',
        'datetime-local',
        'month',
        'week',
        'time'
      ].includes(signals.type)
    )
      return null
    if (signals.type === 'email') return 'email'
    if (signals.type === 'tel') return 'tel'
  }
  const bag = normaliseSignal(`${signals.name} ${signals.id} ${signals.placeholder} ${signals.label}`)
  if (!bag) return null
  if (signals.type === 'search' || (SEARCH_LIKE.test(bag) && !context.hasPasswordField)) return null
  for (const rule of RULES) {
    if (rule.loginOnly && !context.hasPasswordField) continue
    if (rule.kind === 'cc-exp-month' || rule.kind === 'cc-exp-year') {
      // Bare `mm` / `yy` are only expiry parts next to a card number or an "exp" word.
      if (!/\b(exp|card|cc|valid)\b/.test(bag) && !/\bmm\b.*\byy/.test(bag) && signals.tag !== 'select')
        continue
    }
    if (rule.test.test(bag)) return rule.kind
  }
  return null
}

/** Which group a form's classified fields make it, or null when they are too few to matter. */
export function groupOfForm(kinds: FormFieldKind[]): FormGroup | null {
  if (kinds.includes('password') || kinds.includes('new-password')) return 'login'
  if (kinds.includes('cc-number')) return 'card'
  const address = new Set(
    kinds.filter((k) =>
      [
        'street-address',
        'address-line1',
        'address-line2',
        'address-level1',
        'address-level2',
        'postal-code',
        'country'
      ].includes(k)
    )
  )
  if (address.size >= 2) return 'address'
  if (kinds.includes('username') || (kinds.includes('email') && kinds.length === 1)) return 'login'
  return null
}

/**
 * Resolve the group of one field inside its form: card fields always belong to the card group;
 * a login form owns its username / password fields and nothing else; contact fields go with an
 * address group when the form has one.
 */
export function groupOfField(kind: FormFieldKind, formGroup: FormGroup | null): FormGroup | null {
  const own = groupOfKind(kind)
  if (own === 'card') return 'card'
  if (own === 'login') return formGroup === 'login' ? 'login' : null
  if (kind === 'email' && formGroup === 'login') return 'login'
  return formGroup === 'address' ? 'address' : null
}

// ---------------------------------------------------------------------------
// The script
// ---------------------------------------------------------------------------

type Control = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement

/** Submit buttons are recognised by type, and by their text when the page uses plain buttons. */
const SUBMIT_TEXT =
  /\b(log ?in|sign ?in|sign ?up|register|continue|next|submit|create account|join|pay|place order|buy|checkout|save|confirm|verify|proceed|update|done|ok|enter|go)\b/i

/** How long a login submit stays a candidate for `settled` before the page is assumed to have refused it. */
const SETTLE_WINDOW_MS = 20_000
const SETTLE_POLL_MS = 400
/** Two submit signals for one form this close together are one submit. */
const SUBMIT_DEDUPE_MS = 600

function isControl(node: EventTarget | null): node is Control {
  return (
    node instanceof HTMLInputElement ||
    node instanceof HTMLSelectElement ||
    node instanceof HTMLTextAreaElement
  )
}

function isVisible(el: Element): boolean {
  if (!(el instanceof HTMLElement)) return false
  if (el instanceof HTMLInputElement && el.type === 'hidden') return false
  if (el.offsetWidth <= 0 && el.offsetHeight <= 0) {
    // A control the page positions off-screen or sizes to zero on purpose (custom-styled
    // selects) still counts when it takes focus; the rect check covers the rest.
    return document.activeElement === el
  }
  const style = window.getComputedStyle(el)
  return style.visibility !== 'hidden' && style.display !== 'none'
}

function labelText(el: Control): string {
  const parts: string[] = []
  const labels = (el as HTMLInputElement).labels
  if (labels) for (const label of labels) parts.push(label.textContent ?? '')
  const aria = el.getAttribute('aria-label')
  if (aria) parts.push(aria)
  const by = el.getAttribute('aria-labelledby')
  if (by)
    for (const id of by.split(/\s+/)) {
      const node = document.getElementById(id)
      if (node) parts.push(node.textContent ?? '')
    }
  if (parts.join('').trim() === '') {
    const wrapping = el.closest('label')
    if (wrapping) parts.push(wrapping.textContent ?? '')
    else {
      const parent = el.parentElement
      if (parent) {
        let own = ''
        for (const child of parent.childNodes)
          if (child.nodeType === Node.TEXT_NODE) own += child.textContent ?? ''
        if (own.trim()) parts.push(own)
        else {
          const prev = el.previousElementSibling
          if (prev && !isControl(prev) && (prev.textContent ?? '').trim().length <= 60)
            parts.push(prev.textContent ?? '')
        }
      }
    }
  }
  const title = el.getAttribute('title')
  if (title) parts.push(title)
  return parts.join(' ').replace(/\s+/g, ' ').trim().slice(0, 200)
}

export function signalsOf(el: Control): FieldSignals {
  const tag = el instanceof HTMLSelectElement ? 'select' : el instanceof HTMLTextAreaElement ? 'textarea' : 'input'
  return {
    tag,
    type: el instanceof HTMLInputElement ? el.type.toLowerCase() : '',
    autocomplete: el.getAttribute('autocomplete') ?? '',
    name: el.getAttribute('name') ?? '',
    id: el.id,
    placeholder: el.getAttribute('placeholder') ?? '',
    label: labelText(el),
    maxLength: el instanceof HTMLInputElement ? el.maxLength : -1
  }
}

interface ClassifiedForm {
  id: string
  container: Element
  group: FormGroup | null
  fields: Map<Control, FormFieldKind>
}

/** The form (or, without one, the document) a control belongs to. */
function containerOf(el: Control): Element {
  return el.form ?? el.closest('form') ?? document.documentElement
}

function controlsIn(container: Element): Control[] {
  const found: Control[] = []
  for (const el of container.querySelectorAll('input,select,textarea'))
    if (isControl(el) && isVisible(el)) found.push(el)
  return found
}

/**
 * Classify every visible control of a container. Password fields anchor the login group; when
 * no field declares itself the username, the last text / email field before the first password
 * takes the role (Chrome's rule). Two password fields with the same value are a confirmation and
 * both count as the new password.
 */
export function classifyContainer(container: Element): Map<Control, FormFieldKind> {
  const controls = controlsIn(container)
  const passwords = controls.filter((c) => c instanceof HTMLInputElement && c.type === 'password')
  const context = { hasPasswordField: passwords.length > 0 }
  const kinds = new Map<Control, FormFieldKind>()
  for (const control of controls) {
    const kind = classifyField(signalsOf(control), context)
    if (kind) kinds.set(control, kind)
  }
  if (passwords.length > 0) {
    if (passwords.length >= 2 && ![...kinds.values()].includes('new-password'))
      for (const p of passwords) kinds.set(p, 'new-password')
    if (![...kinds.values()].includes('username')) {
      const first = controls.indexOf(passwords[0])
      for (let i = first - 1; i >= 0; i--) {
        const c = controls[i]
        const kind = kinds.get(c)
        if (kind === 'email' || (!kind && c instanceof HTMLInputElement && c.type === 'text')) {
          kinds.set(c, 'username')
          break
        }
        if (kind && kind !== 'one-time-code') break
      }
    }
  }
  return kinds
}

function setNativeValue(el: Control, value: string): void {
  const proto =
    el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : el instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype
  const descriptor = Object.getOwnPropertyDescriptor(proto, 'value')
  if (descriptor?.set) descriptor.set.call(el, value)
  else el.value = value
}

/** Pick the option matching one of `candidates` by value or text (case-insensitive), if any. */
export function selectOption(select: HTMLSelectElement, candidates: string[]): boolean {
  const wanted = candidates.map((c) => c.trim().toLowerCase()).filter(Boolean)
  if (!wanted.length) return false
  const options = [...select.options]
  for (const candidate of wanted) {
    const hit =
      options.find((o) => o.value.trim().toLowerCase() === candidate) ??
      options.find((o) => (o.textContent ?? '').trim().toLowerCase() === candidate)
    if (hit) {
      select.value = hit.value
      return true
    }
  }
  for (const candidate of wanted) {
    const hit = options.find((o) => (o.textContent ?? '').trim().toLowerCase().startsWith(candidate))
    if (hit) {
      select.value = hit.value
      return true
    }
  }
  return false
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']

/** The strings a select may use for a value of `kind` (`01`, `1`, `Jan`; `2027`, `27`; `US`, `United States`). */
export function candidatesFor(
  kind: FormFieldKind,
  value: string,
  labels: { countryName?: string; regionName?: string }
): string[] {
  switch (kind) {
    case 'cc-exp-month': {
      const n = parseInt(value, 10)
      if (!Number.isFinite(n)) return [value]
      const name = MONTHS[n - 1] ?? ''
      return [String(n).padStart(2, '0'), String(n), name, name.slice(0, 3)]
    }
    case 'cc-exp-year':
      return value.length === 4 ? [value, value.slice(2)] : [value, `20${value}`]
    case 'country':
      return [value, labels.countryName ?? '']
    case 'address-level1':
      return [value, labels.regionName ?? '']
    default:
      return [value]
  }
}

/** Format a text expiry field the way its placeholder or length asks (`MM/YY` or `MM/YYYY`). */
export function expiryText(value: string, signals: Pick<FieldSignals, 'placeholder' | 'maxLength'>): string {
  const m = /^(\d{1,2})\s*\/\s*(\d{2,4})$/.exec(value.trim())
  if (!m) return value
  const month = m[1].padStart(2, '0')
  const year = m[2].length === 2 ? `20${m[2]}` : m[2]
  const longYear = /yyyy/i.test(signals.placeholder) || signals.maxLength >= 7
  return `${month}/${longYear ? year : year.slice(2)}`
}

function fireInput(el: Control, value: string): void {
  const InputEventCtor = typeof InputEvent === 'function' ? InputEvent : null
  const input = InputEventCtor
    ? new InputEventCtor('input', { bubbles: true, inputType: 'insertReplacementText', data: value })
    : new Event('input', { bubbles: true })
  el.dispatchEvent(input)
  el.dispatchEvent(new Event('change', { bubbles: true }))
}

export function installFormsScript(transport: FormsTransport): void {
  let enabled = true
  let filling = false
  const ids = new WeakMap<Element, string>()
  const byId = new Map<string, Element>()
  let seq = 0
  const idOf = (el: Element): string => {
    let id = ids.get(el)
    if (!id) {
      id = `f${++seq}`
      ids.set(el, id)
      byId.set(id, el)
    }
    return id
  }
  const forms = new Map<string, ClassifiedForm>()
  let focused: { control: Control; formId: string; fieldId: string } | null = null
  let lastSubmit: { formId: string; at: number } | null = null
  let settle: { formId: string; control: Control; href: string; started: number; timer: number } | null = null

  const classify = (container: Element): ClassifiedForm => {
    for (const [id, el] of byId) if (!el.isConnected) byId.delete(id)
    const fields = classifyContainer(container)
    const id = idOf(container)
    const form: ClassifiedForm = { id, container, group: groupOfForm([...fields.values()]), fields }
    forms.set(id, form)
    return form
  }

  const rectOf = (el: Element): Rect => {
    const r = el.getBoundingClientRect()
    const vv = window.visualViewport
    const scale = vv?.scale ?? 1
    const ox = vv?.offsetLeft ?? 0
    const oy = vv?.offsetTop ?? 0
    return {
      x: (r.left - ox) * scale,
      y: (r.top - oy) * scale,
      width: r.width * scale,
      height: r.height * scale
    }
  }

  const fieldsInfo = (form: ClassifiedForm, group: FormGroup): FormFieldInfo[] => {
    const info: FormFieldInfo[] = []
    for (const [control, kind] of form.fields)
      if (groupOfField(kind, form.group) === group)
        info.push({ id: idOf(control), kind, hasValue: control.value.trim() !== '' })
    return info
  }

  const onFocusIn = (event: FocusEvent): void => {
    if (!enabled || filling) return
    const target = event.target
    if (!isControl(target) || !isVisible(target)) return
    const form = classify(containerOf(target))
    const kind = form.fields.get(target)
    if (!kind) return
    const group = groupOfField(kind, form.group)
    if (!group || kind === 'one-time-code' || kind === 'cc-csc') return
    focused = { control: target, formId: form.id, fieldId: idOf(target) }
    transport.send({
      type: 'focus',
      group,
      formId: form.id,
      fieldId: focused.fieldId,
      kind,
      rect: rectOf(target),
      hasValue: target.value.trim() !== '',
      fields: fieldsInfo(form, group)
    })
  }

  const onFocusOut = (event: FocusEvent): void => {
    if (!focused || filling) return
    if (event.target !== focused.control) return
    focused = null
    transport.send({ type: 'blur' })
  }

  let moveFrame = 0
  const onMoved = (): void => {
    if (!focused || moveFrame) return
    moveFrame = requestAnimationFrame(() => {
      moveFrame = 0
      if (focused) transport.send({ type: 'moved', fieldId: focused.fieldId, rect: rectOf(focused.control) })
    })
  }

  const gather = (form: ClassifiedForm): FormValues => {
    const values: FormValues = {}
    for (const [control, kind] of form.fields) {
      const value = control.value.trim()
      if (!value) continue
      if (kind === 'cc-csc' || kind === 'one-time-code') continue
      if (control instanceof HTMLSelectElement) {
        const option = control.options[control.selectedIndex]
        values[kind] = option ? `${option.value}|${(option.textContent ?? '').trim()}` : value
      } else if (!(kind in values)) values[kind] = value
    }
    return values
  }

  /** Report a submit of `container` once, whichever signal (event, click, Enter) saw it first. */
  const submitted = (container: Element): void => {
    if (!enabled) return
    const form = classify(container)
    const now = Date.now()
    if (lastSubmit && lastSubmit.formId === form.id && now - lastSubmit.at < SUBMIT_DEDUPE_MS) return
    lastSubmit = { formId: form.id, at: now }
    if (form.group === 'login') {
      const values = gather(form)
      const passwordControl = [...form.fields].find(([, k]) => k === 'password' || k === 'new-password')?.[0]
      const password = values['new-password'] ?? values.password ?? ''
      const username = values.username ?? values.email ?? ''
      if (!password && !username) return
      transport.send({
        type: 'submit',
        group: 'login',
        formId: form.id,
        username,
        password,
        newPassword: 'new-password' in values
      })
      if (password && passwordControl) watchSettle(form.id, passwordControl)
      return
    }
    const values = gather(form)
    const cardFields = Object.keys(values).filter((k) => groupOfKind(k as FormFieldKind) === 'card')
    if (cardFields.length) {
      const card: FormValues = {}
      for (const k of cardFields) card[k as FormFieldKind] = values[k as FormFieldKind]
      if (values['cc-number']) transport.send({ type: 'submit', group: 'card', formId: form.id, values: card })
    }
    if (form.group === 'address') {
      const address: FormValues = {}
      for (const [k, v] of Object.entries(values))
        if (groupOfKind(k as FormFieldKind) === 'address') address[k as FormFieldKind] = v
      transport.send({ type: 'submit', group: 'address', formId: form.id, values: address })
    }
  }

  /**
   * After a login submit, watch for the page signing the user in without navigating: the password
   * field leaves the document (or is hidden), or the URL changes through the history API.
   */
  const watchSettle = (formId: string, control: Control): void => {
    if (settle) clearInterval(settle.timer)
    const started = Date.now()
    const href = location.href
    const timer = window.setInterval(() => {
      if (!settle || settle.formId !== formId) return
      const gone = !control.isConnected || !isVisible(control)
      const moved = location.href !== href
      if (gone || moved) {
        clearInterval(timer)
        settle = null
        transport.send({ type: 'settled', formId })
        return
      }
      if (Date.now() - started > SETTLE_WINDOW_MS) {
        clearInterval(timer)
        settle = null
      }
    }, SETTLE_POLL_MS)
    settle = { formId, control, href, started, timer }
  }

  const submitButtonForm = (target: EventTarget | null): Element | null => {
    let el = target instanceof Element ? target : null
    for (let depth = 0; el && depth < 6; depth++) {
      if (el instanceof HTMLButtonElement || el instanceof HTMLInputElement) {
        const type = (el.getAttribute('type') ?? (el instanceof HTMLButtonElement ? 'submit' : '')).toLowerCase()
        if (type === 'submit' || type === 'image') return el.form ?? el.closest('form') ?? document.documentElement
        if (type === 'button' && SUBMIT_TEXT.test(el.textContent ?? (el as HTMLInputElement).value ?? ''))
          return el.form ?? el.closest('form') ?? document.documentElement
        return null
      }
      if (el.getAttribute('role') === 'button' || el instanceof HTMLAnchorElement) {
        return SUBMIT_TEXT.test(el.textContent ?? '') ? (el.closest('form') ?? document.documentElement) : null
      }
      el = el.parentElement
    }
    return null
  }

  const fill = (command: Extract<FormsCommand, { type: 'fill' }>): void => {
    const form = forms.get(command.formId)
    if (!form || !form.container.isConnected) return
    const fresh = classify(form.container)
    const labels = command.labels ?? {}
    filling = true
    try {
      const only = command.fieldId ? byId.get(command.fieldId) : null
      let firstFilled: Control | null = null
      for (const [control, kind] of fresh.fields) {
        if (only && control !== only) continue
        if (!FILLABLE_KINDS.has(kind)) continue
        const value = command.values[kind]
        if (value === undefined || value === '') continue
        if (control instanceof HTMLSelectElement) {
          if (!selectOption(control, candidatesFor(kind, value, labels))) continue
          fireInput(control, control.value)
        } else {
          if (control instanceof HTMLInputElement && control.readOnly) continue
          const text =
            kind === 'cc-exp' ? expiryText(value, signalsOf(control)) : kind === 'cc-exp-year' && control.maxLength === 2 ? value.slice(-2) : value
          control.focus()
          setNativeValue(control, text)
          fireInput(control, text)
        }
        firstFilled ??= control
      }
      // Leave the caret where the user was, or on the first filled field for a whole-form fill.
      const back = only && isControl(only) ? only : firstFilled
      back?.focus()
    } finally {
      filling = false
    }
  }

  transport.onCommand((command) => {
    if (command.type === 'config') {
      enabled = command.enabled
      if (!enabled && focused) {
        focused = null
        transport.send({ type: 'blur' })
      }
      return
    }
    if (command.type === 'fill') fill(command)
  })

  window.addEventListener('focusin', onFocusIn, true)
  window.addEventListener('focusout', onFocusOut, true)
  window.addEventListener('scroll', onMoved, { capture: true, passive: true })
  window.addEventListener('resize', onMoved, { passive: true })
  window.visualViewport?.addEventListener('scroll', onMoved, { passive: true })
  window.visualViewport?.addEventListener('resize', onMoved, { passive: true })
  window.addEventListener(
    'submit',
    (event) => {
      if (event.target instanceof Element) submitted(event.target)
    },
    true
  )
  window.addEventListener(
    'click',
    (event) => {
      if (!event.isTrusted || event.button !== 0) return
      const container = submitButtonForm(event.target)
      // Let the click land first so frameworks read the final field values.
      if (container) setTimeout(() => submitted(container), 0)
    },
    true
  )
  window.addEventListener(
    'keydown',
    (event) => {
      if (event.key !== 'Enter' || !event.isTrusted) return
      const target = event.target
      if (!isControl(target) || target instanceof HTMLTextAreaElement) return
      const container = containerOf(target)
      setTimeout(() => submitted(container), 0)
    },
    true
  )
  window.addEventListener(
    'message',
    (event: MessageEvent) => {
      const data: unknown = event.data
      if (!data || typeof data !== 'object' || event.source !== window) return
      const report = (data as { __zeniumPasskey?: unknown }).__zeniumPasskey
      if (!report || typeof report !== 'object') return
      const r = report as Record<string, unknown>
      const str = (v: unknown): string => (typeof v === 'string' ? v.slice(0, 512) : '')
      if (r.op !== 'create' && r.op !== 'get') return
      transport.send({
        type: 'passkey',
        op: r.op,
        rpId: str(r.rpId) || location.hostname,
        rpName: str(r.rpName),
        userName: str(r.userName),
        userDisplayName: str(r.userDisplayName),
        credentialId: str(r.credentialId)
      })
    }
  )
}
