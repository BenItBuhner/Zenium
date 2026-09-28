// The parts of the smoke's graceful quit that need no running app.
//
// Once the app is quitting, Playwright's connections to it – the Node inspector session behind
// electronApplication.evaluate and the DevTools session behind every page call – close before the
// process exits; on a slow runner (windows-11-arm) several seconds before. A call in flight at
// that moment rejects with "Target page, context or browser has been closed". That is the quit
// happening, not a failure, and it says nothing about whether the process is gone yet: the exit
// event of the process is the only evidence the quit finished (#148, #157).

/** Playwright's message for a call whose page, context or browser closed under it. */
export const TARGET_CLOSED_MESSAGE = 'Target page, context or browser has been closed'

/**
 * Is `err` Playwright's closed-target rejection? The message carries the API name before it
 * (`electronApplication.evaluate: …`, `locator.waitFor: …`) and, from the main-process session,
 * the browser log after it.
 */
export function isTargetClosedError(err) {
  const message =
    err !== null && typeof err === 'object' && 'message' in err
      ? String(err.message)
      : String(err ?? '')
  return message.includes(TARGET_CLOSED_MESSAGE)
}

/**
 * `promise`, a Playwright call made while the app may already be quitting, except that losing
 * its target resolves it to `fallback`: the quit taking the target away is the outcome the call
 * was after, and the exit event is what confirms it. Any other rejection propagates.
 */
export function unlessTargetClosed(promise, fallback = undefined) {
  return promise.catch((e) => {
    if (isTargetClosedError(e)) return fallback
    throw e
  })
}

/** `Session.sendKeys`'s message when the app has no window left to take the keys. */
export const NO_WINDOW_MESSAGE = 'no window to send keys to'

/**
 * `promise`, a key send made while the app may already be quitting (the quit chord's release
 * after a hold that ran its time, session-08), except that finding no window resolves it to
 * `fallback`: a quit that began at the hold's end tears its windows down before the process
 * exits – on a slow runner well before – and the release meeting none is that quit under way,
 * which the exit event then confirms. Any other rejection propagates.
 */
export function unlessNoWindow(promise, fallback = undefined) {
  return promise.catch((e) => {
    const message =
      e !== null && typeof e === 'object' && 'message' in e ? String(e.message) : String(e ?? '')
    if (message.includes(NO_WINDOW_MESSAGE)) return fallback
    throw e
  })
}

/**
 * The process exit `exitPromise` resolves with, or null once `budgetMs` have passed since
 * `since` without it. An exit that has already happened wins over a budget that has already run
 * out; the timer never keeps the event loop alive past the exit.
 */
export function exitWithin(exitPromise, budgetMs, since = Date.now()) {
  const left = Math.max(0, since + budgetMs - Date.now())
  let timer
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), left)
  })
  return Promise.race([exitPromise, timeout]).finally(() => clearTimeout(timer))
}

/**
 * What `probe`, a call into the running app, came back with: `{ state: 'responsive', value }`
 * when it answered, `{ state: 'blocked' }` when it had not within `timeoutMs` (a modal native
 * dialog holds the main process's event loop), `{ state: 'gone' }` when Playwright lost the
 * target (the app is quitting, or has quit without the process exiting yet), otherwise
 * `{ state: 'error: …' }`.
 */
export function probeOutcome(probe, timeoutMs) {
  let timer
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ state: 'blocked' }), timeoutMs)
  })
  const answer = Promise.resolve(probe).then(
    (value) => ({ state: 'responsive', value }),
    (e) => ({ state: isTargetClosedError(e) ? 'gone' : `error: ${e && e.message ? e.message : e}` })
  )
  return Promise.race([answer, timeout]).finally(() => clearTimeout(timer))
}

/**
 * What `probe`, an evaluate in the app's main process, says about it: 'responsive' when it
 * answered, 'blocked' when it had not within `timeoutMs` (a modal native dialog holds the event
 * loop), 'gone' when Playwright lost the target (the app is quitting, or has quit without the
 * process exiting yet), otherwise the error.
 */
export function mainProcessState(probe, timeoutMs) {
  return probeOutcome(probe, timeoutMs).then((o) => o.state)
}

// ---------------------------------------------------------------------------------------------
// The quit hold (session-08; W8-F9). On a Mac the chord is held: its key down arms "Hold ⌘Q to
// quit" and the app quits once the keys were down for QUIT_HOLD_MS; a key up before that ends the
// hold and nothing quits. The smoke's `hold-release` step proves the second half, and its timing
// is the app's own: one evaluate in the main process sends the key down, schedules the key up on
// a timer there and returns both times off the app's clock, so the hold's length contains no
// inspector or renderer round trip. It used to – key down, then app.getState polls through the
// chrome page, then the key up – and on macos-x64 (macos-15-intel) one poll's round trip outlasted
// the hold: the app quit on the hold before the release was sent, and the step read the state
// after the quit ("the hold armed by the chord (not within 1000 ms; last value null)", "the keys
// came up 1604 ms after they went down, past the hold") – five reds in 37 hours, the arm64 twin
// green every time, no app defect. The judging below is pure so it can be tested here.
//
// The app's clock took the round trips out of the hold's length, not the runner's timer slack
// (W8-H1): the key up is a 500 ms setTimeout in the app's main process, and on a starved runner
// that timer fires late – macos-x64, run 36359347441: "the keys were down 1507 ms by the app's
// clock (release at 500 ms, 1007 ms of timer slack); arming armed", a 7 ms overshoot of the hold's
// 1500 ms with the arming proven, the other four legs green. A release at or past the hold's end
// cannot be judged (the app quit on the hold, or would have), but when that overshoot is the ONLY
// problem of the verdict it is the runner's timer, not the app: `hold-release` drives the chord
// again – up to HOLD_RELEASE_ATTEMPTS times, each attempt logged, and only once the app has shown
// it is still up with the hold cleared (`holdReleaseRedrives` decides; the step reads the state
// and the exit) – and fails when the LAST attempt still overshoots, every attempt's verdict in the
// failure's detail. Any other problem fails at once, as before. No budget widened: QUIT_HOLD_MS and
// HOLD_RELEASE_AT_MS are what they were.
// ---------------------------------------------------------------------------------------------

/** The chord held this long quits (src/core/quitHold.ts's QUIT_HOLD_MS, Chrome's `kTimeToConfirmQuit`). */
export const QUIT_HOLD_MS = 1500

/** How long `hold-release` keeps the chord down before the app's own timer lets it go. */
export const HOLD_RELEASE_AT_MS = 500

/**
 * How many times `hold-release` drives the chord before an overshoot of the hold – the runner's
 * key-up timer firing at or past QUIT_HOLD_MS with nothing else wrong – fails the step (W8-H1).
 */
export const HOLD_RELEASE_ATTEMPTS = 3

/** How often the quit's trace reads the app once no exit has come (`Session.traceQuit`). */
export const QUIT_TRACE_EVERY_MS = 500

/**
 * One `hold-release` poll of the chrome's `window.quitHold` – `{ askedAt, answeredAt, quitHold }`,
 * the harness's clock around one app.getState round trip and what it returned (null: no hold;
 * `{ error }`: the read failed) – judged against the chord's key down and key up (`downAt`,
 * `upAt`; the app's clock, which is the harness's wall clock on the same machine):
 *   'armed'           it saw the hold, whenever it answered – the arming proven;
 *   'not-armed'       it read no hold although its whole round trip lay inside the hold, the keys
 *                     down (asked at or after the key down, answered before the key up; the key
 *                     down arms the hold synchronously in `sendInputEvent`) – the chord armed
 *                     nothing;
 *   'after-release'   it answered once the keys were up, so its null says nothing of the arming
 *                     (the slow runner's poll);
 *   'straddles-chord' asked before the key down, answered while the keys were down: the state may
 *                     have been read either side of the arming – nothing proven;
 *   'before-chord'    answered before the key down;
 *   'error'           the read failed.
 */
export function classifyHoldPoll(poll, { downAt, upAt }) {
  const { askedAt, answeredAt, quitHold } = poll
  if (quitHold && typeof quitHold === 'object' && 'error' in quitHold) return 'error'
  if (quitHold) return 'armed'
  if (answeredAt <= downAt) return 'before-chord'
  if (answeredAt >= upAt) return 'after-release'
  if (askedAt >= downAt) return 'not-armed'
  return 'straddles-chord'
}

/**
 * The verdict on one `hold-release`: the chord went down at `downAt` and came up at `upAt` by the
 * app's own clock (`released` false, with `error`, when the app could not send the key up) while
 * `polls` read the chrome's state for the hold. What comes back is the step's detail –
 * `heldForMs` (= upAt − downAt; `lateByMs` past `releaseAtMs`, the timer's slack on the runner;
 * `holdMs` the hold it was judged against), the polls with their verdicts and `sinceDownMs`,
 * `arming` ('armed' | 'not-armed' | 'unproven'), the hold the state named (`hold`) – and
 * `problems`, the step's failures; none means the readings pass:
 *   - the keys came up at or past the hold's end (heldForMs >= holdMs): the app quit on the
 *     hold, or would have, and the release cannot be judged (alone, this sends the step back
 *     for another drive of the chord – `holdReleaseRedrives`);
 *   - the key up was not sent;
 *   - a poll read no hold with its whole round trip inside the hold: the chord armed nothing;
 *   - the hold seen names another chord or duration than the platform's (`chord`, `durationMs`,
 *     checked when given).
 * A poll that answered after the release, or straddled the chord, proves nothing and FAILS
 * nothing: `arming` reads 'unproven' with a `note` (every other scenario's full hold proves the
 * arming with a still, each run), and the step goes on to the release's own checks. Nothing here
 * quits the app, so the steps after it never meet a closed target (the old cascade).
 */
export function judgeHoldRelease(
  { downAt, upAt, released = true, error = null, polls = [] },
  { holdMs = QUIT_HOLD_MS, releaseAtMs = HOLD_RELEASE_AT_MS, chord, durationMs = holdMs } = {}
) {
  const heldForMs = upAt - downAt
  const judged = polls.map((p) => ({
    ...p,
    sinceDownMs: p.answeredAt - downAt,
    verdict: classifyHoldPoll(p, { downAt, upAt })
  }))
  const armed = judged.find((p) => p.verdict === 'armed')
  const notArmed = judged.find((p) => p.verdict === 'not-armed')
  const arming = armed ? 'armed' : notArmed ? 'not-armed' : 'unproven'
  const problems = []
  if (!Number.isFinite(heldForMs) || heldForMs < 0) {
    problems.push(`the chord's times read down ${downAt}, up ${upAt}`)
  } else if (heldForMs >= holdMs) {
    problems.push(
      `the keys came up ${heldForMs} ms after they went down, past the hold's ${holdMs} ms: the release cannot be judged`
    )
  }
  if (!released) {
    problems.push(`the key up was not sent at ${releaseAtMs} ms: ${error ?? 'no reason given'}`)
  }
  if (arming === 'not-armed') {
    problems.push(
      `the hold did not arm: the chrome's state read no hold ${notArmed.sinceDownMs} ms after the chord went down, the keys down until ${heldForMs} ms`
    )
  }
  if (
    armed &&
    chord !== undefined &&
    (armed.quitHold.chord !== chord || armed.quitHold.durationMs !== durationMs)
  ) {
    problems.push(`the hold reads ${JSON.stringify(armed.quitHold)}`)
  }
  let note
  if (arming === 'unproven') {
    const answered = judged.filter((p) => p.verdict !== 'error' && p.verdict !== 'before-chord')
    if (answered.length) {
      const first = Math.min(...answered.map((p) => p.sinceDownMs))
      note = `the state answered ${first} ms after the chord, past the release at ${heldForMs} ms: arming unproven on this runner`
    } else if (judged.some((p) => p.verdict === 'error')) {
      note = `every read of the state failed: ${judged.find((p) => p.verdict === 'error').quitHold.error}; arming unproven on this runner`
    } else {
      note = 'no poll answered before the release: arming unproven on this runner'
    }
  }
  return {
    heldForMs,
    holdMs,
    releaseAtMs,
    lateByMs: Number.isFinite(heldForMs) ? heldForMs - releaseAtMs : null,
    arming,
    hold: armed ? armed.quitHold : null,
    polls: judged,
    problems,
    ...(note ? { note } : {})
  }
}

/**
 * Does `judged`, one `judgeHoldRelease` verdict, send `hold-release` back for another drive of
 * the chord (W8-H1)? Only when its problems are the overshoot ALONE: the keys came up at or past
 * the hold's end (`heldForMs >= holdMs`) and nothing else was wrong – the key up went out, no
 * poll disproved the arming, the hold seen named the platform's chord and duration. That
 * overshoot is the runner's timer, not the app: the key up is a 500 ms setTimeout in the app's
 * main process, and on a starved runner it fires late (macos-x64, run 36359347441: 1507 ms, 1007
 * ms of slack, the arming proven). Whether the app is still up to be driven again is the step's
 * to read; here is only whether the verdict allows it. A verdict with any other problem fails
 * the step at once, and one with none has nothing to re-drive: false for both. The overshoot is
 * known from the numbers, not the wording: `judgeHoldRelease` pushes it for every finite
 * heldForMs at or past holdMs, so one problem with such a heldForMs is that one.
 */
export function holdReleaseRedrives(judged) {
  if (!judged || !Array.isArray(judged.problems) || judged.problems.length !== 1) return false
  return Number.isFinite(judged.heldForMs) && judged.heldForMs >= judged.holdMs
}

/** `ms` as the trace writes an offset from the chord: `+2.5s`. */
const sec = (ms) => `+${(ms / 1000).toFixed(1)}s`

/** One reading of the quit's trace, the moment left out, as the message writes it. */
function formatQuitReading(sample, since) {
  const { quitHold, main, windows, focused } = sample
  let hold
  if (quitHold === null || quitHold === undefined) hold = 'null'
  else if (typeof quitHold === 'string') hold = quitHold
  else if (typeof quitHold === 'object' && 'error' in quitHold) hold = `error: ${quitHold.error}`
  else {
    const started =
      typeof quitHold.startedAt === 'number' ? `, started ${sec(quitHold.startedAt - since)}` : ''
    hold = `held(${quitHold.chord}${started}, ${quitHold.durationMs} ms)`
  }
  const parts = [`quitHold=${hold}`, `main=${main}`]
  if (windows !== undefined && windows !== null) parts.push(`windows=${windows}`)
  if (focused !== undefined && focused !== null) parts.push(`focused=${focused}`)
  return parts.join(' ')
}

/**
 * The quit's trace as one line for a failure message: `samples` are the readings
 * `Session.sampleQuit` took – `{ at, quitHold, main, windows, focused }`, `at` in ms since the
 * chord, `quitHold` the chrome's `window.quitHold` (null, the hold's state, or 'gone' / 'blocked'
 * / `{ error }` when the read did not answer), `main` the main process's state through
 * `probeOutcome`, `windows` and `focused` what its probe counted. Consecutive readings that agree
 * collapse into one entry with their span and count, so a 15 s budget reads as a few entries:
 *
 *     +2.5s quitHold=held(⌘Q, started +0.1s, 1500 ms) main=responsive windows=1 focused=true;
 *     +3.0s…+14.5s ×24 quitHold=null main=responsive windows=1 focused=true
 *
 * `since` is the chord's moment on the same clock as the holds' `startedAt`, for the `started`
 * offset. No samples reads `(no samples)`.
 */
export function formatQuitTrace(samples, since = 0) {
  if (!samples || samples.length === 0) return '(no samples)'
  const runs = []
  for (const sample of samples) {
    const reading = formatQuitReading(sample, since)
    const last = runs[runs.length - 1]
    if (last && last.reading === reading) {
      last.to = sample.at
      last.count++
    } else {
      runs.push({ from: sample.at, to: sample.at, count: 1, reading })
    }
  }
  return runs
    .map((r) =>
      r.count === 1
        ? `${sec(r.from)} ${r.reading}`
        : `${sec(r.from)}…${sec(r.to)} ×${r.count} ${r.reading}`
    )
    .join('; ')
}
