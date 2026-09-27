import { describe, expect, it } from 'vitest'
import {
  HOLD_RELEASE_AT_MS,
  NO_WINDOW_MESSAGE,
  QUIT_HOLD_MS,
  QUIT_TRACE_EVERY_MS,
  TARGET_CLOSED_MESSAGE,
  classifyHoldPoll,
  exitWithin,
  formatQuitTrace,
  isTargetClosedError,
  judgeHoldRelease,
  mainProcessState,
  probeOutcome,
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

describe('probeOutcome (the quit trace’s readings, W8-F9)', () => {
  it('carries the answer with the state', async () => {
    await expect(
      probeOutcome(Promise.resolve({ windows: 1, focused: true }), 1000)
    ).resolves.toEqual({ state: 'responsive', value: { windows: 1, focused: true } })
    await expect(probeOutcome(Promise.resolve(null), 1000)).resolves.toEqual({
      state: 'responsive',
      value: null
    })
  })

  it('reads gone, blocked and the error as mainProcessState does', async () => {
    await expect(probeOutcome(Promise.reject(evaluateGone), 1000)).resolves.toEqual({
      state: 'gone'
    })
    await expect(probeOutcome(pending, 20)).resolves.toEqual({ state: 'blocked' })
    await expect(probeOutcome(Promise.reject(timedOut), 1000)).resolves.toEqual({
      state: 'error: app.evaluate timed out after 30000 ms'
    })
  })
})

// ---------------------------------------------------------------------------------------------
// hold-release timed by the app's clock (W8-F9). The chord's key down and key up are two moments
// off the app's Date.now(); the polls are the harness's app.getState round trips. The fixtures
// below are the macos-x64 red of run 36301687245 (job 108570741192) re-timed: launch 5479 ms,
// menu-item 4361 ms, and a state poll whose round trip outlasted the hold.
// ---------------------------------------------------------------------------------------------

const T0 = 1_790_492_702_697 // 07:05:02.697 UTC, the chord's key down on that run
const hold = { startedAt: T0 + 1, durationMs: 1500, chord: '⌘Q' }
/** The app's timer let the keys go at 500 ms and 3 ms of slack, as the evaluate returns it. */
const released = { downAt: T0, upAt: T0 + 503, released: true, error: null }

describe('classifyHoldPoll', () => {
  const window = { downAt: T0, upAt: T0 + 503 }

  it('takes any poll that saw the hold as the arming proven', () => {
    expect(classifyHoldPoll({ askedAt: T0 + 5, answeredAt: T0 + 60, quitHold: hold }, window)).toBe(
      'armed'
    )
    // Even one that answered after the release (the release's own check reads the null after).
    expect(
      classifyHoldPoll({ askedAt: T0 + 400, answeredAt: T0 + 900, quitHold: hold }, window)
    ).toBe('armed')
  })

  it('reads a null whose whole round trip lay inside the hold as the chord arming nothing', () => {
    expect(classifyHoldPoll({ askedAt: T0 + 5, answeredAt: T0 + 60, quitHold: null }, window)).toBe(
      'not-armed'
    )
    expect(classifyHoldPoll({ askedAt: T0, answeredAt: T0 + 502, quitHold: null }, window)).toBe(
      'not-armed'
    )
  })

  it('reads a null that answered once the keys were up as proving nothing – the slow runner’s poll', () => {
    // The red's poll: one round trip of ~2.8 s from the chord.
    expect(
      classifyHoldPoll({ askedAt: T0 + 60, answeredAt: T0 + 2790, quitHold: null }, window)
    ).toBe('after-release')
    expect(
      classifyHoldPoll({ askedAt: T0 + 60, answeredAt: T0 + 503, quitHold: null }, window)
    ).toBe('after-release')
  })

  it('reads a null asked before the key down and answered under the hold as nothing proven', () => {
    expect(
      classifyHoldPoll({ askedAt: T0 - 30, answeredAt: T0 + 200, quitHold: null }, window)
    ).toBe('straddles-chord')
  })

  it('reads a null answered before the key down, and a failed read, for what they are', () => {
    expect(classifyHoldPoll({ askedAt: T0 - 90, answeredAt: T0, quitHold: null }, window)).toBe(
      'before-chord'
    )
    expect(
      classifyHoldPoll(
        { askedAt: T0 + 5, answeredAt: T0 + 60, quitHold: { error: TARGET_CLOSED_MESSAGE } },
        window
      )
    ).toBe('error')
  })
})

describe('judgeHoldRelease', () => {
  const platform = { chord: '⌘Q', durationMs: QUIT_HOLD_MS }

  it('passes the arm64 leg’s run: the keys down ≈ 500 ms, a poll that saw the hold, no problem', () => {
    const polls = [
      { askedAt: T0 + 4, answeredAt: T0 + 61, quitHold: hold },
      { askedAt: T0 + 112, answeredAt: T0 + 170, quitHold: hold },
      { askedAt: T0 + 221, answeredAt: T0 + 280, quitHold: hold },
      { askedAt: T0 + 331, answeredAt: T0 + 390, quitHold: hold },
      { askedAt: T0 + 441, answeredAt: T0 + 498, quitHold: hold },
      { askedAt: T0 + 549, answeredAt: T0 + 610, quitHold: null }
    ]
    const judged = judgeHoldRelease({ ...released, polls }, platform)
    expect(judged.heldForMs).toBe(503)
    expect(judged.heldForMs).toBeGreaterThanOrEqual(HOLD_RELEASE_AT_MS)
    expect(judged.heldForMs).toBeLessThan(QUIT_HOLD_MS)
    expect(judged.lateByMs).toBe(3)
    expect(judged.releaseAtMs).toBe(HOLD_RELEASE_AT_MS)
    expect(judged.arming).toBe('armed')
    expect(judged.hold).toEqual(hold)
    expect(judged.problems).toEqual([])
    expect(judged.note).toBeUndefined()
    expect(judged.polls.map((p) => p.verdict)).toEqual([
      'armed',
      'armed',
      'armed',
      'armed',
      'armed',
      'after-release'
    ])
    expect(judged.polls.map((p) => p.sinceDownMs)).toEqual([61, 170, 280, 390, 498, 610])
  })

  it('does not fail the slow leg: the one poll answered after the release, the hold’s length still the app’s 503 ms', () => {
    // Run 36301687245's macos-x64 poll, ~2.8 s round trip, re-timed against an in-app release:
    // the keys were up at 503 ms whatever the poll did, so nothing quit.
    const polls = [{ askedAt: T0 + 60, answeredAt: T0 + 2790, quitHold: null }]
    const judged = judgeHoldRelease({ ...released, polls }, platform)
    expect(judged.heldForMs).toBe(503)
    expect(judged.arming).toBe('unproven')
    expect(judged.hold).toBeNull()
    expect(judged.problems).toEqual([])
    expect(judged.note).toBe(
      'the state answered 2790 ms after the chord, past the release at 503 ms: arming unproven on this runner'
    )
    expect(judged.polls[0].verdict).toBe('after-release')
  })

  it('does not fail a poll that straddled the chord, nor a run of failed reads, nor no poll at all', () => {
    expect(
      judgeHoldRelease(
        { ...released, polls: [{ askedAt: T0 - 40, answeredAt: T0 + 300, quitHold: null }] },
        platform
      )
    ).toMatchObject({ arming: 'unproven', problems: [] })
    const failed = judgeHoldRelease(
      {
        ...released,
        polls: [{ askedAt: T0 + 5, answeredAt: T0 + 70, quitHold: { error: 'page.evaluate: x' } }]
      },
      platform
    )
    expect(failed).toMatchObject({ arming: 'unproven', problems: [] })
    expect(failed.note).toBe(
      'every read of the state failed: page.evaluate: x; arming unproven on this runner'
    )
    expect(judgeHoldRelease({ ...released, polls: [] }, platform)).toMatchObject({
      arming: 'unproven',
      problems: [],
      note: 'no poll answered before the release: arming unproven on this runner'
    })
  })

  it('fails a null read whose whole round trip lay inside the hold: the chord armed nothing', () => {
    const polls = [
      { askedAt: T0 + 5, answeredAt: T0 + 62, quitHold: null },
      { askedAt: T0 + 113, answeredAt: T0 + 170, quitHold: null },
      { askedAt: T0 + 560, answeredAt: T0 + 620, quitHold: null }
    ]
    const judged = judgeHoldRelease({ ...released, polls }, platform)
    expect(judged.arming).toBe('not-armed')
    expect(judged.problems).toEqual([
      "the hold did not arm: the chrome's state read no hold 62 ms after the chord went down, the keys down until 503 ms"
    ])
    expect(judged.polls.map((p) => p.verdict)).toEqual(['not-armed', 'not-armed', 'after-release'])
  })

  it('fails a release at or past the hold’s end – the app quit on the hold, the release unjudgeable', () => {
    // The 09-26 reds' wordings: 1604 and 3005 ms between the key down and the key up.
    for (const upAt of [T0 + 1500, T0 + 1604, T0 + 3005]) {
      const judged = judgeHoldRelease({ ...released, upAt, polls: [] }, platform)
      expect(judged.problems).toEqual([
        `the keys came up ${upAt - T0} ms after they went down, past the hold's 1500 ms: the release cannot be judged`
      ])
    }
    expect(
      judgeHoldRelease({ ...released, upAt: T0 + 1499, polls: [] }, platform).problems
    ).toEqual([])
  })

  it('fails a key up the app could not send, and times that make no sense', () => {
    expect(
      judgeHoldRelease(
        { ...released, released: false, error: 'the window was gone', polls: [] },
        platform
      ).problems
    ).toEqual(['the key up was not sent at 500 ms: the window was gone'])
    expect(judgeHoldRelease({ downAt: T0, upAt: T0 - 5, polls: [] }, platform).problems).toEqual([
      `the chord's times read down ${T0}, up ${T0 - 5}`
    ])
    expect(judgeHoldRelease({ downAt: T0, upAt: undefined, polls: [] }, platform)).toMatchObject({
      lateByMs: null,
      problems: [`the chord's times read down ${T0}, up undefined`]
    })
  })

  it('fails a hold that names another chord or duration than the platform’s, and only then', () => {
    const wrong = { ...hold, chord: 'Ctrl + Q' }
    const polls = [{ askedAt: T0 + 5, answeredAt: T0 + 62, quitHold: wrong }]
    expect(judgeHoldRelease({ ...released, polls }, platform).problems).toEqual([
      `the hold reads ${JSON.stringify(wrong)}`
    ])
    expect(
      judgeHoldRelease(
        {
          ...released,
          polls: [{ askedAt: T0 + 5, answeredAt: T0 + 62, quitHold: { ...hold, durationMs: 1000 } }]
        },
        platform
      ).problems
    ).toHaveLength(1)
    // Without a platform to check against the hold is recorded, not judged.
    expect(judgeHoldRelease({ ...released, polls })).toMatchObject({
      arming: 'armed',
      problems: []
    })
  })

  it('never lets the step quit the app: a passing verdict is one the two steps after it can follow (no cascade)', () => {
    // Whatever the polls did – late, failed, absent – a release under the hold's end has no
    // problem of the release's, so toggle-off and quit-at-once run against a live app.
    for (const polls of [
      [],
      [{ askedAt: T0 + 60, answeredAt: T0 + 2790, quitHold: null }],
      [{ askedAt: T0 + 5, answeredAt: T0 + 70, quitHold: { error: 'x' } }],
      [{ askedAt: T0 + 5, answeredAt: T0 + 60, quitHold: hold }]
    ]) {
      const judged = judgeHoldRelease({ ...released, polls }, platform)
      expect(judged.heldForMs).toBeLessThan(QUIT_HOLD_MS)
      expect(judged.problems).toEqual([])
    }
  })
})

describe('formatQuitTrace (the quit’s trace in a failure message, W8-F9)', () => {
  const chordAt = 1_790_484_513_945 // 04:48:33.945 UTC, run 36295201671's dark/quit chord

  it('writes one reading with its moment, the hold’s start relative to the chord', () => {
    const trace = [
      {
        at: 2512,
        quitHold: { startedAt: chordAt + 96, durationMs: 1500, chord: '⌘Q' },
        main: 'responsive',
        windows: 1,
        focused: true
      }
    ]
    expect(formatQuitTrace(trace, chordAt)).toBe(
      '+2.5s quitHold=held(⌘Q, started +0.1s, 1500 ms) main=responsive windows=1 focused=true'
    )
  })

  it('collapses the readings that agree into their span and count', () => {
    const trace = [
      { at: 2512, quitHold: null, main: 'responsive', windows: 1, focused: true },
      ...Array.from({ length: 24 }, (_, i) => ({
        at: 3012 + i * QUIT_TRACE_EVERY_MS,
        quitHold: null,
        main: 'responsive',
        windows: 1,
        focused: true
      })),
      { at: 15020, quitHold: 'gone', main: 'gone', windows: null, focused: null }
    ]
    expect(formatQuitTrace(trace, chordAt)).toBe(
      '+2.5s…+14.5s ×25 quitHold=null main=responsive windows=1 focused=true; +15.0s quitHold=gone main=gone'
    )
  })

  it('tells a hold still up from one gone, and a read that failed or blocked', () => {
    const trace = [
      {
        at: 2500,
        quitHold: { startedAt: chordAt + 50, durationMs: 1500, chord: '⌘Q' },
        main: 'responsive',
        windows: 1,
        focused: false
      },
      {
        at: 3000,
        quitHold: { error: 'page.evaluate: boom' },
        main: 'blocked',
        windows: null,
        focused: null
      },
      { at: 3500, quitHold: 'blocked', main: 'error: x', windows: null, focused: null }
    ]
    expect(formatQuitTrace(trace, chordAt)).toBe(
      '+2.5s quitHold=held(⌘Q, started +0.1s, 1500 ms) main=responsive windows=1 focused=false; +3.0s quitHold=error: page.evaluate: boom main=blocked; +3.5s quitHold=blocked main=error: x'
    )
  })

  it('says so when nothing was sampled', () => {
    expect(formatQuitTrace([], 0)).toBe('(no samples)')
    expect(formatQuitTrace(undefined)).toBe('(no samples)')
  })
})
