import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { WebContents } from 'electron'
import {
  awaitFirstPaint,
  FIRST_PAINT_DEADLINE_MS,
  FIRST_PAINT_POLL_MS,
  FRAME_DRAWN_SCRIPT,
  frameDrawn,
  hasPainted,
  PAINT_PROBE_TIMEOUT_MS,
  PAINT_STATE_SCRIPT,
  paintGatedCommand,
  paintSettled,
  paintState,
  SHOWN_PAINTED_SCRIPT,
  shownPainted
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

/**
 * The frame report (`TabView.frameDrawn`; the reader cover's paint handshake): the document's
 * word that a frame is drawn, asked through the main frame, or a rejection – never a throw out
 * of the ask, which the asker racing the word against its ceiling would not catch.
 */
describe('frameDrawn', () => {
  it('asks the main frame for the double-rAF word with no gesture, and answers with the document’s clock', async () => {
    const page = new FakePage()
    page.mainFrame.executeJavaScript = (code, userGesture) => {
      expect(userGesture).toBe(false)
      page.probes.push(code)
      return Promise.resolve(61.4)
    }
    await expect(frameDrawn(page.asWebContents())).resolves.toBe(61.4)
    expect(page.probes).toEqual([FRAME_DRAWN_SCRIPT])
    // An answer that is no number is NaN, not a throw.
    page.mainFrame.executeJavaScript = () => Promise.resolve('soon')
    await expect(frameDrawn(page.asWebContents())).resolves.toBeNaN()
  })

  it('a frame disposed between the read and the ask throws from executeJavaScript itself: the ask rejects with it, nothing escapes', async () => {
    const page = new FakePage()
    page.mainFrame.executeJavaScript = () => {
      throw new Error('Render frame was disposed before WebFrameMain could be accessed')
    }
    let word: Promise<number> | undefined
    expect(() => {
      word = frameDrawn(page.asWebContents())
    }).not.toThrow()
    await expect(word).rejects.toThrow('Render frame was disposed')
    // A throw that is no Error is wrapped, its cause kept.
    page.mainFrame.executeJavaScript = () => {
      throw 'disposed'
    }
    await expect(frameDrawn(page.asWebContents())).rejects.toMatchObject({
      message: 'The page’s frame is gone',
      cause: 'disposed'
    })
  })

  it('contents that are gone, or without a main frame, are refused before any ask', async () => {
    const gone = new FakePage()
    gone.destroyed = true
    await expect(frameDrawn(gone.asWebContents())).rejects.toThrow('The page is gone')
    expect(gone.probes).toEqual([])
    const frameless = new FakePage()
    Object.defineProperty(frameless, 'mainFrame', {
      get: () => {
        throw new Error('disposed')
      }
    })
    await expect(frameDrawn(frameless.asWebContents())).rejects.toThrow(
      'The page has no main frame'
    )
    const nullFrame = new FakePage()
    Object.defineProperty(nullFrame, 'mainFrame', { value: null })
    await expect(frameDrawn(nullFrame.asWebContents())).rejects.toThrow(
      'The page has no main frame'
    )
  })
})

/**
 * The shown page's word (`TabView.shownPainted`, W8-P0): a page shown on the activate commit
 * under the page it replaces says when a frame of the document it is to show is on screen –
 * the double-rAF word AND the document's first paint entry, asked of the committed document
 * now, or of the one a woken tab's load commits next.
 */
describe('shownPainted', () => {
  it('asks a committed document at once, through the main frame with no gesture, for both words', async () => {
    const page = new FakePage()
    page.mainFrame.executeJavaScript = (code, userGesture) => {
      expect(userGesture).toBe(false)
      page.probes.push(code)
      return Promise.resolve(80.2)
    }
    await expect(shownPainted(page.asWebContents())).resolves.toBe(80.2)
    expect(page.probes).toEqual([SHOWN_PAINTED_SCRIPT])
    // The script waits on the frames and on a paint entry, both; an answer that is no number
    // is NaN, not a throw.
    expect(SHOWN_PAINTED_SCRIPT).toContain('requestAnimationFrame')
    expect(SHOWN_PAINTED_SCRIPT).toContain("getEntriesByType('paint')")
    expect(SHOWN_PAINTED_SCRIPT).toContain("type: 'paint', buffered: true")
    page.mainFrame.executeJavaScript = () => Promise.resolve('soon')
    await expect(shownPainted(page.asWebContents())).resolves.toBeNaN()
  })

  it('a page without a committed document (a woken tab) is asked once its document commits', async () => {
    const page = new FakePage()
    page.url = ''
    page.mainFrame.executeJavaScript = (code) => {
      page.probes.push(code)
      return Promise.resolve(12.5)
    }
    const word = shownPainted(page.asWebContents())
    await Promise.resolve()
    // Nothing asked of the initial empty document.
    expect(page.probes).toEqual([])
    page.navigate('https://example.test/woken')
    await expect(word).resolves.toBe(12.5)
    expect(page.probes).toEqual([SHOWN_PAINTED_SCRIPT])
    // The commit's listeners are gone with the ask: a later navigation asks nothing more.
    page.navigate('https://example.test/later')
    expect(page.probes).toHaveLength(1)
    expect(page.listenerCount('did-navigate')).toBe(0)
    expect(page.listenerCount('destroyed')).toBe(0)
  })

  it('about:blank is no committed document either: the ask waits for the real one', async () => {
    const page = new FakePage()
    page.url = 'about:blank'
    page.mainFrame.executeJavaScript = (code) => {
      page.probes.push(code)
      return Promise.resolve(3)
    }
    const word = shownPainted(page.asWebContents())
    await Promise.resolve()
    expect(page.probes).toEqual([])
    page.navigate()
    await expect(word).resolves.toBe(3)
  })

  it('contents destroyed while waiting for the commit reject as gone; contents already gone are refused before any ask', async () => {
    const page = new FakePage()
    page.url = ''
    const word = shownPainted(page.asWebContents())
    page.destroyed = true
    page.emit('destroyed')
    await expect(word).rejects.toThrow('The page is gone')
    expect(page.probes).toEqual([])
    expect(page.listenerCount('did-navigate')).toBe(0)
    const gone = new FakePage()
    gone.destroyed = true
    await expect(shownPainted(gone.asWebContents())).rejects.toThrow('The page is gone')
    expect(gone.probes).toEqual([])
  })

  it('a frame that throws from the ask rejects the word; nothing escapes', async () => {
    const page = new FakePage()
    page.mainFrame.executeJavaScript = () => {
      throw new Error('Render frame was disposed before WebFrameMain could be accessed')
    }
    let word: Promise<number> | undefined
    expect(() => {
      word = shownPainted(page.asWebContents())
    }).not.toThrow()
    await expect(word).rejects.toThrow('Render frame was disposed')
    const nullFrame = new FakePage()
    Object.defineProperty(nullFrame, 'mainFrame', { value: null })
    await expect(shownPainted(nullFrame.asWebContents())).rejects.toThrow(
      'The page has no main frame'
    )
  })
})
