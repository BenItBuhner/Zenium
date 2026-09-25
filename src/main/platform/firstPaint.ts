import type { WebContents } from 'electron'

/**
 * The first-paint gate for trusted input Zenium itself drives (the agent's `sendInput`, its
 * DevTools-protocol input path, extensions' `chrome.debugger` `Input.*`).
 *
 * A new http(s) HTML document's commits are deferred until its first contentful paint or 500 ms
 * of frames (paint holding), and while they are the renderer's compositor thread drops every
 * press, key, wheel and touch – not mouse moves – acking each as handled: `sendInputEvent` and
 * `Input.dispatch*` resolve as if the event landed, and the page never saw it. The 500 ms run
 * only in frames, so a machine whose display compositor is still starting (a cold runner
 * without a GPU: eight seconds measured; software GL; `--disable-gpu`) keeps a loaded, laid-out
 * page deaf to clicks with nothing to show for it. Chromium's own end of it (a timer, an honest
 * ack) is not ours to change; what is ours is not to send before the page can take it.
 *
 * The gate reads the page's state where Chromium records it (`PAINT_STATE_SCRIPT`): a `paint`
 * performance entry means a frame was presented, so a commit went through and no deferral holds
 * input back. It resolves at once for a painted page and for a parsed document of a kind paint
 * holding never defers (`zen:`, `file:`, XML), and otherwise polls the page until the entry
 * appears, a bounded time (`FIRST_PAINT_DEADLINE_MS`), then lets the input go anyway with a
 * warning – the gate is a guard on top of what worked before, not a new way to fail. A page
 * that does not answer the probe (a renderer busy in a long task, a modal dialog holding its
 * script) is not waited for either: the input goes, as it always did.
 *
 * The probe runs through the main frame (`WebFrameMain.executeJavaScript`), not the contents'
 * `executeJavaScript`, which Electron suspends until the page stops loading: the state matters
 * most while a document is still loading its subresources, laid out and interactive but with
 * no frame yet. No user gesture goes with it – a probe must not arm what it probes for. Once a
 * document has answered `painted` (or `ready`) the answer is kept until the main frame's next
 * navigation, so the gate costs nothing on the events that follow.
 *
 * Not done: a global `--allow-pre-commit-input` switch, which would let a person click into a
 * document they cannot see yet; Chrome's UX stands for real users.
 */

/** What the page answers about its paint state (`PAINT_STATE_SCRIPT`). */
export type PaintState = 'painted' | 'holding' | 'loading' | 'ready' | 'unknown'

/** How the gate let the input through. */
export type FirstPaintOutcome =
  /** A `paint` entry exists: a frame was presented. */
  | 'painted'
  /** A parsed document of a kind paint holding never defers. */
  | 'ready'
  /** The page did not answer, or errored: sent as it would have been before the gate. */
  | 'unknown'
  /** The deadline passed with the page still holding: sent anyway, with a warning. */
  | 'timeout'
  /** The contents were destroyed while waiting: nothing to send to. */
  | 'gone'

export interface FirstPaintOptions {
  /** How long to wait for the paint before letting the input go regardless. */
  deadlineMs?: number
  /** How long between two reads of the page's state while it is holding. */
  pollMs?: number
}

/**
 * The page's readiness for real input, read from where Chromium records it: `painted` – a
 * `paint` performance entry exists, so a frame was presented, so a commit went through and no
 * first-paint deferral is holding the renderer's input back; `holding` – an http(s) HTML
 * document without one, the kind paint holding defers (`document_loader.cc`: `kPaintHolding &&
 * IsA<HTMLDocument> && ProtocolIsInHttpFamily`), whose commits are or will be deferred until
 * its first contentful paint or 500 ms of frames; `loading` / `ready` – any other document
 * (`zen:`, `file:`, XML), never deferred beyond the main-frame-update hold that ends with its
 * render-blocking resources, which the parser reaching the end bounds (that hold drops input
 * too, so `loading` is waited for and `ready` is not).
 */
export const PAINT_STATE_SCRIPT = `(function () {
  if (performance.getEntriesByType('paint').length > 0) return 'painted'
  var held = /^https?:$/.test(location.protocol) && document instanceof HTMLDocument
  return held ? 'holding' : document.readyState === 'loading' ? 'loading' : 'ready'
})()`

/** A renderer that takes longer than this to answer the paint probe is not waited for. */
export const PAINT_PROBE_TIMEOUT_MS = 1000

/**
 * How long input waits for a holding page's first paint before going anyway: past the eight
 * seconds a cold runner without a GPU was measured to take, short of a wait anyone would
 * mistake for a hang.
 */
export const FIRST_PAINT_DEADLINE_MS = 10_000

/** How often a holding page is asked again. */
export const FIRST_PAINT_POLL_MS = 50

/** Documents known to take input (they answered `painted` or `ready`), until their next navigation. */
const settled = new WeakMap<WebContents, 'painted' | 'ready'>()
/** Contents whose main-frame navigations are watched, so a settled answer goes with its document. */
const watched = new WeakSet<WebContents>()
/** Main-frame navigations seen per contents: an answer read across one is not kept. */
const generations = new WeakMap<WebContents, number>()

function watch(wc: WebContents): void {
  if (watched.has(wc)) return
  watched.add(wc)
  const bump = (): void => {
    settled.delete(wc)
    generations.set(wc, (generations.get(wc) ?? 0) + 1)
  }
  // Both ends of a cross-document navigation: from its start the old document is on its way
  // out, and at its commit the new one is in – an answer read across either is the old one's.
  wc.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) bump()
  })
  wc.on('did-navigate', bump)
}

/** Whether the document is known to take input (a kept `painted` / `ready` answer). */
export function paintSettled(wc: WebContents): boolean {
  return settled.has(wc)
}

/**
 * One read of the page's paint state, bounded by `PAINT_PROBE_TIMEOUT_MS`; `unknown` for a page
 * that did not answer in time, errored, or is gone. A `painted` or `ready` answer is kept for
 * the document (`paintSettled`) unless a main-frame navigation happened while it was read.
 */
export async function paintState(
  wc: WebContents,
  timeoutMs: number = PAINT_PROBE_TIMEOUT_MS
): Promise<PaintState> {
  if (wc.isDestroyed()) return 'unknown'
  const known = settled.get(wc)
  if (known) return known
  watch(wc)
  const generation = generations.get(wc) ?? 0
  const state = await probe(wc, timeoutMs)
  if (
    (state === 'painted' || state === 'ready') &&
    !wc.isDestroyed() &&
    (generations.get(wc) ?? 0) === generation
  ) {
    settled.set(wc, state)
  }
  return state
}

async function probe(wc: WebContents, timeoutMs: number): Promise<PaintState> {
  let frame: Pick<Electron.WebFrameMain, 'executeJavaScript'> | null
  try {
    frame = wc.mainFrame
  } catch {
    return 'unknown'
  }
  if (!frame) return 'unknown'
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<PaintState>((resolve) => {
    timer = setTimeout(() => resolve('unknown'), timeoutMs)
  })
  try {
    const answer = await Promise.race([
      frame.executeJavaScript(PAINT_STATE_SCRIPT, false).catch((): PaintState => 'unknown'),
      late
    ])
    return isPaintState(answer) ? answer : 'unknown'
  } finally {
    clearTimeout(timer)
  }
}

function isPaintState(value: unknown): value is PaintState {
  return (
    value === 'painted' ||
    value === 'holding' ||
    value === 'loading' ||
    value === 'ready' ||
    value === 'unknown'
  )
}

/**
 * Whether the page's renderer takes real input yet (`TabView.hasPainted`): painted, or a
 * parsed document paint holding never defers; true too when the page did not answer – the
 * question is a guard, and an answer the host is unsure of should be yes.
 */
export async function hasPainted(wc: WebContents): Promise<boolean> {
  const state = await paintState(wc)
  return state !== 'holding' && state !== 'loading'
}

/**
 * Hold trusted input until the page can take it: resolves at once for a painted page, a parsed
 * document paint holding never defers, or a page that does not answer; otherwise reads the
 * state again every `pollMs` until the paint, or `deadlineMs` from the call, after which the
 * input goes anyway with a warning. Callers send on any outcome but `gone`.
 */
export async function awaitFirstPaint(
  wc: WebContents,
  options: FirstPaintOptions = {}
): Promise<FirstPaintOutcome> {
  const deadlineMs = options.deadlineMs ?? FIRST_PAINT_DEADLINE_MS
  const pollMs = options.pollMs ?? FIRST_PAINT_POLL_MS
  const deadline = Date.now() + deadlineMs
  for (;;) {
    if (wc.isDestroyed()) return 'gone'
    const state = await paintState(wc)
    if (wc.isDestroyed()) return 'gone'
    if (state === 'painted' || state === 'ready') return state
    if (state === 'unknown') return 'unknown'
    const left = deadline - Date.now()
    if (left <= 0) {
      console.warn(
        `[zen] input: the page has not painted after ${Math.round(deadlineMs / 1000)} s (${describe(wc)}); sending anyway`
      )
      return 'timeout'
    }
    await sleep(Math.min(pollMs, left))
  }
}

/**
 * Whether a DevTools-protocol command is input the paint-holding compositor would drop: the
 * `Input.dispatch*` commands and `Input.insertText`, less a bare mouse move, which is never
 * suppressed (and which drags send by the hundred).
 */
export function paintGatedCommand(method: string, params: Record<string, unknown>): boolean {
  switch (method) {
    case 'Input.dispatchMouseEvent':
      return params.type !== 'mouseMoved'
    case 'Input.dispatchKeyEvent':
    case 'Input.dispatchTouchEvent':
    case 'Input.insertText':
      return true
    default:
      return false
  }
}

function describe(wc: WebContents): string {
  try {
    return wc.getURL() || `contents ${wc.id}`
  } catch {
    return 'contents gone'
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
