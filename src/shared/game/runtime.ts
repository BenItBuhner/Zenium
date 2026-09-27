/**
 * The offline game's runtime (ERR-03): what runs inside the page. It takes the fragment
 * `page.ts` wrote, sizes the stage to the content column, draws every frame from the state
 * `logic.ts` steps, turns keys and pointers into the game's three inputs, keeps the high score
 * where the document's storage allows, flips the page's theme for the night and speaks the
 * result into the live region. It is run by the page script (`shared/pageScript.ts`) in a
 * `zen:` or `chrome-error:` document on both hosts, so nothing here reaches for a host API.
 *
 * Every frame is one `step` and one canvas paint: no DOM is touched between a start and a crash.
 * Under reduced motion the parallax and the ground's dashes are not drawn, the game-over card
 * cuts in (a 120 ms opacity fade is what §11.3 keeps), and the score never blinks; the game
 * itself – the runner's motion – is the user's own doing and is not slowed.
 *
 * Colours are the page's tokens, read once at mount and again at each theme flip through a probe
 * element (`--v2-accent` is a `color-mix()`, which only a computed `color` resolves), so the
 * stage repaints in the page's own inks and never carries a colour of its own.
 */

import {
  DUCK_HEIGHT,
  DUCK_WIDTH,
  HIGH_SCORE_KEY,
  MAX_WIDTH,
  PLAYER_SIZE,
  START_HINTS,
  createGame,
  endJump,
  formatScore,
  parseHighScore,
  playerBox,
  pressDown,
  releaseDown,
  resize,
  restartOnJump,
  start,
  startHintDevice,
  startJump,
  step,
  type GameState,
  type Obstacle,
  type Random,
  type StartHintDevice
} from './logic'
import { GAME_MOUNT_ATTRIBUTE, GAME_MOUNTED_ATTRIBUTE } from './page'

/** A place the high score is kept: the document's storage, or nothing. */
export interface HighScoreStore {
  read(): number
  write(score: number): void
}

/** What the runtime is handed; every field has a browser default, tests hand their own. */
export interface GameRuntimeDeps {
  now?: () => number
  requestFrame?: (callback: (time: number) => void) => number
  cancelFrame?: (id: number) => void
  random?: Random
  store?: HighScoreStore | null
  reducedMotion?: boolean
  device?: StartHintDevice
}

export interface GameHandle {
  readonly state: GameState
  /** Stops the loop and removes every listener. */
  destroy(): void
}

/** The inks the stage draws in, resolved from the page's tokens. */
interface Palette {
  text: string
  textDeemphasized: string
  border: string
  card: string
  cardBorder: string
  fill: string
  accent: string
  font: string
}

const PALETTE_TOKENS: ReadonlyArray<[keyof Omit<Palette, 'font'>, string]> = [
  ['text', '--v2-text'],
  ['textDeemphasized', '--v2-text-deemphasized'],
  ['border', '--v2-border'],
  ['card', '--v2-card'],
  ['cardBorder', '--v2-card-border'],
  ['fill', '--v2-fill'],
  ['accent', '--v2-accent']
]

/** The stage's height (Chrome's runner is 150 tall). */
export const STAGE_HEIGHT = 150

/** The card's corner as a superellipse (§2's squircle): the handles' share of the radius. */
const SQUIRCLE_HANDLE = 0.91

/** The stroke of the ring (the app's mark, `appIcon.ts`, at this size). */
const RING_STROKE = 3

/** The corner radius of a card on the stage (`--v2-radius-inner`, 6). */
const CARD_RADIUS = 6

/** The obstacle a note is: two hairlines inside the card. */
const NOTE_LINE_INSET = 8

/** The parallax rings' rate against the ground. */
const PARALLAX_RATE = 0.3

/** The page-family focus outline the region draws is the stylesheet's; the stage draws none. */

/**
 * The document's `localStorage` as a store, when the origin allows it (a `zen:` or
 * `chrome-error:` document's may not, and the store then keeps the score for the document's
 * life alone).
 */
export function localStorageStore(storage: Storage | null | undefined): HighScoreStore {
  let memory = 0
  return {
    read() {
      try {
        return storage ? parseHighScore(storage.getItem(HIGH_SCORE_KEY)) : memory
      } catch {
        return memory
      }
    },
    write(score) {
      memory = score
      try {
        storage?.setItem(HIGH_SCORE_KEY, String(score))
      } catch {
        // The origin refused; the score stays in memory for this document.
      }
    }
  }
}

function tryLocalStorage(): Storage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

/** The page's inks for the stage, resolved through `probe` (an element inside the page). */
function readPalette(probe: HTMLElement): Palette {
  const palette: Partial<Palette> = {}
  for (const [role, token] of PALETTE_TOKENS) {
    probe.style.color = `var(${token})`
    palette[role] = getComputedStyle(probe).color
  }
  probe.style.color = ''
  const style = getComputedStyle(probe)
  const size = style.getPropertyValue('--v2-font-small').trim() || '13px'
  const weight = style.getPropertyValue('--v2-weight-heading').trim() || '600'
  palette.font = `${weight} ${size} ${style.fontFamily || 'system-ui, sans-serif'}`
  return palette as Palette
}

/** A superellipse-cornered rectangle path (the language's squircle at radius `r`). */
function squirclePath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): void {
  const radius = Math.min(r, w / 2, h / 2)
  const k = radius * SQUIRCLE_HANDLE
  ctx.beginPath()
  ctx.moveTo(x + radius, y)
  ctx.lineTo(x + w - radius, y)
  ctx.bezierCurveTo(x + w - radius + k, y, x + w, y + radius - k, x + w, y + radius)
  ctx.lineTo(x + w, y + h - radius)
  ctx.bezierCurveTo(x + w, y + h - radius + k, x + w - radius + k, y + h, x + w - radius, y + h)
  ctx.lineTo(x + radius, y + h)
  ctx.bezierCurveTo(x + radius - k, y + h, x, y + h - radius + k, x, y + h - radius)
  ctx.lineTo(x, y + radius)
  ctx.bezierCurveTo(x, y + radius - k, x + radius - k, y, x + radius, y)
  ctx.closePath()
}

function drawCard(ctx: CanvasRenderingContext2D, p: Palette, o: Obstacle): void {
  const memberWidth = o.width / o.count
  for (let i = 0; i < o.count; i++) {
    const x = o.x + i * memberWidth
    squirclePath(ctx, x + 0.5, o.y + 0.5, memberWidth - 1, o.height - 1, CARD_RADIUS)
    ctx.fillStyle = p.card
    ctx.fill()
    ctx.strokeStyle = p.cardBorder
    ctx.lineWidth = 1
    ctx.stroke()
  }
  if (o.kind === 'note') {
    ctx.strokeStyle = p.border
    ctx.beginPath()
    const third = o.height / 3
    for (let line = 1; line <= 2; line++) {
      const y = Math.round(o.y + third * line) + 0.5
      ctx.moveTo(o.x + NOTE_LINE_INSET, y)
      ctx.lineTo(o.x + o.width - NOTE_LINE_INSET - (line === 2 ? 10 : 0), y)
    }
    ctx.stroke()
  }
}

/** The runner: the app's mark, a ring with a dot, rolling; a squashed ring when ducking. */
function drawPlayer(ctx: CanvasRenderingContext2D, p: Palette, state: GameState): void {
  const box = playerBox(state.player)
  const cx = box.x + box.width / 2
  const cy = box.y + box.height / 2
  ctx.strokeStyle = p.accent
  ctx.fillStyle = p.accent
  ctx.lineWidth = RING_STROKE
  ctx.beginPath()
  if (state.player.ducking) {
    ctx.ellipse(
      cx,
      cy,
      DUCK_WIDTH / 2 - RING_STROKE / 2,
      DUCK_HEIGHT / 2 - RING_STROKE / 2,
      0,
      0,
      Math.PI * 2
    )
    ctx.stroke()
    ctx.beginPath()
    ctx.arc(cx + Math.cos(state.player.roll) * (DUCK_WIDTH / 2 - 9), cy, 2.5, 0, Math.PI * 2)
    ctx.fill()
    return
  }
  const radius = PLAYER_SIZE / 2 - RING_STROKE / 2
  ctx.arc(cx, cy, radius, 0, Math.PI * 2)
  ctx.stroke()
  const orbit = radius - 6
  ctx.beginPath()
  ctx.arc(
    cx + Math.cos(state.player.roll) * orbit,
    cy + Math.sin(state.player.roll) * orbit,
    3.5,
    0,
    Math.PI * 2
  )
  ctx.fill()
}

/** The faint rings drifting behind the run (full motion only). */
function drawParallax(ctx: CanvasRenderingContext2D, p: Palette, state: GameState): void {
  const width = state.config.width
  const span = width + 120
  ctx.strokeStyle = p.fill
  ctx.lineWidth = 2
  const rings: ReadonlyArray<[number, number, number]> = [
    [0.15, 46, 12],
    [0.42, 30, 18],
    [0.68, 58, 9],
    [0.9, 38, 14]
  ]
  for (const [at, y, r] of rings) {
    const x = ((((at * span - state.parallax * PARALLAX_RATE) % span) + span) % span) - 60
    ctx.beginPath()
    ctx.arc(x, y, r, 0, Math.PI * 2)
    ctx.stroke()
  }
}

/** The ground: a hairline, and under full motion sparse dashes passing beneath it at the speed. */
function drawGround(
  ctx: CanvasRenderingContext2D,
  p: Palette,
  state: GameState,
  reduced: boolean
): void {
  const width = state.config.width
  const y = state.ground + 0.5
  ctx.strokeStyle = p.border
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(0, y)
  ctx.lineTo(width, y)
  ctx.stroke()
  if (reduced) return
  ctx.strokeStyle = p.fill
  ctx.beginPath()
  const period = 96
  const offset = period - (state.distance % period)
  for (let x = offset - period; x < width; x += period) {
    ctx.moveTo(x, y + 5)
    ctx.lineTo(x + 14, y + 5)
  }
  ctx.stroke()
}

/** The meter: the score in the page ink, the best before it in the deemphasised ink (`Best 00123 00042`). */
function drawScore(ctx: CanvasRenderingContext2D, p: Palette, state: GameState): void {
  ctx.font = p.font
  ctx.textAlign = 'right'
  ctx.textBaseline = 'alphabetic'
  const right = state.config.width - 8
  const baseline = 20
  ctx.fillStyle = p.text
  const score = formatScore(state.score)
  ctx.fillText(score, right, baseline)
  if (state.best > 0) {
    ctx.fillStyle = p.textDeemphasized
    ctx.fillText(
      `Best ${formatScore(state.best)}`,
      right - ctx.measureText(score).width - 12,
      baseline
    )
  }
}

/** One frame's paint. */
export function draw(
  ctx: CanvasRenderingContext2D,
  state: GameState,
  p: Palette,
  reduced: boolean
): void {
  const { width, height } = state.config
  ctx.clearRect(0, 0, width, height)
  if (!reduced) drawParallax(ctx, p, state)
  drawGround(ctx, p, state, reduced)
  for (const o of state.obstacles) drawCard(ctx, p, o)
  drawPlayer(ctx, p, state)
  drawScore(ctx, p, state)
}

const JUMP_KEYS = new Set(['Space', 'ArrowUp'])
const DOWN_KEY = 'ArrowDown'
const RESTART_KEY = 'Enter'

/** The key's code, by `key` where a keyboard (a soft one) reports no `code`. */
function codeOf(e: KeyboardEvent): string {
  return e.code || (e.key === ' ' ? 'Space' : e.key)
}

/** Keys aimed at another control (the page's Reload, the card's Retry) are that control's. */
function isOtherControl(target: EventTarget | null, root: HTMLElement): boolean {
  if (!(target instanceof Element)) return false
  if (target === root) return false
  return target.matches('button, a, input, select, textarea, [contenteditable]')
}

/** The stage's width for the root's column: the column, at most the reference width. */
export function stageWidthFor(columnWidth: number): number {
  return Math.max(120, Math.min(MAX_WIDTH, Math.floor(columnWidth)))
}

/**
 * Mounts the game on `root` (the fragment `gameMarkupHtml` wrote) and returns its handle. A
 * root already mounted is left alone (null).
 */
export function mountGame(root: HTMLElement, deps: GameRuntimeDeps = {}): GameHandle | null {
  if (root.hasAttribute(GAME_MOUNTED_ATTRIBUTE)) return null
  root.setAttribute(GAME_MOUNTED_ATTRIBUTE, '')
  const canvas = root.querySelector<HTMLCanvasElement>('canvas.zen-game-stage')
  const hint = root.querySelector<HTMLElement>('.zen-game-hint')
  const card = root.querySelector<HTMLElement>('.zen-game-over')
  const cardScore = root.querySelector<HTMLElement>('.zen-game-over-score')
  const retry = root.querySelector<HTMLButtonElement>('[data-zen-game-retry]')
  const live = root.querySelector<HTMLElement>('.zen-game-live')
  const ctx = canvas?.getContext('2d')
  if (!canvas || !ctx) return null

  const now = deps.now ?? (() => performance.now())
  const requestFrame = deps.requestFrame ?? ((cb) => requestAnimationFrame(cb))
  const cancelFrame = deps.cancelFrame ?? ((id) => cancelAnimationFrame(id))
  const random = deps.random ?? Math.random
  const store = deps.store === undefined ? localStorageStore(tryLocalStorage()) : deps.store
  const motionQuery =
    deps.reducedMotion === undefined && typeof matchMedia === 'function'
      ? matchMedia('(prefers-reduced-motion: reduce)')
      : null
  let reduced = deps.reducedMotion ?? motionQuery?.matches ?? false
  const device =
    deps.device ??
    startHintDevice(
      navigator.maxTouchPoints,
      typeof matchMedia === 'function' ? matchMedia('(hover: hover)').matches : true
    )

  const state = createGame(
    { width: stageWidthFor(root.clientWidth || MAX_WIDTH), height: STAGE_HEIGHT },
    store?.read() ?? 0
  )
  let palette = readPalette(root)
  const documentRoot = document.documentElement
  const dayTheme = documentRoot.dataset.theme
  let nightShown = false
  let frame = 0
  let last = 0
  let pointerId: number | null = null
  let pointerStartY = 0
  let pointerDropped = false

  const paint = (): void => draw(ctx, state, palette, reduced)

  const fit = (): void => {
    const width = stageWidthFor(root.clientWidth || MAX_WIDTH)
    const ratio = Math.max(1, Math.min(3, window.devicePixelRatio || 1))
    if (state.config.width !== width || canvas.width !== Math.round(width * ratio)) {
      resize(state, width, STAGE_HEIGHT)
      canvas.width = Math.round(width * ratio)
      canvas.height = Math.round(STAGE_HEIGHT * ratio)
      canvas.style.width = `${width}px`
      canvas.style.height = `${STAGE_HEIGHT}px`
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
    }
    paint()
  }

  /** Night is the page's other theme, as a cut (§11.6: page colours never tween). */
  const showNight = (night: boolean): void => {
    if (night === nightShown) return
    nightShown = night
    if (night) documentRoot.dataset.theme = dayTheme === 'dark' ? 'light' : 'dark'
    else if (dayTheme === undefined) delete documentRoot.dataset.theme
    else documentRoot.dataset.theme = dayTheme
    palette = readPalette(root)
  }

  const announce = (text: string): void => {
    if (live) live.textContent = text
  }

  const showCard = (): void => {
    if (!card) return
    if (cardScore)
      cardScore.textContent = `Score ${formatScore(state.score)} · Best ${formatScore(state.best)}`
    card.hidden = false
    if (typeof card.animate === 'function') {
      if (reduced)
        card.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 120, easing: 'ease-out' })
      else
        card.animate(
          [
            { opacity: 0, transform: 'scale(0.96)' },
            { opacity: 1, transform: 'none' }
          ],
          {
            duration: 180,
            easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)'
          }
        )
    }
  }

  const setPhase = (): void => {
    root.dataset.phase = state.phase
    if (hint) hint.hidden = state.phase !== 'waiting'
    if (card && state.phase !== 'over') card.hidden = true
  }

  const onGameOver = (): void => {
    setPhase()
    showCard()
    store?.write(state.best)
    announce(`Game over. Score ${state.score}. Best ${state.best}.`)
    if (typeof navigator.vibrate === 'function' && device !== 'keyboard') navigator.vibrate(200)
  }

  const loop = (time: number): void => {
    frame = 0
    const dt = last ? time - last : 0
    last = time
    const wasRunning = state.phase === 'running'
    step(state, dt, random)
    showNight(state.night)
    paint()
    if (wasRunning && state.phase === 'over') {
      onGameOver()
      return
    }
    if (state.phase === 'running') frame = requestFrame(loop)
  }

  const run = (): void => {
    if (frame) return
    last = 0
    frame = requestFrame(loop)
  }

  const begin = (): void => {
    if (state.phase === 'running') return
    start(state)
    showNight(false)
    setPhase()
    announce('')
    run()
  }

  /** A crashed game's clock, brought to now for the restart rule (its loop is not running). */
  const catchUp = (): void => {
    const time = now()
    if (state.phase === 'over' && last) step(state, time - last, random)
    last = time
  }

  const jumpDown = (): void => {
    if (state.phase === 'waiting') {
      begin()
      return
    }
    if (state.phase === 'over') {
      catchUp()
      if (restartOnJump(state)) {
        showNight(false)
        setPhase()
        announce('')
        run()
      }
      return
    }
    startJump(state)
  }

  const onKeyDown = (e: KeyboardEvent): void => {
    if (isOtherControl(e.target, root)) return
    const code = codeOf(e)
    if (JUMP_KEYS.has(code)) {
      e.preventDefault()
      if (!e.repeat) jumpDown()
    } else if (code === DOWN_KEY) {
      e.preventDefault()
      if (!e.repeat) pressDown(state)
    } else if (code === RESTART_KEY && state.phase === 'over') {
      e.preventDefault()
      begin()
    }
  }
  const onKeyUp = (e: KeyboardEvent): void => {
    if (isOtherControl(e.target, root)) return
    const code = codeOf(e)
    if (JUMP_KEYS.has(code)) endJump(state)
    else if (code === DOWN_KEY) releaseDown(state)
  }

  const onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0 || isOtherControl(e.target, root)) return
    e.preventDefault()
    root.focus({ preventScroll: true })
    pointerId = e.pointerId
    pointerStartY = e.clientY
    pointerDropped = false
    jumpDown()
  }
  const onPointerMove = (e: PointerEvent): void => {
    if (e.pointerId !== pointerId || pointerDropped) return
    // A downward swipe mid-air is the speed drop (Down mid-air on the keyboard).
    if (e.clientY - pointerStartY > 24 && state.player.jumping) {
      pointerDropped = true
      pressDown(state)
    }
  }
  const onPointerUp = (e: PointerEvent): void => {
    if (e.pointerId !== pointerId) return
    pointerId = null
    endJump(state)
  }
  const onRetry = (e: Event): void => {
    e.preventDefault()
    begin()
    root.focus({ preventScroll: true })
  }
  const onVisibility = (): void => {
    if (document.hidden) {
      if (frame) cancelFrame(frame)
      frame = 0
    } else if (state.phase === 'running') run()
  }
  const onMotionChange = (e: MediaQueryListEvent): void => {
    reduced = e.matches
    paint()
  }

  if (hint) hint.textContent = START_HINTS[device]
  setPhase()
  fit()

  document.addEventListener('keydown', onKeyDown)
  document.addEventListener('keyup', onKeyUp)
  root.addEventListener('pointerdown', onPointerDown)
  root.addEventListener('pointermove', onPointerMove)
  root.addEventListener('pointerup', onPointerUp)
  root.addEventListener('pointercancel', onPointerUp)
  retry?.addEventListener('click', onRetry)
  document.addEventListener('visibilitychange', onVisibility)
  motionQuery?.addEventListener('change', onMotionChange)
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(fit) : null
  observer?.observe(root)
  if (!observer) window.addEventListener('resize', fit)

  return {
    state,
    destroy() {
      if (frame) cancelFrame(frame)
      frame = 0
      showNight(false)
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('keyup', onKeyUp)
      root.removeEventListener('pointerdown', onPointerDown)
      root.removeEventListener('pointermove', onPointerMove)
      root.removeEventListener('pointerup', onPointerUp)
      root.removeEventListener('pointercancel', onPointerUp)
      retry?.removeEventListener('click', onRetry)
      document.removeEventListener('visibilitychange', onVisibility)
      motionQuery?.removeEventListener('change', onMotionChange)
      observer?.disconnect()
      if (!observer) window.removeEventListener('resize', fit)
      root.removeAttribute(GAME_MOUNTED_ATTRIBUTE)
    }
  }
}

/** Mounts every unmounted game fragment in the document; the number mounted. */
export function mountGames(doc: Document = document, deps: GameRuntimeDeps = {}): number {
  let mounted = 0
  for (const root of doc.querySelectorAll<HTMLElement>(
    `[${GAME_MOUNT_ATTRIBUTE}]:not([${GAME_MOUNTED_ATTRIBUTE}])`
  ))
    if (mountGame(root, deps)) mounted++
  return mounted
}
