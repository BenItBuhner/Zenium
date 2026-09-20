// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  INSTALL_PROMPT_EVENTS,
  installInstallPromptShim,
  type InstallPromptShimEvents
} from '../installPrompt'

type Choice = { outcome: 'accepted' | 'dismissed'; platform: string }
type InstallPromptEvent = Event & {
  platforms: string[]
  userChoice: Promise<Choice>
  prompt: () => Promise<Choice>
}

function setUserActivation(isActive: boolean): void {
  Object.defineProperty(navigator, 'userActivation', {
    value: { isActive, hasBeenActive: isActive },
    configurable: true
  })
}

interface Shim {
  events: InstallPromptShimEvents
  /** What the main world asked the isolated world: `prompt` or `deferred`. */
  requests: string[]
  /** The isolated world's messages (the browser's `webapp` host messages relayed). */
  tell: (action: 'installable' | 'result' | 'installed', outcome?: Choice['outcome']) => void
}

let installs = 0

/** One shim in the page's world; its own event names per install (the document is shared). */
function install(): Shim {
  installs++
  const events: InstallPromptShimEvents = {
    request: `${INSTALL_PROMPT_EVENTS.request}-${installs}`,
    result: `${INSTALL_PROMPT_EVENTS.result}-${installs}`
  }
  const requests: string[] = []
  document.addEventListener(events.request, (e) =>
    requests.push((JSON.parse((e as CustomEvent<string>).detail) as { kind: string }).kind)
  )
  installInstallPromptShim(events)
  return {
    events,
    requests,
    tell: (action, outcome) =>
      document.dispatchEvent(
        new CustomEvent(events.result, { detail: JSON.stringify({ action, outcome }) })
      )
  }
}

const listeners: Array<[string, EventListener]> = []
/** A window listener the test takes down again (the window is shared by the tests). */
function listen(type: string, listener: EventListener): void {
  window.addEventListener(type, listener)
  listeners.push([type, listener])
}

describe('beforeinstallprompt shim', () => {
  afterEach(() => {
    for (const [type, listener] of listeners.splice(0)) window.removeEventListener(type, listener)
    setUserActivation(false)
  })

  it('fires beforeinstallprompt once when the browser finds the page installable', () => {
    const s = install()
    const seen: InstallPromptEvent[] = []
    listen('beforeinstallprompt', (e) => seen.push(e as InstallPromptEvent))
    s.tell('installable')
    s.tell('installable')
    expect(seen).toHaveLength(1)
    expect(seen[0].platforms).toEqual(['web'])
    expect(seen[0].cancelable).toBe(true)
    // Nobody deferred the browser's own prompt: nothing to ask of the isolated world.
    expect(s.requests).toEqual([])
  })

  it('preventDefault defers the browser’s prompt; prompt() with a gesture asks for it and userChoice reports the answer', async () => {
    const s = install()
    const seen: InstallPromptEvent[] = []
    listen('beforeinstallprompt', (e) => {
      e.preventDefault()
      seen.push(e as InstallPromptEvent)
    })
    s.tell('installable')
    expect(s.requests).toEqual(['deferred'])
    const [event] = seen
    setUserActivation(false)
    await expect(event.prompt()).rejects.toMatchObject({ name: 'NotAllowedError' })
    setUserActivation(true)
    const choice = event.prompt()
    expect(s.requests).toEqual(['deferred', 'prompt'])
    // Once only, as in Chrome.
    await expect(event.prompt()).rejects.toMatchObject({ name: 'InvalidStateError' })
    s.tell('result', 'accepted')
    await expect(choice).resolves.toEqual({ outcome: 'accepted', platform: 'web' })
    await expect(event.userChoice).resolves.toEqual({ outcome: 'accepted', platform: 'web' })
  })

  it('a dismissed browser prompt settles the event’s userChoice; appinstalled follows an install', async () => {
    const s = install()
    const seen: InstallPromptEvent[] = []
    listen('beforeinstallprompt', (e) => seen.push(e as InstallPromptEvent))
    const installed = vi.fn()
    listen('appinstalled', installed)
    s.tell('installable')
    // The user dismissed the browser's own install sheet: no prompt() was called.
    s.tell('result', 'dismissed')
    await expect(seen[0].userChoice).resolves.toEqual({ outcome: 'dismissed', platform: 'web' })
    s.tell('installed')
    expect(installed).toHaveBeenCalledTimes(1)
  })

  it('an install resolves a waiting prompt() as accepted', async () => {
    const s = install()
    const seen: InstallPromptEvent[] = []
    listen('beforeinstallprompt', (e) => {
      e.preventDefault()
      seen.push(e as InstallPromptEvent)
    })
    s.tell('installable')
    setUserActivation(true)
    const choice = seen[0].prompt()
    s.tell('installed')
    await expect(choice).resolves.toEqual({ outcome: 'accepted', platform: 'web' })
  })

  it('window.onbeforeinstallprompt works as a handler attribute', () => {
    const s = install()
    const handler = vi.fn()
    const win = window as Window & { onbeforeinstallprompt?: EventListener | null }
    win.onbeforeinstallprompt = handler
    s.tell('installable')
    expect(handler).toHaveBeenCalledTimes(1)
    win.onbeforeinstallprompt = null
    const other = install()
    other.tell('installable')
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('never throws into the page on garbage from the isolated world', () => {
    const s = install()
    expect(() =>
      document.dispatchEvent(new CustomEvent(s.events.result, { detail: '{nope' }))
    ).not.toThrow()
    expect(() =>
      document.dispatchEvent(
        new CustomEvent(s.events.result, { detail: JSON.stringify({ action: 'fly' }) })
      )
    ).not.toThrow()
    expect(s.requests).toEqual([])
  })
})
