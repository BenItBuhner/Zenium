// @vitest-environment happy-dom
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FormsCommand, FormsEvent } from '../forms'
import {
  candidatesFor,
  classifyContainer,
  classifyField,
  expiryText,
  groupOfField,
  groupOfForm,
  groupsOfForm,
  installFormsScript,
  kindFromAutocomplete,
  normaliseSignal,
  selectOption,
  type FieldSignals
} from '../formsScript'
import { installPasskeyObserver } from '../passkeyObserver'

// happy-dom does no layout: every element is 0×0. The script treats such controls as hidden
// (unless focused), so the tests give elements a size, taking `hidden` and display:none away again.
beforeAll(() => {
  const size = function (this: HTMLElement): number {
    if (this.hidden || this.style.display === 'none') return 0
    return 100
  }
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { get: size, configurable: true })
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { get: size, configurable: true })
  Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
    configurable: true,
    value: function (this: HTMLElement): DOMRect {
      const [x, y, w, h] = (this.dataset.rect ?? '0,0,0,0').split(',').map(Number)
      return {
        x,
        y,
        left: x,
        top: y,
        width: w,
        height: h,
        right: x + w,
        bottom: y + h,
        toJSON: () => ({})
      } as DOMRect
    }
  })
})

/** happy-dom lets a test mark an event as trusted; browsers only do so for real input. */
function trusted<T extends Event>(e: T): T {
  Object.defineProperty(e, 'isTrusted', { value: true, configurable: true })
  return e
}

function signals(overrides: Partial<FieldSignals> = {}): FieldSignals {
  return {
    tag: 'input',
    type: 'text',
    autocomplete: '',
    name: '',
    id: '',
    placeholder: '',
    label: '',
    maxLength: -1,
    ...overrides
  }
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

// ---------------------------------------------------------------------------
// Pure classification
// ---------------------------------------------------------------------------

describe('kindFromAutocomplete', () => {
  it('finds the field token among section and contact tokens; ignores on/off', () => {
    expect(kindFromAutocomplete('section-blue shipping tel')).toBe('tel')
    expect(kindFromAutocomplete('Current-Password')).toBe('password')
    expect(kindFromAutocomplete('cc-given-name')).toBe('cc-name')
    expect(kindFromAutocomplete('country-name')).toBe('country')
    expect(kindFromAutocomplete('off')).toBeNull()
    expect(kindFromAutocomplete('on')).toBeNull()
    expect(kindFromAutocomplete('')).toBeNull()
  })
})

describe('normaliseSignal', () => {
  it('splits camel case and punctuation into lower-case words', () => {
    expect(normaliseSignal('cardNumber')).toBe('card number')
    expect(normaliseSignal('cc_exp-mm')).toBe('cc exp mm')
    expect(normaliseSignal('billing[postal_code]')).toBe('billing postal code')
    expect(normaliseSignal('  Card   Number ')).toBe('card number')
  })
})

describe('classifyField', () => {
  const login = { hasPasswordField: true }
  const plain = { hasPasswordField: false }

  it('lets autocomplete win over everything', () => {
    expect(classifyField(signals({ autocomplete: 'email', name: 'user' }), login)).toBe('email')
    expect(classifyField(signals({ autocomplete: 'username', type: 'email' }), login)).toBe(
      'username'
    )
    expect(
      classifyField(signals({ autocomplete: 'shipping postal-code', name: 'city' }), plain)
    ).toBe('postal-code')
  })

  it('tells current from new passwords', () => {
    expect(classifyField(signals({ type: 'password', name: 'password' }), login)).toBe('password')
    expect(classifyField(signals({ type: 'password', autocomplete: 'new-password' }), login)).toBe(
      'new-password'
    )
    expect(classifyField(signals({ type: 'password', name: 'confirm_password' }), login)).toBe(
      'new-password'
    )
    expect(classifyField(signals({ type: 'password', label: 'Choose a password' }), login)).toBe(
      'new-password'
    )
    expect(
      classifyField(signals({ type: 'password', placeholder: 'Repeat password' }), login)
    ).toBe('new-password')
    // A password autocomplete token on a text control is a page mistake.
    expect(classifyField(signals({ autocomplete: 'current-password' }), login)).toBeNull()
  })

  it('reads the input type and the name / id / label heuristics', () => {
    expect(classifyField(signals({ type: 'email' }), plain)).toBe('email')
    expect(classifyField(signals({ type: 'tel' }), plain)).toBe('tel')
    expect(classifyField(signals({ name: 'cardNumber' }), plain)).toBe('cc-number')
    expect(classifyField(signals({ id: 'cc-csc', label: 'CVC' }), plain)).toBe('cc-csc')
    expect(classifyField(signals({ name: 'exp_month' }), plain)).toBe('cc-exp-month')
    expect(classifyField(signals({ name: 'exp_year' }), plain)).toBe('cc-exp-year')
    expect(classifyField(signals({ placeholder: 'MM / YY' }), plain)).toBe('cc-exp')
    expect(classifyField(signals({ label: 'Name on card' }), plain)).toBe('cc-name')
    expect(classifyField(signals({ name: 'zip' }), plain)).toBe('postal-code')
    expect(classifyField(signals({ name: 'address2', placeholder: 'Apt, suite' }), plain)).toBe(
      'address-line2'
    )
    expect(classifyField(signals({ name: 'address1' }), plain)).toBe('address-line1')
    expect(classifyField(signals({ label: 'Street address' }), plain)).toBe('address-line1')
    expect(classifyField(signals({ name: 'city' }), plain)).toBe('address-level2')
    expect(classifyField(signals({ tag: 'select', type: '', name: 'state' }), plain)).toBe(
      'address-level1'
    )
    expect(classifyField(signals({ tag: 'select', type: '', name: 'country' }), plain)).toBe(
      'country'
    )
    expect(classifyField(signals({ name: 'company' }), plain)).toBe('organization')
    expect(classifyField(signals({ name: 'firstName' }), plain)).toBe('given-name')
    expect(classifyField(signals({ name: 'lname' }), plain)).toBe('family-name')
    expect(classifyField(signals({ label: 'Full name' }), plain)).toBe('name')
    expect(classifyField(signals({ name: 'phone' }), plain)).toBe('tel')
    expect(classifyField(signals({ name: 'otp', label: 'Verification code' }), login)).toBe(
      'one-time-code'
    )
  })

  it('counts a username only next to a password, and never a search box', () => {
    expect(classifyField(signals({ name: 'username' }), login)).toBe('username')
    expect(classifyField(signals({ name: 'login' }), login)).toBe('username')
    expect(classifyField(signals({ name: 'username' }), plain)).toBeNull()
    expect(classifyField(signals({ type: 'search', name: 'username' }), login)).toBeNull()
    expect(classifyField(signals({ name: 'q' }), plain)).toBeNull()
    expect(classifyField(signals({ name: 'search' }), plain)).toBeNull()
  })

  it('does not take bare mm / yy for expiry parts away from a card context', () => {
    expect(classifyField(signals({ name: 'mm' }), plain)).toBeNull()
    expect(classifyField(signals({ name: 'card_exp_mm' }), plain)).toBe('cc-exp-month')
    expect(classifyField(signals({ tag: 'select', type: '', name: 'yy' }), plain)).toBe(
      'cc-exp-year'
    )
  })

  it('ignores controls that cannot hold text', () => {
    for (const type of ['hidden', 'submit', 'checkbox', 'radio', 'file', 'date', 'range'])
      expect(classifyField(signals({ type, name: 'email' }), plain), type).toBeNull()
    expect(classifyField(signals({ name: 'x9' }), plain)).toBeNull()
  })
})

describe('groupsOfForm / groupOfForm / groupOfField', () => {
  const groups = (kinds: Parameters<typeof groupsOfForm>[0]): string[] =>
    [...groupsOfForm(kinds)].sort()

  it('names the groups from the classified fields; a checkout is card and address at once', () => {
    expect(groups(['username', 'password'])).toEqual(['login'])
    expect(groups(['email', 'new-password', 'new-password'])).toEqual(['login'])
    expect(groups(['cc-number', 'cc-exp', 'cc-csc'])).toEqual(['card'])
    expect(groups(['name', 'address-line1', 'address-level2', 'postal-code', 'tel'])).toEqual([
      'address'
    ])
    expect(
      groups(['address-line1', 'address-level2', 'postal-code', 'cc-number', 'cc-exp'])
    ).toEqual(['address', 'card'])
    expect(groups(['name', 'email', 'tel'])).toEqual([])
    expect(groups(['postal-code'])).toEqual([])
    expect(groups(['email'])).toEqual(['login'])
    expect(groups(['username'])).toEqual(['login'])
    expect(groups([])).toEqual([])
  })

  it('picks the main group of a form for its submit', () => {
    expect(groupOfForm(['username', 'password', 'postal-code', 'address-level2'])).toBe('login')
    expect(groupOfForm(['cc-number', 'postal-code', 'address-level2'])).toBe('card')
    expect(groupOfForm(['postal-code', 'address-level2'])).toBe('address')
    expect(groupOfForm(['name'])).toBeNull()
  })

  it('puts contact fields with the address, login fields only in login forms, cards anywhere', () => {
    const login = new Set<'login'>(['login'])
    const address = new Set<'address'>(['address'])
    const none = new Set<never>()
    expect(groupOfField('email', login)).toBe('login')
    expect(groupOfField('email', address)).toBe('address')
    expect(groupOfField('email', none)).toBeNull()
    expect(groupOfField('username', none)).toBeNull()
    expect(groupOfField('username', address)).toBeNull()
    expect(groupOfField('cc-number', address)).toBe('card')
    expect(groupOfField('cc-number', none)).toBe('card')
    expect(groupOfField('tel', address)).toBe('address')
    expect(groupOfField('postal-code', login)).toBeNull()
    expect(groupOfField('postal-code', new Set(['login', 'address'] as const))).toBe('address')
  })
})

describe('select and expiry helpers', () => {
  it('lists the spellings a select may use for months, years, countries and regions', () => {
    expect(candidatesFor('cc-exp-month', '04', {})).toEqual(['04', '4', 'april', 'apr'])
    expect(candidatesFor('cc-exp-year', '2027', {})).toEqual(['2027', '27'])
    expect(candidatesFor('cc-exp-year', '27', {})).toEqual(['27', '2027'])
    expect(candidatesFor('country', 'US', { countryName: 'United States' })).toEqual([
      'US',
      'United States'
    ])
    expect(candidatesFor('address-level1', 'CA', { regionName: 'California' })).toEqual([
      'CA',
      'California'
    ])
    expect(candidatesFor('tel', '555', {})).toEqual(['555'])
  })

  it('picks a select option by value, by text, then by text prefix', () => {
    document.body.innerHTML = `
      <select id="s">
        <option value="">Choose</option>
        <option value="223">Germany</option>
        <option value="US">United States of America</option>
      </select>`
    const select = document.getElementById('s') as HTMLSelectElement
    expect(selectOption(select, ['DE', 'Germany'])).toBe(true)
    expect(select.value).toBe('223')
    expect(selectOption(select, ['us'])).toBe(true)
    expect(select.value).toBe('US')
    expect(selectOption(select, ['United States'])).toBe(true)
    expect(select.value).toBe('US')
    expect(selectOption(select, ['Atlantis'])).toBe(false)
    expect(selectOption(select, [''])).toBe(false)
  })

  it('formats a text expiry the way the field asks', () => {
    expect(expiryText('03/2027', { placeholder: 'MM/YY', maxLength: -1 })).toBe('03/27')
    expect(expiryText('3/27', { placeholder: 'MM/YYYY', maxLength: -1 })).toBe('03/2027')
    expect(expiryText('03/2027', { placeholder: '', maxLength: 7 })).toBe('03/2027')
    expect(expiryText('03/2027', { placeholder: '', maxLength: 5 })).toBe('03/27')
    expect(expiryText('soon', { placeholder: '', maxLength: -1 })).toBe('soon')
  })
})

// ---------------------------------------------------------------------------
// Classifying whole forms
// ---------------------------------------------------------------------------

function kinds(form: Element): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [control, kind] of classifyContainer(form))
    out[control.id || control.getAttribute('name') || '?'] = kind
  return out
}

describe('classifyContainer', () => {
  it('takes the text field before the password as the username when nothing says so', () => {
    document.body.innerHTML = `
      <form id="f">
        <input id="remember" type="checkbox">
        <input id="who" type="text">
        <input id="pw" type="password">
        <button type="submit">Log in</button>
      </form>`
    expect(kinds(document.getElementById('f')!)).toEqual({ who: 'username', pw: 'password' })
  })

  it('takes an email field as the username and two passwords as a sign-up', () => {
    document.body.innerHTML = `
      <form id="f">
        <label for="mail">Email</label><input id="mail" type="email">
        <input id="p1" type="password" placeholder="Password">
        <input id="p2" type="password" placeholder="Password">
      </form>`
    expect(kinds(document.getElementById('f')!)).toEqual({
      mail: 'username',
      p1: 'new-password',
      p2: 'new-password'
    })
  })

  it('leaves hidden controls out and finds labels through for=, wrapping labels and aria', () => {
    document.body.innerHTML = `
      <form id="f">
        <input id="csrf" type="hidden" name="username">
        <input id="gone" type="text" name="username" hidden>
        <label for="a">City</label><input id="a" type="text">
        <label>Postal code <input id="b" type="text"></label>
        <input id="c" type="text" aria-label="Street address">
        <span id="lbl">Country</span><select id="d" aria-labelledby="lbl"><option>US</option></select>
      </form>`
    expect(kinds(document.getElementById('f')!)).toEqual({
      a: 'address-level2',
      b: 'postal-code',
      c: 'address-line1',
      d: 'country'
    })
  })

  it('classifies a payment form', () => {
    document.body.innerHTML = `
      <form id="f">
        <input id="n" name="cardholder">
        <input id="num" name="cardNumber" inputmode="numeric">
        <select id="m" name="exp_month"><option>01</option></select>
        <select id="y" name="exp_year"><option>2030</option></select>
        <input id="cvc" name="cvc" maxlength="4">
      </form>`
    expect(kinds(document.getElementById('f')!)).toEqual({
      n: 'cc-name',
      num: 'cc-number',
      m: 'cc-exp-month',
      y: 'cc-exp-year',
      cvc: 'cc-csc'
    })
  })

  it('reads "security code" as the card’s next to a card number, and as a one-time code elsewhere', () => {
    document.body.innerHTML = `
      <form id="pay"><input id="num" name="cardNumber"><input id="sec" placeholder="Security code"></form>
      <form id="mfa"><input id="code" placeholder="Security code"></form>`
    expect(kinds(document.getElementById('pay')!)).toEqual({ num: 'cc-number', sec: 'cc-csc' })
    expect(kinds(document.getElementById('mfa')!)).toEqual({ code: 'one-time-code' })
  })

  it('does not read a search page as a login form', () => {
    document.body.innerHTML = `<form id="f"><input id="q" name="q" placeholder="Search"><input id="u" name="user"></form>`
    expect(kinds(document.getElementById('f')!)).toEqual({})
  })
})

// ---------------------------------------------------------------------------
// The installed script
// ---------------------------------------------------------------------------

interface Installed {
  sent: FormsEvent[]
  command: (c: FormsCommand) => void
}

function install(): Installed {
  const sent: FormsEvent[] = []
  let listener: ((c: FormsCommand) => void) | null = null
  installFormsScript({
    send: (e) => {
      sent.push(e)
    },
    onCommand: (l) => {
      listener = l
    }
  })
  return { sent, command: (c) => listener?.(c) }
}

const LOGIN_FORM = `
  <form id="login" action="/session" method="post">
    <input id="user" name="username" data-rect="10,20,200,32">
    <input id="pw" name="password" type="password">
    <button id="go" type="submit">Sign in</button>
  </form>`

describe('forms script: focus, blur, fill', () => {
  let cleanup: (() => void) | null = null
  beforeEach(() => {
    document.body.innerHTML = LOGIN_FORM
  })
  afterEach(() => {
    cleanup?.()
    cleanup = null
    document.body.innerHTML = ''
    ;(document.activeElement as HTMLElement | null)?.blur?.()
  })

  it('reports a classified field taking focus, with the form’s fields and rectangle, then its blur', () => {
    const { sent } = install()
    const user = document.getElementById('user') as HTMLInputElement
    user.focus()
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({
      type: 'focus',
      group: 'login',
      kind: 'username',
      rect: { x: 10, y: 20, width: 200, height: 32 },
      hasValue: false
    })
    const focus = sent[0] as Extract<FormsEvent, { type: 'focus' }>
    expect(focus.fields.map((f) => f.kind)).toEqual(['username', 'password'])
    expect(focus.fields.every((f) => !f.hasValue)).toBe(true)
    user.blur()
    expect(sent[1]).toEqual({ type: 'blur' })
  })

  it('says nothing for a field outside any group, or when switched off', () => {
    document.body.innerHTML += `<form id="other"><input id="q" name="q"></form>`
    const { sent, command } = install()
    ;(document.getElementById('q') as HTMLInputElement).focus()
    expect(sent).toEqual([])
    command({ type: 'config', enabled: false })
    ;(document.getElementById('user') as HTMLInputElement).focus()
    expect(sent).toEqual([])
    command({ type: 'config', enabled: true })
    ;(document.getElementById('pw') as HTMLInputElement).focus()
    expect(sent.map((e) => e.type)).toEqual(['focus'])
  })

  it('fills the form’s fields with native events and leaves the caret where the user was', () => {
    const { sent, command } = install()
    const user = document.getElementById('user') as HTMLInputElement
    const pw = document.getElementById('pw') as HTMLInputElement
    const seen: string[] = []
    for (const el of [user, pw]) {
      el.addEventListener('input', (e) =>
        seen.push(`${el.id}:input:${(e as InputEvent).inputType ?? ''}`)
      )
      el.addEventListener('change', () => seen.push(`${el.id}:change`))
    }
    user.focus()
    const focus = sent[0] as Extract<FormsEvent, { type: 'focus' }>
    command({
      type: 'fill',
      formId: focus.formId,
      values: { username: 'ada', password: 'hunter2' }
    })
    expect(user.value).toBe('ada')
    expect(pw.value).toBe('hunter2')
    expect(seen).toEqual([
      'user:input:insertReplacementText',
      'user:change',
      'pw:input:insertReplacementText',
      'pw:change'
    ])
    // The fill's own focus moves are not reported as new focus events.
    expect(sent.filter((e) => e.type === 'focus')).toHaveLength(1)
    expect(document.activeElement).toBe(user)
  })

  it('fills one field only when asked, skips read-only fields, and ignores unknown forms', () => {
    const { sent, command } = install()
    const user = document.getElementById('user') as HTMLInputElement
    const pw = document.getElementById('pw') as HTMLInputElement
    user.focus()
    const focus = sent[0] as Extract<FormsEvent, { type: 'focus' }>
    command({
      type: 'fill',
      formId: focus.formId,
      fieldId: focus.fieldId,
      values: { username: 'ada', password: 'x' }
    })
    expect(user.value).toBe('ada')
    expect(pw.value).toBe('')
    user.value = ''
    user.readOnly = true
    command({ type: 'fill', formId: focus.formId, values: { username: 'ada', password: 'x' } })
    expect(user.value).toBe('')
    expect(pw.value).toBe('x')
    command({ type: 'fill', formId: 'nope', values: { username: 'zzz' } })
    expect(user.value).toBe('')
  })

  it('fills selects by code or label and formats expiry fields', () => {
    document.body.innerHTML = `
      <form id="ship">
        <input id="street" name="address1">
        <input id="city" name="city">
        <select id="state" name="state"><option value="">-</option><option value="5">California</option></select>
        <input id="zip" name="zip">
        <select id="country" name="country"><option value="">-</option><option value="usa">United States</option></select>
      </form>
      <form id="pay">
        <input id="num" name="cardNumber">
        <input id="exp" name="exp" placeholder="MM / YY">
        <select id="mon" name="exp_month"><option value="">-</option><option value="3">March</option></select>
        <input id="yr" name="exp_year" maxlength="2">
      </form>`
    const { sent, command } = install()
    ;(document.getElementById('street') as HTMLInputElement).focus()
    const ship = sent.at(-1) as Extract<FormsEvent, { type: 'focus' }>
    expect(ship.group).toBe('address')
    command({
      type: 'fill',
      formId: ship.formId,
      values: {
        'address-line1': '1600 Amphitheatre Pkwy',
        'address-level2': 'Mountain View',
        'address-level1': 'CA',
        'postal-code': '94043',
        country: 'US'
      },
      labels: { countryName: 'United States', regionName: 'California' }
    })
    expect((document.getElementById('city') as HTMLInputElement).value).toBe('Mountain View')
    expect((document.getElementById('state') as HTMLSelectElement).value).toBe('5')
    expect((document.getElementById('country') as HTMLSelectElement).value).toBe('usa')

    ;(document.getElementById('num') as HTMLInputElement).focus()
    const pay = sent.at(-1) as Extract<FormsEvent, { type: 'focus' }>
    expect(pay.group).toBe('card')
    command({
      type: 'fill',
      formId: pay.formId,
      values: {
        'cc-number': '4242424242424242',
        'cc-exp': '03/2027',
        'cc-exp-month': '03',
        'cc-exp-year': '2027'
      }
    })
    expect((document.getElementById('exp') as HTMLInputElement).value).toBe('03/27')
    expect((document.getElementById('mon') as HTMLSelectElement).value).toBe('3')
    expect((document.getElementById('yr') as HTMLInputElement).value).toBe('27')
  })
})

describe('forms script: submits', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('reports a login submit once, whichever of the submit event, the button click and Enter comes first', async () => {
    document.body.innerHTML = LOGIN_FORM
    const { sent } = install()
    const form = document.getElementById('login') as HTMLFormElement
    const user = document.getElementById('user') as HTMLInputElement
    const pw = document.getElementById('pw') as HTMLInputElement
    user.value = 'ada'
    pw.value = 'hunter2'
    form.addEventListener('submit', (e) => e.preventDefault())
    document
      .getElementById('go')!
      .dispatchEvent(trusted(new MouseEvent('click', { bubbles: true, button: 0 })))
    pw.dispatchEvent(trusted(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await tick()
    const submits = sent.filter((e) => e.type === 'submit')
    expect(submits).toHaveLength(1)
    expect(submits[0]).toMatchObject({
      group: 'login',
      username: 'ada',
      password: 'hunter2',
      newPassword: false
    })
  })

  it('marks sign-up forms and ignores empty ones and untrusted clicks', async () => {
    document.body.innerHTML = `
      <form id="signup">
        <input id="mail" type="email" name="email">
        <input id="p1" type="password" autocomplete="new-password">
        <button id="join" type="button">Create account</button>
      </form>`
    const { sent } = install()
    document.getElementById('join')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await tick()
    expect(sent).toEqual([])
    document
      .getElementById('join')!
      .dispatchEvent(trusted(new MouseEvent('click', { bubbles: true, button: 0 })))
    await tick()
    expect(sent).toEqual([])
    ;(document.getElementById('mail') as HTMLInputElement).value = 'ada@example.com'
    ;(document.getElementById('p1') as HTMLInputElement).value = 'new-secret'
    document
      .getElementById('join')!
      .dispatchEvent(trusted(new MouseEvent('click', { bubbles: true, button: 0 })))
    await tick()
    expect(sent).toEqual([
      {
        type: 'submit',
        group: 'login',
        formId: expect.any(String),
        username: 'ada@example.com',
        password: 'new-secret',
        newPassword: true
      }
    ])
  })

  it('reports the address and card values of a checkout, selects as value|label, never the security code', async () => {
    document.body.innerHTML = `
      <form id="checkout">
        <input name="fullName" value="Ada Lovelace">
        <input name="address1" value="1600 Amphitheatre Pkwy">
        <input name="city" value="Mountain View">
        <select name="state"><option value="5" selected>California</option></select>
        <input name="zip" value="94043">
        <select name="country"><option value="usa" selected>United States</option></select>
        <input name="phone" value="555">
        <input name="cardNumber" value="4242 4242 4242 4242">
        <input name="exp" value="03/27">
        <input name="cvc" value="123">
        <button type="submit">Pay</button>
      </form>`
    const { sent } = install()
    const form = document.getElementById('checkout') as HTMLFormElement
    // On the one form, the city field belongs to the address group and the card number to the card group.
    ;(form.elements.namedItem('city') as HTMLInputElement).focus()
    expect(sent.at(-1)).toMatchObject({ type: 'focus', group: 'address', kind: 'address-level2' })
    ;(form.elements.namedItem('cardNumber') as HTMLInputElement).focus()
    expect(sent.at(-1)).toMatchObject({ type: 'focus', group: 'card', kind: 'cc-number' })
    sent.length = 0
    form.addEventListener('submit', (e) => e.preventDefault())
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await tick()
    expect(sent).toEqual([
      {
        type: 'submit',
        group: 'card',
        formId: expect.any(String),
        values: { 'cc-number': '4242 4242 4242 4242', 'cc-exp': '03/27' }
      },
      {
        type: 'submit',
        group: 'address',
        formId: expect.any(String),
        values: {
          name: 'Ada Lovelace',
          'address-line1': '1600 Amphitheatre Pkwy',
          'address-level2': 'Mountain View',
          'address-level1': '5|California',
          'postal-code': '94043',
          country: 'usa|United States',
          tel: '555'
        }
      }
    ])
    expect(JSON.stringify(sent)).not.toContain('123')
  })

  it('reports a single-page sign-in as settled when the password field leaves the page', async () => {
    document.body.innerHTML = LOGIN_FORM
    const { sent } = install()
    const form = document.getElementById('login') as HTMLFormElement
    ;(document.getElementById('user') as HTMLInputElement).value = 'ada'
    ;(document.getElementById('pw') as HTMLInputElement).value = 'hunter2'
    form.addEventListener('submit', (e) => e.preventDefault())
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    const submit = sent.find((e) => e.type === 'submit') as Extract<FormsEvent, { type: 'submit' }>
    expect(submit).toBeDefined()
    form.remove()
    await new Promise((r) => setTimeout(r, 700))
    expect(sent.at(-1)).toEqual({ type: 'settled', formId: submit.formId })
  })
})

describe('forms script: passkeys', () => {
  // A same-window postMessage arrives with `source === window` in browsers; happy-dom hands the
  // listener another object for the window, so the tests deliver the message themselves.
  const nativePostMessage = window.postMessage
  beforeEach(() => {
    window.postMessage = ((data: unknown) => {
      setTimeout(
        () => window.dispatchEvent(new MessageEvent('message', { data, source: window })),
        0
      )
    }) as typeof window.postMessage
  })
  afterEach(() => {
    window.postMessage = nativePostMessage
    document.body.innerHTML = ''
  })

  it('forwards the observer’s report of a created passkey from the page world', async () => {
    const created = { rawId: new Uint8Array([1, 2, 3, 250]).buffer, id: 'x' }
    Object.defineProperty(navigator, 'credentials', {
      configurable: true,
      value: {
        create: async () => created,
        get: async () => created
      }
    })
    const { sent } = install()
    installPasskeyObserver(window)
    // Installing twice is harmless.
    installPasskeyObserver(window)
    const result = await navigator.credentials.create({
      publicKey: {
        rp: { id: 'example.com', name: 'Example' },
        user: { id: new Uint8Array(1), name: 'ada@example.com', displayName: 'Ada' },
        challenge: new Uint8Array(1),
        pubKeyCredParams: []
      }
    } as CredentialCreationOptions)
    expect(result).toBe(created)
    await tick()
    await tick()
    expect(sent).toEqual([
      {
        type: 'passkey',
        op: 'create',
        rpId: 'example.com',
        rpName: 'Example',
        userName: 'ada@example.com',
        userDisplayName: 'Ada',
        credentialId: 'AQID-g'
      }
    ])
    await navigator.credentials.get({
      publicKey: { rpId: 'example.com', challenge: new Uint8Array(1) }
    } as CredentialRequestOptions)
    await tick()
    await tick()
    expect(sent[1]).toMatchObject({
      type: 'passkey',
      op: 'get',
      rpId: 'example.com',
      credentialId: 'AQID-g'
    })
    // A plain (non-WebAuthn) credentials call says nothing.
    await navigator.credentials.get({ password: true } as CredentialRequestOptions)
    await tick()
    expect(sent).toHaveLength(2)
  })

  it('ignores messages that are not passkey reports, and reports from other windows', async () => {
    const { sent } = install()
    window.postMessage({ hello: 'world' }, '*')
    window.postMessage({ __zeniumPasskey: { op: 'delete' } }, '*')
    window.postMessage('text', '*')
    // An iframe posting a report to its parent has another `source`.
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { __zeniumPasskey: { op: 'create', rpId: 'evil.example' } },
        source: null
      })
    )
    await tick()
    await tick()
    expect(sent).toEqual([])
  })
})
