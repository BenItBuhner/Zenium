// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_PAGE_FLAGS,
  installPageScript,
  type PageScriptFlags,
  type PageScriptMessage
} from '../pageScript'

/*
 * The left pane's link rule (split-13, Edge's "Open links from the left pane in the right
 * pane"): with `linksToSplitPane` on, a plain click on a link is the browser's – `split-link`,
 * for the right pane to load – and the page's own navigation is cancelled. Modified clicks stay
 * the engine's (a Ctrl+click is a new tab wherever it happens), a link aimed at a named frame is
 * the page's, and the rule comes before a pinned tab's third-party rule.
 *
 * In a file of its own, as the Alt+click test is: every `installPageScript` leaves its click
 * listener on the shared window.
 */

const LINK = 'https://news.example/story'

/** happy-dom lets a test mark an event as trusted; browsers only do so for real input. */
function trusted<T extends Event>(e: T): T {
  Object.defineProperty(e, 'isTrusted', { value: true, configurable: true })
  return e
}

/** One page script, whose flags the test sets; every message it sends. */
function install(flags: Partial<PageScriptFlags>): {
  sent: PageScriptMessage[]
  uninstall: () => void
} {
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
  listener({ ...DEFAULT_PAGE_FLAGS, glanceEnabled: false, ...flags })
  return {
    sent,
    uninstall: () => listener({ ...DEFAULT_PAGE_FLAGS, glanceEnabled: false })
  }
}

/** A trusted click on a link; returns whether the page script cancelled it. */
function click(init: MouseEventInit = {}, target?: string): boolean {
  const anchor = document.createElement('a')
  anchor.href = LINK
  if (target !== undefined) anchor.target = target
  anchor.textContent = 'story'
  document.body.append(anchor)
  // happy-dom would otherwise follow the link when the page script lets it through.
  const observe = (e: Event): void => e.preventDefault()
  window.addEventListener('click', observe)
  const event = trusted(
    new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientX: 10,
      clientY: 10,
      ...init
    })
  )
  let prevented: boolean | null = null
  const seen = (e: Event): void => {
    prevented = e.defaultPrevented
  }
  document.addEventListener('click', seen, true)
  try {
    anchor.dispatchEvent(event)
  } finally {
    window.removeEventListener('click', observe)
    document.removeEventListener('click', seen, true)
    anchor.remove()
  }
  // A taken click is stopped at the window, so the document never sees it: the event's own flag.
  return prevented ?? event.defaultPrevented
}

let uninstall: (() => void) | null = null
afterEach(() => {
  uninstall?.()
  uninstall = null
})

describe('page script: the left pane’s link rule (split-13)', () => {
  it('sends a plain click on a link as split-link and cancels the page’s own navigation', () => {
    const page = install({ linksToSplitPane: true })
    uninstall = page.uninstall
    expect(click()).toBe(true)
    expect(page.sent.filter((m) => m.type === 'split-link')).toEqual([
      {
        type: 'split-link',
        url: LINK,
        x: 10 / Math.max(1, window.innerWidth),
        y: 10 / Math.max(1, window.innerHeight)
      }
    ])
  })

  it('takes links bound for this page or a new tab, and leaves one aimed at a named frame', () => {
    const page = install({ linksToSplitPane: true })
    uninstall = page.uninstall
    expect(click({}, '_self')).toBe(true)
    expect(click({}, '_top')).toBe(true)
    expect(click({}, '_blank')).toBe(true)
    expect(click({}, 'sidebar-frame')).toBe(false)
    expect(page.sent.filter((m) => m.type === 'split-link')).toHaveLength(3)
  })

  it('leaves a modified click to the engine, and every click while the flag is off', () => {
    const page = install({ linksToSplitPane: true })
    uninstall = page.uninstall
    expect(click({ ctrlKey: true })).toBe(false)
    expect(click({ shiftKey: true })).toBe(false)
    expect(click({ button: 1 })).toBe(false)
    expect(page.sent).toEqual([])
    page.uninstall()
    uninstall = null
    expect(click()).toBe(false)
    expect(page.sent).toEqual([])
  })

  it('comes before the pinned tab’s third-party rule: the left pane’s link goes right, not to a new tab', () => {
    const page = install({ linksToSplitPane: true, thirdParty: 'new-tab' })
    uninstall = page.uninstall
    expect(click()).toBe(true)
    expect(page.sent.map((m) => m.type)).toEqual(['split-link'])
  })
})
