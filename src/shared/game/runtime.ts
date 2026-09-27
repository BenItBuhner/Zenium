/**
 * Roll's runtime (ERR-03, §9.17): what runs inside the page. It takes the fragment `page.ts`
 * wrote, sizes the stage to the content column, draws every frame from the state `logic.ts`
 * steps, turns keys and pointers into the game's three inputs, asks the browser for the
 * profile's best and reports a run's (`bridge.ts`), flips the STAGE's theme for the night and
 * speaks the result into the live region. It is carried inline by the two documents that mount
 * it (`inlineRuntime.ts`, `runtimeEntry.ts`) on both hosts, so nothing here reaches for a host
 * API and no other page pays a byte for it.
 *
 * Every frame is one `step` and one canvas paint: no DOM is touched between a start and a crash.
 * Under reduced motion the parallax and the ground's dashes are not drawn, the game-over card
 * cuts in (a 120 ms opacity fade is what §11.3 keeps), and the score never blinks; the game
 * itself – the runner's motion – is the user's own doing and is not slowed.
 *
 * Colours are the page's tokens, read once at mount and again at each theme flip through the
 * region itself as a probe (`--v2-accent` is a `color-mix()`, which only a computed `color`
 * resolves), so the stage repaints in the page's own inks and never carries a colour of its own;
 * the one length read the same way is `--v2-radius-inner`, the corner of every box the stage
 * draws. The night (Chrome's inverted page every 700 points) is the stage's alone: the region's
 * `data-theme` flips, the tokens re-resolve under it (`zenPages.ts` restates them there), and
 * the canvas paints the other theme's `--v2-page` as its sky – §9.31's inner box at
 * `--v2-radius-inner`, a plain arc and no hairline, so a lit stage on a dark page reads as a
 * picture set into it and not a hole – a cut both ways (§11.6). The page text and the chrome
 * around it keep their colours; by day no sky is painted, so no edge shows.
 */

import {
  DUCK_HEIGHT,
  DUCK_WIDTH,
  MAX_WIDTH,
  PLAYER_SIZE,
  START_HINTS,
  createGame,
  endJump,
  formatScore,
  playerBox,
  pressDown,
  releaseDown,
  resize,
  restartOnJump,
  start,
  startHintDevice,
  startJump,
  step,
  takeBest,
  type GameState,
  type Obstacle,
  type Random,
  type StartHintDevice
} from './logic'
import { GAME_BEST_LABEL, GAME_MOUNT_ATTRIBUTE, GAME_MOUNTED_ATTRIBUTE } from './page'
import { GAME_BEST_CALLBACK, gameWindowMessage, sanitizeGameBestScore } from './bridge'

/**
 * Where the best score lives: the browser, through the bridge (`windowBestScoreHost`), or a
 * test's stand-in. `read` asks and hands every answer to `onBest` (now or later; a peer's higher
 * best can land after the mount), and returns the way to stop listening; `write` reports a run's.
 */
export interface BestScoreHost {
  read(onBest: (best: number) => void): () => void
  write(best: number): void
}

/** What the runtime is handed; every field has a browser default, tests hand their own. */
export interface GameRuntimeDeps {
  now?: () => number
  requestFrame?: (callback: (time: number) => void) => number
  cancelFrame?: (id: number) => void
  random?: Random
  best?: BestScoreHost | null
  reducedMotion?: boolean
  device?: StartHintDevice
}

export interface GameHandle {
  readonly state: GameState
  /** Stops the loop and removes every listener. */
  destroy(): void
}

/**
 * The inks the stage draws in, resolved from the page's tokens – and the one length, the corner
 * of its boxes (`--v2-radius-inner`; the cards' and the night sky's).
 */
export interface Palette {
  page: string
  text: string
  textDeemphasized: string
  border: string
  card: string
  cardBorder: string
  fill: string
  accent: string
  font: string
  radiusInner: number
}

const PALETTE_TOKENS: ReadonlyArray<[keyof Omit<Palette, 'font' | 'radiusInner'>, string]> = [
  ['page', '--v2-page'],
  ['text', '--v2-text'],
  ['textDeemphasized', '--v2-text-deemphasized'],
  ['border', '--v2-border'],
  ['card', '--v2-card'],
  ['cardBorder', '--v2-card-border'],
  ['fill', '--v2-fill'],
  ['accent', '--v2-accent']
]

/** The canvas calls the stage makes: the 2D context's, and what a test's recording stand-in gives. */
export type StageContext = Pick<
  CanvasRenderingContext2D,
  | 'clearRect'
  | 'fillRect'
  | 'beginPath'
  | 'closePath'
  | 'moveTo'
  | 'lineTo'
  | 'arcTo'
  | 'arc'
  | 'ellipse'
  | 'fill'
  | 'stroke'
  | 'fillText'
  | 'measureText'
  | 'fillStyle'
  | 'strokeStyle'
  | 'lineWidth'
  | 'lineCap'
  | 'lineJoin'
  | 'font'
  | 'textAlign'
  | 'textBaseline'
>

/** The stage's height (Chrome's runner is 150 tall). */
export const STAGE_HEIGHT = 150

/** The stroke of the ring (the app's mark, `appIcon.ts`, at this size): the art's one finish. */
export const RING_STROKE = 3

/**
 * The corner of every box on the stage – a card, the night's sky – is `--v2-radius-inner`, read
 * from the page's tokens with the palette (`readPalette`), as a PLAIN ARC: the language's
 * squircle goes on radius 8 and up (the game-over card, in the stylesheet), not here. This is
 * the token's value, 6, for a document that does not carry the token block – the fallback
 * alone; both documents that mount the game carry it (`zenPages.ts`, `errorDocumentStyle`).
 */
export const CARD_RADIUS = 6

/** The token the boxes' corner is read from. */
export const RADIUS_INNER_TOKEN = '--v2-radius-inner'

/** The obstacle a note is: two hairlines inside the card. */
const NOTE_LINE_INSET = 8

/** The parallax rings' rate against the ground. */
const PARALLAX_RATE = 0.3

/** The meter's place: its right edge from the stage's, and its baseline. */
const METER_RIGHT_PAD = 8
const METER_BASELINE = 20

/**
 * The page-family focus outline the region draws is the stylesheet's; the stage draws none. The
 * ring is the keyboard's alone (§1, A11Y-09): `onPointerDown` cancels the press and focuses the
 * region itself, so Chromium never records a pointer-made focus and its `:focus-visible`
 * heuristic reads the script's focus as the keyboard's – the ring painted under a finger (#607's
 * night stills). The stylesheet's coarse-pointer suppressor stands the region's ring down unless
 * the keyboard is what the user drives with
 * (`:root[data-pointer='coarse']:where(:not([data-input='keyboard'])) .zen-game:focus-visible`,
 * the chrome's own form), and the root's `data-input` is what tells it. The chrome keeps that
 * attribute itself (`lib/lastInput.ts`); the served documents – `zen://game`, the no-connection
 * page – run none of the chrome, so the runtime keeps it there by the chrome's rule, to the
 * letter (`runtime.test.ts` holds the two to the same answers): a pointer down is a touch; a key
 * down is the keyboard when it navigates – Tab, the arrows, Home / End / Page, Escape, the
 * function keys, a shortcut with Ctrl, Alt or Meta held; a character, Enter, Space, Backspace, a
 * lone modifier and composition say nothing, and the attribute keeps its last value.
 */
export const LAST_INPUT_ATTRIBUTE = 'data-input'

const NAVIGATION_KEYS = new Set([
  'Tab',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'Escape'
])

/** What `keydown` and `pointerdown` carry that decides the last input. */
export interface LastInputEvent {
  type: string
  key?: string
  ctrlKey?: boolean
  altKey?: boolean
  metaKey?: boolean
  isComposing?: boolean
}

/** The input an event stands for, by the chrome's rule (`inputKindOf` in `lib/lastInput.ts`). */
export function lastInputKindOf(event: LastInputEvent): 'touch' | 'keyboard' | null {
  if (event.type === 'pointerdown') return 'touch'
  if (event.type !== 'keydown' || event.isComposing) return null
  const key = event.key ?? ''
  if (NAVIGATION_KEYS.has(key) || /^F\d{1,2}$/.test(key)) return 'keyboard'
  const modifier = key === 'Control' || key === 'Alt' || key === 'Meta' || key === 'Shift'
  if ((event.ctrlKey || event.altKey || event.metaKey) && !modifier) return 'keyboard'
  return null
}

/** The page's theme, as the page's root carries it (`errorPageAttributesScript`). */
export type PageTheme = 'light' | 'dark'

export function pageThemeOf(root: { dataset: DOMStringMap }): PageTheme {
  return root.dataset.theme === 'dark' ? 'dark' : 'light'
}

/** The night's theme for a page: the other one (Chrome inverts its page, `offline.ts:903-924`). */
export function nightThemeFor(page: PageTheme): PageTheme {
  return page === 'dark' ? 'light' : 'dark'
}

/**
 * The browser as the best's keeper (`bridge.ts`): the ask goes as a window message the page
 * script relays to the core, the answer comes back through `window.zenGameBest`, which every
 * mounted stage listens on (a second answer – a peer's best landing later – reaches them all).
 */
const bestListeners = new Set<(best: number) => void>()

export function windowBestScoreHost(win: Window = window): BestScoreHost {
  return {
    read(onBest) {
      bestListeners.add(onBest)
      const w = win as Window & { [GAME_BEST_CALLBACK]?: (best: unknown) => void }
      w[GAME_BEST_CALLBACK] = (best: unknown): void => {
        const n = sanitizeGameBestScore(best)
        for (const listener of bestListeners) listener(n)
      }
      win.postMessage(gameWindowMessage({ ask: 'best' }), '*')
      return () => {
        bestListeners.delete(onBest)
        // The last stage gone, the window keeps nothing of the game (`destroy()` leaves no trace).
        if (bestListeners.size === 0) delete w[GAME_BEST_CALLBACK]
      }
    },
    write(best) {
      win.postMessage(gameWindowMessage({ best: sanitizeGameBestScore(best) }), '*')
    }
  }
}

/**
 * The page's inks for the stage, resolved through `probe` (the region itself), and the boxes'
 * corner from `--v2-radius-inner` (a `px` length; `CARD_RADIUS` where the document has none).
 */
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
  palette.radiusInner = radiusOf(style.getPropertyValue(RADIUS_INNER_TOKEN))
  return palette as Palette
}

/** A token's `px` length as a number; the fallback for anything else (unset, another unit). */
export function radiusOf(value: string, fallback = CARD_RADIUS): number {
  const match = /^\s*(\d+(?:\.\d+)?)px\s*$/.exec(value)
  return match ? Number(match[1]) : fallback
}

/** A rectangle with plain-arc corners of radius `r` (`--v2-radius-inner`; no squircle under 8). */
export function roundedRectPath(
  ctx: StageContext,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): void {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2))
  ctx.beginPath()
  ctx.moveTo(x + radius, y)
  ctx.arcTo(x + w, y, x + w, y + h, radius)
  ctx.arcTo(x + w, y + h, x, y + h, radius)
  ctx.arcTo(x, y + h, x, y, radius)
  ctx.arcTo(x, y, x + w, y, radius)
  ctx.closePath()
}

function drawCard(ctx: StageContext, p: Palette, o: Obstacle): void {
  const memberWidth = o.width / o.count
  ctx.lineWidth = 1
  for (let i = 0; i < o.count; i++) {
    const x = o.x + i * memberWidth
    roundedRectPath(ctx, x + 0.5, o.y + 0.5, memberWidth - 1, o.height - 1, p.radiusInner)
    ctx.fillStyle = p.card
    ctx.fill()
    ctx.strokeStyle = p.cardBorder
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

/**
 * The runner: the app's mark, a ring with a dot, the dot turning with the distance run; the ring
 * squashed to an ellipse for a duck. No face, no limbs – the stroke's round finish is the art.
 */
function drawPlayer(ctx: StageContext, p: Palette, state: GameState): void {
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
function drawParallax(ctx: StageContext, p: Palette, state: GameState): void {
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
function drawGround(ctx: StageContext, p: Palette, state: GameState, reduced: boolean): void {
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

/** The meter's best, as it reads before the score (`Best 00123`); '' when there is none yet. */
export function meterBestText(best: number): string {
  return best > 0 ? `${GAME_BEST_LABEL} ${formatScore(best)}` : ''
}

/** The card's line: the run's score and the best it stands against. */
export function cardScoreText(score: number, best: number): string {
  return `Score ${formatScore(score)} · ${GAME_BEST_LABEL} ${formatScore(best)}`
}

/** The meter: the score in the page ink, the best before it in the deemphasised ink. */
function drawMeter(ctx: StageContext, p: Palette, state: GameState): void {
  ctx.font = p.font
  ctx.textAlign = 'right'
  ctx.textBaseline = 'alphabetic'
  const right = state.config.width - METER_RIGHT_PAD
  ctx.fillStyle = p.text
  const score = formatScore(state.score)
  ctx.fillText(score, right, METER_BASELINE)
  const best = meterBestText(state.best)
  if (best) {
    ctx.fillStyle = p.textDeemphasized
    ctx.fillText(best, right - ctx.measureText(score).width - 12, METER_BASELINE)
  }
}

/**
 * One frame's paint. By day the stage is the page (nothing behind the shapes); at night it is
 * the other theme's page colour, the palette having been re-read under the flipped region, laid
 * as §9.31's inner box – the stage's rectangle with plain-arc corners at `--v2-radius-inner`,
 * filled and never stroked (a hairline would vanish on that contrast edge), the page showing at
 * the corners – so the lit stage reads as a picture set into the dark page and not a hole. The
 * meter hides while the game-over card stands (the card carries the score and the best).
 */
export function draw(ctx: StageContext, state: GameState, p: Palette, reduced: boolean): void {
  const { width, height } = state.config
  ctx.clearRect(0, 0, width, height)
  if (state.night) {
    roundedRectPath(ctx, 0, 0, width, height, p.radiusInner)
    ctx.fillStyle = p.page
    ctx.fill()
  }
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  if (!reduced) drawParallax(ctx, p, state)
  drawGround(ctx, p, state, reduced)
  for (const o of state.obstacles) drawCard(ctx, p, o)
  drawPlayer(ctx, p, state)
  if (state.phase !== 'over') drawMeter(ctx, p, state)
}

const JUMP_KEYS = new Set(['Space', 'ArrowUp'])
const DOWN_KEY = 'ArrowDown'
const RESTART_KEY = 'Enter'

/** The key's code, by `key` where a keyboard (a soft one) reports no `code`. */
function codeOf(e: KeyboardEvent): string {
  return e.code || (e.key === ' ' ? 'Space' : e.key)
}

/**
 * Keys aimed at another control (the page's Reload, the card's Play again) are that control's;
 * the document's own – nothing focused, or the region – are the game's. Tab is never taken.
 */
export function isOtherControl(target: EventTarget | null, root: HTMLElement): boolean {
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
  const again = root.querySelector<HTMLButtonElement>('[data-zen-game-again]')
  const live = root.querySelector<HTMLElement>('.zen-game-live')
  const ctx = canvas?.getContext('2d')
  if (!canvas || !ctx) {
    root.removeAttribute(GAME_MOUNTED_ATTRIBUTE)
    return null
  }

  const now = deps.now ?? (() => performance.now())
  const requestFrame = deps.requestFrame ?? ((cb) => requestAnimationFrame(cb))
  const cancelFrame = deps.cancelFrame ?? ((id) => cancelAnimationFrame(id))
  const random = deps.random ?? Math.random
  const host = deps.best === undefined ? windowBestScoreHost() : deps.best
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

  const state = createGame({
    width: stageWidthFor(root.clientWidth || MAX_WIDTH),
    height: STAGE_HEIGHT
  })
  let palette = readPalette(root)
  const pageTheme = pageThemeOf(document.documentElement)
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

  /**
   * Night is the STAGE's other theme, as a cut (§11.6: page colours never tween): the region's
   * `data-theme` flips and the palette is read again under it; the page keeps its own.
   */
  const showNight = (night: boolean): void => {
    if (night === nightShown) return
    nightShown = night
    if (night) root.dataset.theme = nightThemeFor(pageTheme)
    else delete root.dataset.theme
    palette = readPalette(root)
  }

  const announce = (text: string): void => {
    if (live) live.textContent = text
  }

  const writeCardScore = (): void => {
    if (cardScore) cardScore.textContent = cardScoreText(state.score, state.best)
  }

  /**
   * The card's arrival: §11.3's 180 ms pop (a scale from .96 with the fade), the 120 ms fade
   * alone under reduced motion. The keyframes touch `transform` – the stylesheet centres the
   * card by its auto margins and never by a transform, so the pop composes with the centring
   * instead of replacing it for its 180 ms (the first line's B1 on #607).
   */
  const showCard = (): void => {
    if (!card) return
    writeCardScore()
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
    // A run that set the best (or matched it) is the profile's to keep; a lesser one is not news.
    if (state.best > 0 && state.score >= state.best) host?.write(state.best)
    announce(`Game over. Score ${state.score}. ${GAME_BEST_LABEL} ${state.best}.`)
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

  // The root's last input, as the chrome keeps it (`LAST_INPUT_ATTRIBUTE`): at capture, so a
  // handler that stops the event still counts, and before the region's own `pointerdown` below
  // focuses it – the suppressor reads `touch` in the same frame the focus lands.
  const onInput = (e: Event): void => {
    const kind = lastInputKindOf(e as LastInputEvent)
    if (kind && document.documentElement.getAttribute(LAST_INPUT_ATTRIBUTE) !== kind)
      document.documentElement.setAttribute(LAST_INPUT_ATTRIBUTE, kind)
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
  const onPlayAgain = (e: Event): void => {
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
  /** The browser's answer, now or later: the best rises; a standing stage or card shows it. */
  const onBest = (best: number): void => {
    if (!takeBest(state, best)) return
    if (state.phase === 'over') writeCardScore()
    if (state.phase !== 'running') paint()
  }

  if (hint) hint.textContent = START_HINTS[device]
  setPhase()
  fit()
  const stopListening = host?.read(onBest)

  document.addEventListener('keydown', onInput, true)
  document.addEventListener('pointerdown', onInput, true)
  document.addEventListener('keydown', onKeyDown)
  document.addEventListener('keyup', onKeyUp)
  root.addEventListener('pointerdown', onPointerDown)
  root.addEventListener('pointermove', onPointerMove)
  root.addEventListener('pointerup', onPointerUp)
  root.addEventListener('pointercancel', onPointerUp)
  again?.addEventListener('click', onPlayAgain)
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
      stopListening?.()
      document.removeEventListener('keydown', onInput, true)
      document.removeEventListener('pointerdown', onInput, true)
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('keyup', onKeyUp)
      root.removeEventListener('pointerdown', onPointerDown)
      root.removeEventListener('pointermove', onPointerMove)
      root.removeEventListener('pointerup', onPointerUp)
      root.removeEventListener('pointercancel', onPointerUp)
      again?.removeEventListener('click', onPlayAgain)
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
