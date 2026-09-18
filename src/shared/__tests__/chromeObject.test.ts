// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { CHROME_OBJECT_SOURCE, completeChromeObject } from '../chromeObject'

type ChromeApp = {
  isInstalled: boolean
  getDetails(): null
  getIsInstalled(): boolean
  installState(callback?: (state: string) => void): void
  runningState(): string
  InstallState: Record<string, string>
  RunningState: Record<string, string>
}
type ChromeObject = {
  app: ChromeApp
  csi(): Record<string, number>
  loadTimes(): Record<string, unknown>
}
type ChromeWindow = Window & { chrome?: Partial<ChromeObject> & Record<string, unknown> }

/** A window carrying the bare `chrome` object Electron's engine gives pages (`null`: none). */
function bareWindow(chrome: Record<string, unknown> | null = {}): ChromeWindow {
  const win = Object.create(window) as ChromeWindow
  Object.defineProperty(win, 'chrome', {
    value: chrome ?? undefined,
    writable: true,
    configurable: true
  })
  Object.defineProperty(win, 'performance', { value: window.performance, configurable: true })
  Object.defineProperty(win, 'setTimeout', {
    value: window.setTimeout.bind(window),
    configurable: true
  })
  return win
}

/** The attributes of Chrome's own members: plain data properties, all three flags set. */
function attributes(target: object, name: string): string {
  const d = Object.getOwnPropertyDescriptor(target, name)
  if (!d) return 'absent'
  return `${d.writable ? 'w' : '-'}${d.enumerable ? 'e' : '-'}${d.configurable ? 'c' : '-'}${'get' in d ? ' accessor' : ''}`
}

describe('completeChromeObject', () => {
  it('gives a bare object Chrome 152’s members, in Chrome’s order and with its attributes', () => {
    const win = bareWindow()
    completeChromeObject(win)
    const chrome = win.chrome as ChromeObject
    // Chrome 152: Object.keys(window.chrome) → ["loadTimes", "csi", "app"].
    expect(Object.keys(chrome)).toEqual(['loadTimes', 'csi', 'app'])
    for (const name of ['loadTimes', 'csi', 'app']) expect(attributes(chrome, name)).toBe('wec')
    expect(Object.getPrototypeOf(chrome.app)).toBe(Object.prototype)
    expect(Object.keys(chrome.app)).toEqual([
      'isInstalled',
      'getDetails',
      'getIsInstalled',
      'installState',
      'runningState',
      'InstallState',
      'RunningState'
    ])
    for (const name of Object.keys(chrome.app)) expect(attributes(chrome.app, name)).toBe('wec')
  })

  it('answers like Chrome: not an app, cannot run, callback answered asynchronously', async () => {
    const win = bareWindow()
    completeChromeObject(win)
    const { app } = win.chrome as ChromeObject
    expect(app.isInstalled).toBe(false)
    expect(app.getDetails()).toBeNull()
    expect(app.getIsInstalled()).toBe(false)
    expect(app.runningState()).toBe('cannot_run')
    expect(app.InstallState).toEqual({
      DISABLED: 'disabled',
      INSTALLED: 'installed',
      NOT_INSTALLED: 'not_installed'
    })
    expect(app.RunningState).toEqual({
      CANNOT_RUN: 'cannot_run',
      READY_TO_RUN: 'ready_to_run',
      RUNNING: 'running'
    })
    expect(() => app.installState()).not.toThrow()
    let state: string | null = null
    app.installState((s) => {
      state = s
    })
    expect(state).toBeNull()
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(state).toBe('not_installed')
    for (const fn of [app.getDetails, app.getIsInstalled, app.installState, app.runningState])
      expect(fn.length).toBe(0)
  })

  it('reports timings with Chrome’s field names from the document’s navigation timing', () => {
    const win = bareWindow()
    completeChromeObject(win)
    const chrome = win.chrome as ChromeObject
    expect(Object.keys(chrome.csi())).toEqual(['startE', 'onloadT', 'pageT', 'tran'])
    expect(chrome.csi().tran).toBe(15)
    expect(Object.keys(chrome.loadTimes())).toEqual([
      'requestTime',
      'startLoadTime',
      'commitLoadTime',
      'finishDocumentLoadTime',
      'finishLoadTime',
      'firstPaintTime',
      'firstPaintAfterLoadTime',
      'navigationType',
      'wasFetchedViaSpdy',
      'wasNpnNegotiated',
      'npnNegotiatedProtocol',
      'wasAlternateProtocolAvailable',
      'connectionInfo'
    ])
    expect(chrome.loadTimes().navigationType).toBe('Other')
    // Seconds, as Chrome reports them (the csi() fields are milliseconds).
    const requestTime = chrome.loadTimes().requestTime as number
    expect(requestTime).toBeLessThan(Date.now() / 1000 + 1)
    expect(chrome.csi().startE).toBeGreaterThanOrEqual(0)
  })

  it('leaves a window without a chrome object alone (the WebView, Firefox, Safari shape)', () => {
    const win = bareWindow(null)
    completeChromeObject(win)
    expect(win.chrome).toBeUndefined()
    const notObject = bareWindow()
    Object.defineProperty(notObject, 'chrome', { value: 'string', configurable: true })
    expect(() => completeChromeObject(notObject)).not.toThrow()
    expect(notObject.chrome).toBe('string')
  })

  it('adds only what is missing and never replaces a member the engine or a page defined', () => {
    const app = { isInstalled: true }
    const runtime = { id: 'abc' }
    const win = bareWindow({ app, runtime })
    completeChromeObject(win)
    const chrome = win.chrome as ChromeObject & { runtime: unknown }
    expect(chrome.app).toBe(app)
    expect(chrome.runtime).toBe(runtime)
    expect(typeof chrome.csi).toBe('function')
    expect(typeof chrome.loadTimes).toBe('function')
    completeChromeObject(win)
    expect(Object.keys(chrome)).toEqual(['app', 'runtime', 'loadTimes', 'csi'])
  })

  it('tolerates a frozen chrome object', () => {
    const frozen = Object.freeze({})
    const win = bareWindow(frozen)
    expect(() => completeChromeObject(win)).not.toThrow()
    expect(Object.keys(frozen)).toEqual([])
  })

  it('ships as self-contained page source that runs against a given window', () => {
    const win = bareWindow()
    const run = new Function('window', CHROME_OBJECT_SOURCE)
    run(win)
    expect(typeof (win.chrome as ChromeObject).app.getDetails).toBe('function')
    // Nothing outside the function: only a `window` is needed.
    expect(CHROME_OBJECT_SOURCE.startsWith('(function completeChromeObject(')).toBe(true)
  })
})
