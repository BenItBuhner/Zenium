// The launch render budget's signal and verdict.
//
// `Session.launch` (smoke.mjs) times a launch in phases. `electron.launch()` spawns the app and
// attaches Playwright to it – the two debugger lines, both sockets, the CDP attach, then its first
// two commands IN THE MAIN PROCESS (`Runtime.enable`, the `__playwright_run` probe); the harness
// then runs two more main-process evaluates – `hookMain` and the pid read – before it finds the
// chrome page and awaits its `[data-testid="chrome-root"]`. `chromeRenderedMs` spans all of that:
// it is the handshake's clock, gated on every one of those steps, not the renderer's first paint.
//
// W8-H2's evidence, windows-x64 unpacked: two isolated launches read 10154 ms (run 36356941806,
// `agent-space-restore`, the leg's 4th launch) and 10139 ms (run 36362439181, `dark`, its 7th);
// every other launch of both legs read 0.7–2.5 s, the ones just before and after included. In both
// the whole excess sat in `launchMs` – `electron.launch()` plus `hookMain` – at 10052 and 10091 ms
// against 536–1851 ms otherwise, and the render steps after it took 102 and 48 ms, shorter than on
// any normal launch: the chrome was long painted when the handshake let go (the failure screenshots
// show a full chrome). A hold on the whole process is ruled out by the arithmetic – a boot after a
// 10 s hold needs the ≥ 536 ms every other launch needed, and 52–91 ms remained – so the app booted
// and painted WHILE the handshake waited, and the wait was in the handshake. Which of its steps, the
// logs could not say (no code deadline of 10 s exists on the path: not in Playwright 1.63's launch,
// which runs under the harness's 90 s progress deadline, not in the app's boot before its window,
// not in `hookMain`, which is synchronous). The per-phase timings – `launchResolveMs`, `hookMs`,
// `pidMs`, `chromePageMs`, `rootAttachMs` on the harness's side; `processStartMs`, `nodeStartMs`,
// `chromeNavStartMs`, `firstPaintMs` on the app's – are there so the next occurrence names it.
//
// The budget is meant to guard the chrome's FIRST PAINT and to catch a regression in what the
// chrome does before it. So the verdict is judged on the renderer's own paint timeline
// (`firstPaintMs`, read cross-process from `performance.timeOrigin` plus the paint entry, on the
// renderer thread and so independent of the handshake – `Session.readChromePaint`), and falls back
// to the composite only when the renderer reported no paint entry. A genuine paint regression
// still fails on every launch, because `firstPaintMs` itself would exceed the budget; a handshake
// that waited on something other than the paint no longer does – it is named in the log instead
// (`launchHandshakeNote`) and stays in the result as `chromeRenderedMs` with its phases.

/** A finite, non-negative number (a usable millisecond reading). */
function usable(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

/**
 * The reading the render budget is judged on: the renderer's own first paint (`firstPaintMs`)
 * where it was read, else the composite `chromeRenderedMs`. `NaN` when neither is a number (the
 * caller then has no reading to judge, as before).
 */
export function renderTimeForBudget(timings) {
  const firstPaint = timings ? timings.firstPaintMs : undefined
  if (usable(firstPaint)) return firstPaint
  const composite = timings ? timings.chromeRenderedMs : undefined
  return typeof composite === 'number' ? composite : NaN
}

/** Which reading `renderTimeForBudget` used: the renderer's paint, or the composite fallback. */
export function renderSignal(timings) {
  return usable(timings ? timings.firstPaintMs : undefined) ? 'first-paint' : 'composite'
}

/** Whether the judged reading is over `budgetMs`. A reading that is not a number is never over. */
export function overRenderBudget(timings, budgetMs) {
  const value = renderTimeForBudget(timings)
  return Number.isFinite(value) && value > budgetMs
}

/**
 * The launch step's error when the render is over budget, else null. Names the signal it judged
 * ("chrome first paint" for the renderer's paint, "chrome rendered" for the composite fallback),
 * carries the first-launch note when `firstLaunch`, and appends the composite when the paint
 * signal decided so the launch handshake time is on the record beside it.
 */
export function renderBudgetError(timings, budgetMs, { firstLaunch = false } = {}) {
  if (!overRenderBudget(timings, budgetMs)) return null
  const value = renderTimeForBudget(timings)
  const signal = renderSignal(timings)
  const what = signal === 'first-paint' ? 'chrome first paint' : 'chrome rendered'
  const suffix = firstLaunch ? ' for the first launch of the run' : ''
  const composite =
    signal === 'first-paint' && typeof timings.chromeRenderedMs === 'number'
      ? `; launch handshake ${timings.chromeRenderedMs} ms`
      : ''
  return `${what} after ${value} ms (budget ${budgetMs} ms${suffix})${composite}`
}

/** The per-phase timings a handshake note lists, in launch order, with their labels. */
const HANDSHAKE_PHASES = [
  ['launchResolveMs', 'electron.launch'],
  ['hookMs', 'hook'],
  ['pidMs', 'pid'],
  ['chromePageMs', 'page'],
  ['rootAttachMs', 'root'],
  ['paintReadMs', 'paint read'],
  ['processStartMs', 'process at'],
  ['nodeStartMs', 'node at'],
  ['chromeNavStartMs', 'chrome document at']
]

/**
 * A line for the log when the launch handshake (`chromeRenderedMs`) ran over `budgetMs` while
 * the paint it was judged on did not – the case the budget no longer fails, which must still be
 * read: the paint, the composite, and every phase that was timed. Null when the composite is
 * within budget, or when the verdict was the composite's anyway (then it failed the step).
 */
export function launchHandshakeNote(timings, budgetMs) {
  if (!timings || renderSignal(timings) !== 'first-paint') return null
  const composite = timings.chromeRenderedMs
  if (typeof composite !== 'number' || composite <= budgetMs) return null
  const phases = HANDSHAKE_PHASES.filter(([key]) => usable(timings[key])).map(
    ([key, label]) => `${label} ${timings[key]} ms`
  )
  return (
    `launch handshake ${composite} ms over the render budget (${budgetMs} ms) while the chrome ` +
    `painted at ${timings.firstPaintMs} ms` +
    (phases.length ? `; ${phases.join(', ')}` : '')
  )
}
