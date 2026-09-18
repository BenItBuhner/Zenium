// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  installNotificationBridge,
  installNotificationShim,
  type NotificationBridgeTransport
} from '../notifications'
import { NOTIFICATION_SHIM_EVENTS } from '../../shared/notifications'

type Status = 'granted' | 'denied' | 'default'

/** A stand-in for the engine's `Notification`: a yes-or-no host check behind it. */
function fakeNotification(
  native: Status,
  requestResult: Status
): {
  requested: number
} {
  const calls = { requested: 0 }
  class Notification {
    static get permission(): Status {
      return native
    }
    static requestPermission(): Promise<Status> {
      calls.requested++
      return Promise.resolve(requestResult)
    }
  }
  Object.defineProperty(globalThis, 'Notification', { value: Notification, configurable: true })
  return calls
}

function setUserActivation(isActive: boolean): void {
  Object.defineProperty(navigator, 'userActivation', {
    value: { isActive, hasBeenActive: isActive },
    configurable: true
  })
}

interface ScriptedBridge {
  transport: NotificationBridgeTransport
  push: (status: unknown) => void
  focused: number
  asked: number
  install: () => void
}

/** The browser side of the bridge, scripted: what it answers and what it was told. */
function bridge(answers: Status[]): ScriptedBridge {
  let push: (status: unknown) => void = () => undefined
  const state: ScriptedBridge = {
    focused: 0,
    asked: 0,
    push: (status: unknown) => push(status),
    install: () => undefined,
    transport: {} as NotificationBridgeTransport
  }
  state.transport = {
    status: () => {
      state.asked++
      return answers.length > 1 ? answers.shift() : answers[0]
    },
    onStatus: (listener) => {
      push = listener
    },
    focus: () => {
      state.focused++
    },
    installShim: (events) => installNotificationShim(events)
  }
  state.install = () => installNotificationBridge(state.transport, NOTIFICATION_SHIM_EVENTS)
  return state
}

const N = (): typeof Notification =>
  (globalThis as { Notification: typeof Notification }).Notification

describe('Notification.permission shim', () => {
  const originalFocus = window.focus
  beforeEach(() => {
    setUserActivation(false)
  })
  afterEach(() => {
    Object.defineProperty(window, 'focus', {
      value: originalFocus,
      configurable: true,
      writable: true
    })
    Reflect.deleteProperty(globalThis, 'Notification')
  })

  it('reads the browser’s three-state answer, asked once and then kept current by pushes', () => {
    fakeNotification('denied', 'denied')
    const b = bridge(['default'])
    b.install()
    expect(b.asked).toBe(0)
    expect(N().permission).toBe('default')
    expect(N().permission).toBe('default')
    expect(b.asked).toBe(1)
    b.push('granted')
    expect(N().permission).toBe('granted')
    b.push('nonsense')
    expect(N().permission).toBe('granted')
  })

  it('asks the browser again after a request: a dismissed prompt leaves the site undecided', async () => {
    const calls = fakeNotification('denied', 'denied')
    const b = bridge(['default'])
    b.install()
    const callback = vi.fn()
    await expect(N().requestPermission(callback)).resolves.toBe('default')
    expect(calls.requested).toBe(1)
    expect(callback).toHaveBeenCalledWith('default')
    b.transport.status = () => 'granted'
    await expect(N().requestPermission()).resolves.toBe('granted')
    expect(N().permission).toBe('granted')
  })

  it('leaves the engine’s answer standing when nobody answers the question', () => {
    fakeNotification('granted', 'granted')
    installNotificationShim(NOTIFICATION_SHIM_EVENTS)
    expect(N().permission).toBe('granted')
  })

  it('does nothing to a page without Notification', () => {
    Reflect.deleteProperty(globalThis, 'Notification')
    expect(() => installNotificationShim(NOTIFICATION_SHIM_EVENTS)).not.toThrow()
  })

  it('reports window.focus() to the browser only while the page holds a gesture, a few times a second at most', () => {
    fakeNotification('denied', 'denied')
    const native = vi.fn()
    Object.defineProperty(window, 'focus', { value: native, configurable: true, writable: true })
    const b = bridge(['default'])
    b.install()
    window.focus()
    expect(native).toHaveBeenCalledTimes(1)
    expect(b.focused).toBe(0)
    setUserActivation(true)
    window.focus()
    window.focus()
    expect(native).toHaveBeenCalledTimes(3)
    expect(b.focused).toBe(1)
    // A page cannot claim a gesture it does not have by firing the event itself.
    setUserActivation(false)
    document.dispatchEvent(new Event(NOTIFICATION_SHIM_EVENTS.focus))
    expect(b.focused).toBe(1)
  })
})
