// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  APP_BADGE_EVENT,
  APP_BADGE_FLAG_GLYPH,
  APP_BADGE_MAX_SHOWN,
  appBadgeDescription,
  appBadgeLabel,
  appBadgeOf,
  installAppBadgeShim,
  sameAppBadge,
  type AppBadge
} from '../appBadge'

/*
 * The Badging API (MW-51): the page-world shim answers `navigator.setAppBadge` /
 * `clearAppBadge` as the spec has it (w3c.github.io/badging) – `[SecureContext]`, an optional
 * `[EnforceRange] unsigned long long`, no argument for a flag, 0 to clear, a conversion error as
 * a rejected promise – and posts each badge as JSON on a DOM event for the isolated world; the
 * core's validator takes only well-formed badges; the label and description follow Chrome's
 * `GetBadgeString` (99+, •) and its Windows overlay's accessible strings.
 */

type BadgeNavigator = Navigator & {
  setAppBadge?: (contents?: unknown) => Promise<undefined>
  clearAppBadge?: () => Promise<undefined>
}

const nav = (): BadgeNavigator => navigator as BadgeNavigator

const count = (value: number): AppBadge => ({ kind: 'count', value })
const FLAG: AppBadge = { kind: 'flag' }

let installs = 0
const listeners: Array<[string, EventListener]> = []

/** One shim in the page's world with an event name of its own; every badge it posted, in order. */
function install(): { posted: Array<AppBadge | null>; eventName: string } {
  installs++
  const eventName = `${APP_BADGE_EVENT}-${installs}`
  const posted: Array<AppBadge | null> = []
  const listener: EventListener = (e) =>
    posted.push((JSON.parse((e as CustomEvent<string>).detail) as { badge: AppBadge | null }).badge)
  document.addEventListener(eventName, listener)
  listeners.push([eventName, listener])
  installAppBadgeShim(eventName)
  return { posted, eventName }
}

function setSecureContext(secure: boolean): void {
  Object.defineProperty(window, 'isSecureContext', { value: secure, configurable: true })
}

/** Take the shim's pair off the shared navigator between tests. */
function removeShim(): void {
  const proto = Navigator.prototype as unknown as Record<string, unknown>
  delete proto.setAppBadge
  delete proto.clearAppBadge
}

describe('appBadgeOf (the core’s check of a posted badge)', () => {
  it('takes a cleared badge, a flag and a count above zero, and nothing else', () => {
    expect(appBadgeOf(null)).toBeNull()
    expect(appBadgeOf({ kind: 'flag' })).toEqual(FLAG)
    expect(appBadgeOf({ kind: 'flag', value: 3 })).toEqual(FLAG)
    expect(appBadgeOf({ kind: 'count', value: 1 })).toEqual(count(1))
    expect(appBadgeOf({ kind: 'count', value: 9007199254740991 })).toEqual(count(9007199254740991))
    for (const bad of [
      undefined,
      0,
      5,
      '5',
      true,
      [],
      {},
      { kind: 'count' },
      { kind: 'count', value: 0 },
      { kind: 'count', value: -1 },
      { kind: 'count', value: 1.5 },
      { kind: 'count', value: '3' },
      { kind: 'count', value: Number.NaN },
      { kind: 'count', value: Number.POSITIVE_INFINITY },
      { kind: 'count', value: 2 ** 53 },
      { kind: 'dot' }
    ])
      expect(appBadgeOf(bad), JSON.stringify(bad)).toBeUndefined()
  })

  it('sameAppBadge tells two badges (or none) apart by kind and count', () => {
    expect(sameAppBadge(null, null)).toBe(true)
    expect(sameAppBadge(FLAG, { kind: 'flag' })).toBe(true)
    expect(sameAppBadge(count(3), count(3))).toBe(true)
    expect(sameAppBadge(count(3), count(4))).toBe(false)
    expect(sameAppBadge(count(1), FLAG)).toBe(false)
    expect(sameAppBadge(null, FLAG)).toBe(false)
    expect(sameAppBadge(count(1), null)).toBe(false)
  })
})

describe('the label and the accessible description', () => {
  it('shows the count, 99+ past Chrome’s maximum and • for a flag', () => {
    expect(APP_BADGE_MAX_SHOWN).toBe(99)
    expect(appBadgeLabel(count(1))).toBe('1')
    expect(appBadgeLabel(count(99))).toBe('99')
    expect(appBadgeLabel(count(100))).toBe('99+')
    expect(appBadgeLabel(count(9007199254740991))).toBe('99+')
    expect(appBadgeLabel(FLAG)).toBe(APP_BADGE_FLAG_GLYPH)
    expect(APP_BADGE_FLAG_GLYPH).toBe('•')
  })

  it('describes the badge for a screen reader: the count pluralised, more than 99, unspecific for a flag', () => {
    expect(appBadgeDescription(count(1))).toBe('1 unread notification')
    expect(appBadgeDescription(count(2))).toBe('2 unread notifications')
    expect(appBadgeDescription(count(99))).toBe('99 unread notifications')
    expect(appBadgeDescription(count(100))).toBe('More than 99 unread notifications')
    expect(appBadgeDescription(FLAG)).toBe('Unread notifications')
  })
})

describe('installAppBadgeShim (the page’s world)', () => {
  beforeEach(() => setSecureContext(true))
  afterEach(() => {
    for (const [type, listener] of listeners.splice(0)) document.removeEventListener(type, listener)
    removeShim()
  })

  it('defines navigator.setAppBadge and clearAppBadge as promise-returning methods that resolve', async () => {
    expect(nav().setAppBadge).toBeUndefined()
    const { posted } = install()
    expect(typeof nav().setAppBadge).toBe('function')
    expect(typeof nav().clearAppBadge).toBe('function')
    // On the prototype, as the engine's own would be – every navigator of the world has them.
    expect(Object.prototype.hasOwnProperty.call(Navigator.prototype, 'setAppBadge')).toBe(true)
    await expect(nav().setAppBadge!(3)).resolves.toBeUndefined()
    await expect(nav().clearAppBadge!()).resolves.toBeUndefined()
    expect(posted).toEqual([count(3), null])
  })

  it('posts a flag for no argument or undefined, a cleared badge for 0 and clearAppBadge, the integer part of a fraction', async () => {
    const { posted } = install()
    const set = nav().setAppBadge!
    await set()
    await set(undefined)
    await set(0)
    await set(-0)
    // WebIDL truncates before it checks the range: -0.5 is a -0, a cleared badge, as in Chrome.
    await set(-0.5)
    await set(2.9)
    await set(7)
    await set('12')
    await set(true)
    await nav().clearAppBadge!()
    expect(posted).toEqual([
      FLAG,
      FLAG,
      null,
      null,
      null,
      count(2),
      count(7),
      count(12),
      count(1),
      null
    ])
  })

  it('rejects with a TypeError – and posts nothing – for what [EnforceRange] unsigned long long refuses', async () => {
    const { posted } = install()
    const set = nav().setAppBadge!
    for (const bad of [
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      2 ** 53,
      'many',
      BigInt(3),
      Symbol('badge'),
      {
        valueOf: () => {
          throw new Error('no')
        }
      }
    ]) {
      await expect(set(bad)).rejects.toBeInstanceOf(TypeError)
    }
    expect(posted).toEqual([])
  })

  it('does nothing on an insecure context: the spec’s [SecureContext], as an http: page sees no API in Chrome', () => {
    setSecureContext(false)
    const { posted } = install()
    expect(nav().setAppBadge).toBeUndefined()
    expect(nav().clearAppBadge).toBeUndefined()
    expect(posted).toEqual([])
  })

  it('keeps a call from throwing into the page when the document cannot dispatch', async () => {
    const { posted } = install()
    const dispatch = document.dispatchEvent
    document.dispatchEvent = () => {
      throw new Error('gone')
    }
    try {
      await expect(nav().setAppBadge!(1)).resolves.toBeUndefined()
    } finally {
      document.dispatchEvent = dispatch
    }
    expect(posted).toEqual([])
  })
})
