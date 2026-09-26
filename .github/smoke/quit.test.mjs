import { describe, expect, it } from 'vitest'
import {
  NO_WINDOW_MESSAGE,
  TARGET_CLOSED_MESSAGE,
  exitWithin,
  isTargetClosedError,
  mainProcessState,
  unlessNoWindow,
  unlessTargetClosed
} from './quit.mjs'

// Playwright prefixes the API name and, for the main-process session, appends the browser log.
const evaluateGone = new Error(
  `electronApplication.evaluate: ${TARGET_CLOSED_MESSAGE}\nBrowser logs:\n\n<launching> zenium.exe --inspect=0\n[pid=10068][err] Waiting for the debugger to disconnect...`
)
const waitForGone = new Error(`locator.waitFor: ${TARGET_CLOSED_MESSAGE}`)
const clickGone = new Error(`locator.click: ${TARGET_CLOSED_MESSAGE}`)
const timedOut = new Error('app.evaluate timed out after 30000 ms')
const noWindow = new Error(NO_WINDOW_MESSAGE)
// Playwright prefixes the API name here too: the throw comes from inside the main-process evaluate.
const noWindowFromEvaluate = new Error(`electronApplication.evaluate: Error: ${NO_WINDOW_MESSAGE}`)
const pending = new Promise(() => {})

describe('isTargetClosedError', () => {
  it('recognises the closed-target rejection of every Playwright call', () => {
    expect(isTargetClosedError(evaluateGone)).toBe(true)
    expect(isTargetClosedError(waitForGone)).toBe(true)
    expect(isTargetClosedError(clickGone)).toBe(true)
    expect(isTargetClosedError(new Error(TARGET_CLOSED_MESSAGE))).toBe(true)
  })

  it('leaves a blocked main process, a harness error and other rejections alone', () => {
    expect(isTargetClosedError(timedOut)).toBe(false)
    expect(isTargetClosedError(noWindow)).toBe(false)
    expect(isTargetClosedError(new Error('Target crashed'))).toBe(false)
    expect(isTargetClosedError(new Error(''))).toBe(false)
  })

  it('copes with rejections that are not Error objects', () => {
    expect(isTargetClosedError(`page.click: ${TARGET_CLOSED_MESSAGE}`)).toBe(true)
    expect(isTargetClosedError({ message: TARGET_CLOSED_MESSAGE })).toBe(true)
    expect(isTargetClosedError('closed')).toBe(false)
    expect(isTargetClosedError(null)).toBe(false)
    expect(isTargetClosedError(undefined)).toBe(false)
    expect(isTargetClosedError({})).toBe(false)
  })
})

describe('unlessTargetClosed', () => {
  it('passes a value through', async () => {
    await expect(unlessTargetClosed(Promise.resolve(3))).resolves.toBe(3)
  })

  it('turns a lost target into the fallback', async () => {
    await expect(unlessTargetClosed(Promise.reject(evaluateGone))).resolves.toBeUndefined()
    await expect(unlessTargetClosed(Promise.reject(clickGone), 'gone')).resolves.toBe('gone')
  })

  it('propagates every other rejection', async () => {
    await expect(unlessTargetClosed(Promise.reject(noWindow))).rejects.toBe(noWindow)
    await expect(unlessTargetClosed(Promise.reject(timedOut))).rejects.toBe(timedOut)
  })
})

describe('unlessNoWindow (the quit chord’s release after a hold that ran its time, session-08)', () => {
  it('passes a value through', async () => {
    await expect(unlessNoWindow(Promise.resolve('sent'))).resolves.toBe('sent')
  })

  it('turns a release that found no window – the held quit tearing them down before the process exits – into the fallback', async () => {
    await expect(unlessNoWindow(Promise.reject(noWindow))).resolves.toBeUndefined()
    await expect(unlessNoWindow(Promise.reject(noWindowFromEvaluate), 'gone')).resolves.toBe('gone')
    await expect(
      unlessNoWindow(Promise.reject(`evaluate: ${NO_WINDOW_MESSAGE}`))
    ).resolves.toBeUndefined()
  })

  it('propagates every other rejection, the lost target included (that one is unlessTargetClosed’s)', async () => {
    await expect(unlessNoWindow(Promise.reject(timedOut))).rejects.toBe(timedOut)
    await expect(unlessNoWindow(Promise.reject(evaluateGone))).rejects.toBe(evaluateGone)
    await expect(unlessNoWindow(Promise.reject(null))).rejects.toBeNull()
  })

  it('composes with unlessTargetClosed: the release meets a quit under way either way', async () => {
    await expect(
      unlessNoWindow(unlessTargetClosed(Promise.reject(noWindow)))
    ).resolves.toBeUndefined()
    await expect(
      unlessNoWindow(unlessTargetClosed(Promise.reject(evaluateGone)))
    ).resolves.toBeUndefined()
    await expect(unlessNoWindow(unlessTargetClosed(Promise.reject(timedOut)))).rejects.toBe(
      timedOut
    )
  })
})

describe('exitWithin', () => {
  const exit = { code: 0, signal: null, at: 1 }

  it('resolves with the exit when it comes within the budget', async () => {
    const late = new Promise((r) => setTimeout(() => r(exit), 20))
    await expect(exitWithin(late, 2000)).resolves.toBe(exit)
  })

  it('resolves with null once the budget has run out without an exit', async () => {
    const t0 = Date.now()
    await expect(exitWithin(pending, 30)).resolves.toBeNull()
    expect(Date.now() - t0).toBeGreaterThanOrEqual(25)
  })

  it('counts the budget from `since`, not from the call', async () => {
    const t0 = Date.now()
    await expect(exitWithin(pending, 500, Date.now() - 480)).resolves.toBeNull()
    expect(Date.now() - t0).toBeLessThan(400)
    await expect(exitWithin(pending, 100, Date.now() - 5000)).resolves.toBeNull()
  })

  it('lets an exit that already happened win over a budget that already ran out', async () => {
    await expect(exitWithin(Promise.resolve(exit), 100, Date.now() - 5000)).resolves.toBe(exit)
  })
})

describe('mainProcessState', () => {
  it('is responsive when the probe answers', async () => {
    await expect(mainProcessState(Promise.resolve('ok'), 1000)).resolves.toBe('responsive')
  })

  it('is gone when the probe lost its target', async () => {
    await expect(mainProcessState(Promise.reject(evaluateGone), 1000)).resolves.toBe('gone')
  })

  it('is blocked when the probe has not answered within the timeout', async () => {
    await expect(mainProcessState(pending, 20)).resolves.toBe('blocked')
  })

  it('reports any other failure of the probe', async () => {
    await expect(mainProcessState(Promise.reject(timedOut), 1000)).resolves.toBe(
      'error: app.evaluate timed out after 30000 ms'
    )
    await expect(mainProcessState(Promise.reject('boom'), 1000)).resolves.toBe('error: boom')
  })
})
