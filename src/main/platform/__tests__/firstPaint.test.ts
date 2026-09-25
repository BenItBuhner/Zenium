import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { WebContents } from 'electron'
import {
  awaitFirstPaint,
  FIRST_PAINT_DEADLINE_MS,
  FIRST_PAINT_POLL_MS,
  hasPainted,
  PAINT_PROBE_TIMEOUT_MS,
  PAINT_STATE_SCRIPT,
  paintGatedCommand,
  paintSettled,
  paintState
} from '../firstPaint'

/**
 * A page as the gate sees it: its main frame answers the paint probe from a scripted queue
 * (the last answer repeats), or not at all, or with an error; navigations are events.
 */
class FakePage extends EventEmitter {
  private static nextId = 1
  readonly id = FakePage.nextId++
  destroyed = false
  /** Every probe's code, in order. */
  readonly probes: string[] = []
  /** The answers the frame gives, one per probe; the last one repeats. */
  answers: Array<string | { error: string } | 'silent'> = ['painted']
  /** Frames the probe returns from, for the tests that navigate between the ask and the answer. */
  onProbe: (() => void) | null = null
  url = 'https://example.test/page'
  readonly mainFrame = {
    executeJavaScript: (code: string, userGesture?: boolean): Promise<unknown> => {
      expect(userGesture).toBe(false)
      this.probes.push(code)
      const answer = this.answers.length > 1 ? this.answers.shift()! : this.answers[0]!
      this.onProbe?.()
      if (answer === 'silent') return new Promise(() => undefined)
      if (typeof answer === 'object') return Promise.reject(new Error(answer.error))
      return Promise.resolve(answer)
    }
  }
  isDestroyed(): boolean {
    return this.destroyed
  }
  getURL(): string {
    return this.url
  }
  /** A cross-document navigation of the main frame, both ends. */
  navigate(url = 'https://example.test/next'): void {
    this.emit('did-start-navigation', { url, isMainFrame: true, isSameDocument: false })
    this.emit('did-navigate', {}, url)
    this.url = url
  }
  asWebContents(): WebContents {
    return this as unknown as WebContents
  }
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('awaitFirstPaint', () => {
  it('lets input through at once on a painted page, and remembers the document so later events cost no probe', async () => {
    const page = new FakePage()
    const wc = page.asWebContents()
    expect(paintSettled(wc)).toBe(false)
    expect(await awaitFirstPaint(wc)).toBe('painted')
    expect(page.probes).toEqual([PAINT_STATE_SCRIPT])
    expect(paintSettled(wc)).toBe(true)
    expect(await awaitFirstPaint(wc)).toBe('painted')
    expect(await hasPainted(wc)).toBe(true)
    expect(page.probes).toHaveLength(1)
  })

  it('lets input through at once on a parsed document paint holding never defers (zen:, file:, XML)', async () => {
    const page = new FakePage()
    page.answers = ['ready']
    expect(await awaitFirstPaint(page.asWebContents())).toBe('ready')
    expect(page.probes).toHaveLength(1)
    // Kept as what it was.
    expect(await awaitFirstPaint(page.asWebContents())).toBe('ready')
    expect(page.probes).toHaveLength(1)
  })

  it('holds input while the page is holding, and lets it go once a paint entry exists', async () => {
    const page = new FakePage()
    page.answers = ['holding', 'holding', 'painted']
    const gate = awaitFirstPaint(page.asWebContents(), { pollMs: 5 })
    let through = false
    void gate.then(() => {
      through = true
    })
    await new Promise((r) => setTimeout(r, 1))
    expect(page.probes).toHaveLength(1)
    expect(through).toBe(false)
    expect(await gate).toBe('painted')
    expect(page.probes).toHaveLength(3)
    expect(paintSettled(page.asWebContents())).toBe(true)
  })

  it('waits for a non-held document still parsing (its main-frame updates are held too), not past its end', async () => {
    const page = new FakePage()
    page.answers = ['loading', 'ready']
    expect(await awaitFirstPaint(page.asWebContents(), { pollMs: 1 })).toBe('ready')
    expect(page.probes).toHaveLength(2)
    expect(await hasPainted(page.asWebContents())).toBe(true)
  })

  it('gives up at the deadline, warns once and lets the input go anyway', async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const page = new FakePage()
    page.answers = ['holding']
    let outcome: string | null = null
    void awaitFirstPaint(page.asWebContents()).then((o) => {
      outcome = o
    })
    await vi.advanceTimersByTimeAsync(FIRST_PAINT_DEADLINE_MS - FIRST_PAINT_POLL_MS)
    expect(outcome).toBeNull()
    expect(page.probes.length).toBeGreaterThan(100)
    await vi.advanceTimersByTimeAsync(FIRST_PAINT_POLL_MS)
    expect(outcome).toBe('timeout')
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[0]).toContain('has not painted after 10 s')
    expect(warn.mock.calls[0]?.[0]).toContain('https://example.test/page')
    // Nothing is kept for a page that never painted: the next event asks again.
    expect(paintSettled(page.asWebContents())).toBe(false)
  })

  it('does not wait for a page that does not answer, errors, or has no frame: the input goes as it always did', async () => {
    vi.useFakeTimers()
    const silent = new FakePage()
    silent.answers = ['silent']
    let outcome: string | null = null
    void awaitFirstPaint(silent.asWebContents()).then((o) => {
      outcome = o
    })
    await vi.advanceTimersByTimeAsync(PAINT_PROBE_TIMEOUT_MS - 1)
    expect(outcome).toBeNull()
    await vi.advanceTimersByTimeAsync(1)
    expect(outcome).toBe('unknown')
    expect(silent.probes).toHaveLength(1)
    expect(paintSettled(silent.asWebContents())).toBe(false)
    vi.useRealTimers()

    const erroring = new FakePage()
    erroring.answers = [{ error: 'Script failed to execute' }]
    expect(await awaitFirstPaint(erroring.asWebContents())).toBe('unknown')
    expect(await hasPainted(erroring.asWebContents())).toBe(true)

    const nonsense = new FakePage()
    nonsense.answers = ['banana']
    expect(await awaitFirstPaint(nonsense.asWebContents())).toBe('unknown')

    const frameless = new FakePage()
    Object.defineProperty(frameless, 'mainFrame', { value: undefined })
    expect(await awaitFirstPaint(frameless.asWebContents())).toBe('unknown')
    expect(await hasPainted(frameless.asWebContents())).toBe(true)

    const throwing = new FakePage()
    Object.defineProperty(throwing, 'mainFrame', {
      get: () => {
        throw new Error('Render frame was disposed before WebFrameMain could be accessed')
      }
    })
    expect(await awaitFirstPaint(throwing.asWebContents())).toBe('unknown')
  })

  it('reports contents destroyed while waiting as gone, so callers send nothing', async () => {
    const page = new FakePage()
    page.destroyed = true
    expect(await awaitFirstPaint(page.asWebContents())).toBe('gone')
    expect(page.probes).toEqual([])

    const dying = new FakePage()
    dying.answers = ['holding']
    dying.onProbe = () => {
      dying.destroyed = true
    }
    expect(await awaitFirstPaint(dying.asWebContents(), { pollMs: 1 })).toBe('gone')
    expect(await paintState(dying.asWebContents())).toBe('unknown')
  })

  it('forgets a painted document at its next cross-document navigation, and keeps a same-document one', async () => {
    const page = new FakePage()
    const wc = page.asWebContents()
    expect(await awaitFirstPaint(wc)).toBe('painted')
    page.emit('did-start-navigation', {
      url: page.url + '#x',
      isMainFrame: true,
      isSameDocument: true
    })
    page.emit('did-start-navigation', {
      url: 'https://ad.example/',
      isMainFrame: false,
      isSameDocument: false
    })
    expect(paintSettled(wc)).toBe(true)
    expect(await awaitFirstPaint(wc)).toBe('painted')
    expect(page.probes).toHaveLength(1)

    page.answers = ['holding', 'painted']
    page.navigate()
    expect(paintSettled(wc)).toBe(false)
    expect(await awaitFirstPaint(wc, { pollMs: 1 })).toBe('painted')
    expect(page.probes).toHaveLength(3)
    expect(paintSettled(wc)).toBe(true)
  })

  it('does not keep an answer read across a navigation: it was the old document\u2019s', async () => {
    const page = new FakePage()
    const wc = page.asWebContents()
    page.answers = ['painted']
    page.onProbe = () => {
      // The navigation commits between the ask and the answer.
      page.emit('did-navigate', {}, 'https://example.test/next')
      page.onProbe = null
    }
    expect(await awaitFirstPaint(wc)).toBe('painted')
    expect(paintSettled(wc)).toBe(false)
    // The new document is asked in its own right.
    page.answers = ['holding', 'painted']
    expect(await awaitFirstPaint(wc, { pollMs: 1 })).toBe('painted')
    expect(page.probes).toHaveLength(3)
    expect(paintSettled(wc)).toBe(true)
  })

  it('reads the paint state where Chromium records it, with no user gesture', () => {
    expect(PAINT_STATE_SCRIPT).toContain("performance.getEntriesByType('paint')")
    expect(PAINT_STATE_SCRIPT).toContain('HTMLDocument')
    expect(PAINT_STATE_SCRIPT).toContain('https?:')
  })
})

describe('paintGatedCommand', () => {
  it('names the DevTools input commands the holding compositor drops, and leaves the rest alone', () => {
    expect(paintGatedCommand('Input.dispatchMouseEvent', { type: 'mousePressed' })).toBe(true)
    expect(paintGatedCommand('Input.dispatchMouseEvent', { type: 'mouseReleased' })).toBe(true)
    expect(paintGatedCommand('Input.dispatchMouseEvent', { type: 'mouseWheel' })).toBe(true)
    expect(paintGatedCommand('Input.dispatchMouseEvent', {})).toBe(true)
    // A bare move is never suppressed – and drags send them by the hundred.
    expect(paintGatedCommand('Input.dispatchMouseEvent', { type: 'mouseMoved' })).toBe(false)
    expect(paintGatedCommand('Input.dispatchKeyEvent', { type: 'keyDown' })).toBe(true)
    expect(paintGatedCommand('Input.dispatchKeyEvent', { type: 'keyUp' })).toBe(true)
    expect(paintGatedCommand('Input.dispatchTouchEvent', { type: 'touchStart' })).toBe(true)
    expect(paintGatedCommand('Input.insertText', { text: 'hi' })).toBe(true)
    for (const method of [
      'Input.setIgnoreInputEvents',
      'Input.dispatchDragEvent',
      'Input.synthesizeTapGesture',
      'Page.enable',
      'Runtime.evaluate',
      'Network.enable'
    ]) {
      expect(paintGatedCommand(method, {})).toBe(false)
    }
  })
})
