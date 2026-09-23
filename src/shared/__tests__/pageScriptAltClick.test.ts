// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PAGE_FLAGS,
  installPageScript,
  type PageScriptFlags,
  type PageScriptMessage
} from '../pageScript'

/*
 * Alt+click on a link downloads it in Chrome: Blink's own navigation policy (an Alt-modified
 * click resolves to a download, which the engine hands to the download system and the host
 * reports through `will-download`). Zenium adds nothing to that path – no shortcut, no
 * navigation guard – so the one thing to hold is that the page script leaves such a click alone,
 * unless Glance claims Alt as its trigger (Zen's default): then Alt+click is Glance, and a
 * download wants Glance's trigger moved or Glance off.
 *
 * In a file of its own: every `installPageScript` leaves its click listener on the shared
 * window, and one with Glance's defaults would take the click before these could see it.
 */

const LINK = 'http://files.example/report.zip'

/** happy-dom lets a test mark an event as trusted; browsers only do so for real input. */
function trusted<T extends Event>(e: T): T {
  Object.defineProperty(e, 'isTrusted', { value: true, configurable: true })
  return e
}

/** One page script, whose flags the test sets; every message it sends. */
function install(flags: PageScriptFlags): { sent: PageScriptMessage[]; uninstall: () => void } {
  const sent: PageScriptMessage[] = []
  const captured: { listener?: (flags: PageScriptFlags) => void } = {}
  installPageScript({
    send: (m) => {
      sent.push(m)
    },
    onFlags: (l) => {
      captured.listener = l
    }
  })
  const listener = captured.listener
  if (!listener) throw new Error('the page script did not ask for flags')
  listener(flags)
  return {
    sent,
    // The listeners stay; flags turned off keep them out of the next test's way.
    uninstall: () => listener({ ...DEFAULT_PAGE_FLAGS, glanceEnabled: false, thirdParty: null })
  }
}

/** A trusted Alt+click on a link; returns whether the page script cancelled it. */
function altClick(): boolean {
  const anchor = document.createElement('a')
  anchor.href = LINK
  anchor.textContent = 'report'
  document.body.append(anchor)
  // Runs after the page script's capturing handler when that lets the click through (Glance
  // stops propagation when it takes it); happy-dom would otherwise follow the link.
  const observe = (e: Event): void => e.preventDefault()
  window.addEventListener('click', observe)
  const click = trusted(
    new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      button: 0,
      altKey: true,
      clientX: 10,
      clientY: 10
    })
  )
  let prevented: boolean | null = null
  const seenByPageScript = (e: Event): void => {
    prevented = e.defaultPrevented
  }
  // Right after the page script's capturing listener on the window, before the observer above.
  document.addEventListener('click', seenByPageScript, true)
  try {
    anchor.dispatchEvent(click)
  } finally {
    window.removeEventListener('click', observe)
    document.removeEventListener('click', seenByPageScript, true)
    anchor.remove()
  }
  // Glance stops the event at the window, so the document never sees it: the event's own flag.
  return prevented ?? click.defaultPrevented
}

describe('page script: Alt+click on a link (a download, as in Chrome)', () => {
  it('leaves the click to the engine when Glance is off, so the link downloads', () => {
    const { sent, uninstall } = install({ ...DEFAULT_PAGE_FLAGS, glanceEnabled: false })
    expect(altClick()).toBe(false)
    expect(sent.filter((m) => m.type === 'glance')).toEqual([])
    uninstall()
  })

  it('leaves the click to the engine when Glance answers another key', () => {
    const { sent, uninstall } = install({ ...DEFAULT_PAGE_FLAGS, glanceTrigger: 'shift' })
    expect(altClick()).toBe(false)
    expect(sent.filter((m) => m.type === 'glance')).toEqual([])
    uninstall()
  })

  it("takes the click for Glance while Alt is Glance's trigger (Zen's default)", () => {
    const { sent, uninstall } = install({ ...DEFAULT_PAGE_FLAGS })
    expect(altClick()).toBe(true)
    expect(sent.filter((m) => m.type === 'glance')).toMatchObject([{ type: 'glance', url: LINK }])
    uninstall()
  })
})
