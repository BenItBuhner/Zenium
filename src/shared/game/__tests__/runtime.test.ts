// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { errorPageStyle } from '../../zenPages'
import { GAME_MOUNTED_ATTRIBUTE, gameMarkupHtml } from '../page'
import { GAME_BEST_CALLBACK, GAME_MESSAGE_KEY } from '../bridge'
import { MS_PER_FRAME, OBSTACLE_TYPES, PLAYER_X, START_HINTS, type Obstacle } from '../logic'
import {
  CARD_RADIUS,
  LAST_INPUT_ATTRIBUTE,
  RADIUS_INNER_TOKEN,
  cardScoreText,
  isOtherControl,
  lastInputKindOf,
  meterBestText,
  mountGame,
  mountGames,
  nightThemeFor,
  pageThemeOf,
  radiusOf,
  roundedRectPath,
  stageWidthFor,
  windowBestScoreHost,
  type BestScoreHost,
  type GameHandle,
  type LastInputEvent,
  type StageContext
} from '../runtime'

/**
 * The runtime against a happy-dom document: the canvas stood in by a recording context (happy-dom
 * draws nothing), the tokens by a `getComputedStyle` that answers `THEME:--token` for the theme
 * the probe stands under – the region's own `data-theme` when the night set one, the document's
 * otherwise – so a paint's colours say which theme they were read from, and `--v2-radius-inner`
 * as the test sets it (`radiusToken`; the token block's 6px unless a test says otherwise).
 * Frames are the test's to run (`requestFrame` queues, `tick` drains at the clock).
 */

interface Call {
  op: string
  args: unknown[]
  fillStyle: string
  strokeStyle: string
}

class RecordingContext {
  calls: Call[] = []
  fillStyle = ''
  strokeStyle = ''
  lineWidth = 1
  lineCap = 'butt'
  lineJoin = 'miter'
  font = ''
  textAlign = 'start'
  textBaseline = 'alphabetic'

  private record(op: string, args: unknown[]): void {
    this.calls.push({ op, args, fillStyle: this.fillStyle, strokeStyle: this.strokeStyle })
  }
  clearRect(...args: unknown[]): void {
    this.record('clearRect', args)
  }
  fillRect(...args: unknown[]): void {
    this.record('fillRect', args)
  }
  beginPath(): void {
    this.record('beginPath', [])
  }
  closePath(): void {
    this.record('closePath', [])
  }
  moveTo(...args: unknown[]): void {
    this.record('moveTo', args)
  }
  lineTo(...args: unknown[]): void {
    this.record('lineTo', args)
  }
  arcTo(...args: unknown[]): void {
    this.record('arcTo', args)
  }
  arc(...args: unknown[]): void {
    this.record('arc', args)
  }
  ellipse(...args: unknown[]): void {
    this.record('ellipse', args)
  }
  fill(): void {
    this.record('fill', [])
  }
  stroke(): void {
    this.record('stroke', [])
  }
  fillText(...args: unknown[]): void {
    this.record('fillText', args)
  }
  measureText(text: string): { width: number } {
    return { width: text.length * 7 }
  }
  setTransform(...args: unknown[]): void {
    this.record('setTransform', args)
  }
  /** The calls of the last paint (from its `clearRect`). */
  lastPaint(): Call[] {
    const at = this.calls.map((c) => c.op).lastIndexOf('clearRect')
    return at === -1 ? [] : this.calls.slice(at)
  }
  texts(): string[] {
    return this.lastPaint()
      .filter((c) => c.op === 'fillText')
      .map((c) => String(c.args[0]))
  }
  /**
   * The last paint's sky: the calls from the `clearRect` to the first `fill` – the night's box
   * when there is one (its path, then the fill in the page colour), nothing by day (`null`).
   */
  sky(): { path: Call[]; fill: Call } | null {
    const paint = this.lastPaint()
    const first = paint.findIndex(
      (c) => c.op === 'fill' || c.op === 'stroke' || c.op === 'fillText'
    )
    if (first === -1 || paint[first]!.op !== 'fill') return null
    const fill = paint[first]!
    return fill.fillStyle.endsWith(':--v2-page') ? { path: paint.slice(1, first), fill } : null
  }
}

/** What `getComputedStyle` answers for `--v2-radius-inner`: the token block's 6px by default. */
let radiusToken = '6px'

const canvasProto = HTMLCanvasElement.prototype as unknown as Record<string, unknown>
const originalGetContext = canvasProto.getContext
let contexts: RecordingContext[] = []

/** The test's frame source: a queue the clock drains. */
let clock = 1000
const frames = new Map<number, (time: number) => void>()
let nextFrame = 1
const deps = {
  now: () => clock,
  requestFrame: (cb: (time: number) => void): number => {
    const id = nextFrame++
    frames.set(id, cb)
    return id
  },
  cancelFrame: (id: number): void => {
    frames.delete(id)
  },
  random: () => 0.5,
  reducedMotion: false,
  device: 'keyboard' as const
}

/** Advances the clock and runs the frames queued. */
function tick(ms = MS_PER_FRAME): void {
  clock += ms
  const due = [...frames.entries()]
  frames.clear()
  for (const [, cb] of due) cb(clock)
}

/** A best-score host that records and answers on demand. */
function fakeHost(): BestScoreHost & {
  asks: number
  written: number[]
  answer(best: number): void
  stopped: number
} {
  let listener: ((best: number) => void) | null = null
  const host = {
    asks: 0,
    written: [] as number[],
    stopped: 0,
    read(onBest: (best: number) => void) {
      host.asks++
      listener = onBest
      return () => {
        host.stopped++
        listener = null
      }
    },
    write(best: number) {
      host.written.push(best)
    },
    answer(best: number) {
      listener?.(best)
    }
  }
  return host
}

function mount(extra: Partial<Parameters<typeof mountGame>[1]> = {}): {
  root: HTMLElement
  handle: GameHandle
  ctx: RecordingContext
  host: ReturnType<typeof fakeHost>
} {
  document.body.innerHTML = `<main>${gameMarkupHtml()}<h1>No internet</h1><button class="zen-v2-button" id="reload">Reload</button></main>`
  const root = document.querySelector<HTMLElement>('.zen-game')!
  const host = fakeHost()
  const handle = mountGame(root, { ...deps, best: host, ...extra })!
  expect(handle).not.toBeNull()
  mounted.push(handle)
  return { root, handle, ctx: contexts[contexts.length - 1]!, host }
}

/** The runtimes the tests mounted, unmounted after each (`afterEach`). */
const mounted: GameHandle[] = []

function key(
  type: 'keydown' | 'keyup',
  code: string,
  target: EventTarget = document,
  init: KeyboardEventInit = {}
): KeyboardEvent {
  const e = new KeyboardEvent(type, { code, bubbles: true, cancelable: true, ...init })
  target.dispatchEvent(e)
  return e
}

function card(x: number): Obstacle {
  const type = OBSTACLE_TYPES[0]!
  return {
    kind: type.kind,
    x,
    y: 138 - type.height,
    width: type.width,
    height: type.height,
    count: 1,
    speedOffset: 0,
    gap: 200,
    gone: false
  }
}

/** Runs the game into a card standing at the runner. */
function crash(handle: GameHandle): void {
  handle.state.obstacles.push(card(PLAYER_X))
  tick()
  expect(handle.state.phase).toBe('over')
}

beforeEach(() => {
  contexts = []
  frames.clear()
  clock = 1000
  radiusToken = '6px'
  canvasProto.getContext = function (this: HTMLCanvasElement) {
    const ctx = new RecordingContext()
    contexts.push(ctx)
    return ctx
  }
  vi.stubGlobal('getComputedStyle', (el: HTMLElement) => {
    const themed = el.closest<HTMLElement>('[data-theme]')
    const theme = themed?.dataset.theme ?? 'light'
    const token = el.style.color.match(/var\((--[\w-]+)\)/)?.[1]
    return {
      color: token ? `${theme}:${token}` : '',
      fontFamily: 'Inter',
      getPropertyValue: (name: string) =>
        name === '--v2-font-small'
          ? '13px'
          : name === '--v2-weight-heading'
            ? '600'
            : name === RADIUS_INNER_TOKEN
              ? radiusToken
              : ''
    }
  })
})

afterEach(() => {
  // Every mount's document listeners go with its test (a second `destroy()` is a no-op).
  for (const handle of mounted.splice(0)) handle.destroy()
  vi.unstubAllGlobals()
  canvasProto.getContext = originalGetContext
  document.body.innerHTML = ''
  delete document.documentElement.dataset.theme
})

describe('the mount', () => {
  it('marks the root, sizes the stage to the column, writes the device’s hint, paints and asks for the best', () => {
    const { root, handle, ctx, host } = mount()
    expect(root.hasAttribute(GAME_MOUNTED_ATTRIBUTE)).toBe(true)
    expect(root.dataset.phase).toBe('waiting')
    expect(root.querySelector('.zen-game-hint')!.textContent).toBe(START_HINTS.keyboard)
    expect(handle.state.config.width).toBe(600)
    // The meter reads 00000 in the page ink; no best yet, so no Best.
    expect(ctx.texts()).toEqual(['00000'])
    expect(ctx.lastPaint().find((c) => c.op === 'fillText')!.fillStyle).toBe('light:--v2-text')
    // The runner in the accent; by day nothing behind the shapes: no sky, no box, no edge.
    expect(
      ctx.lastPaint().some((c) => c.op === 'arc' && c.strokeStyle === 'light:--v2-accent')
    ).toBe(true)
    expect(ctx.sky()).toBeNull()
    expect(ctx.lastPaint().some((c) => c.op === 'fillRect')).toBe(false)
    expect(host.asks).toBe(1)
    // A second mount of the same root is refused; `mountGames` finds nothing left to mount.
    expect(mountGame(root, { ...deps, best: null })).toBeNull()
    expect(mountGames(document, { ...deps, best: null })).toBe(0)
    handle.destroy()
    expect(root.hasAttribute(GAME_MOUNTED_ATTRIBUTE)).toBe(false)
    expect(host.stopped).toBe(1)
  })

  it('mounts every fragment of a document once, and none without a canvas context', () => {
    document.body.innerHTML = `${gameMarkupHtml()}${gameMarkupHtml()}`
    expect(mountGames(document, { ...deps, best: null })).toBe(2)
    expect(mountGames(document, { ...deps, best: null })).toBe(0)
    canvasProto.getContext = () => null
    document.body.innerHTML = gameMarkupHtml()
    expect(mountGames(document, { ...deps, best: null })).toBe(0)
    expect(document.querySelector(`[${GAME_MOUNTED_ATTRIBUTE}]`)).toBeNull()
  })

  it('draws the stage’s cards with plain arcs at the inner radius, 6 (§9.17 (c))', () => {
    expect(CARD_RADIUS).toBe(6)
    const ctx = new RecordingContext()
    roundedRectPath(ctx as unknown as StageContext, 10, 20, 100, 50, CARD_RADIUS)
    const ops = ctx.calls.map((c) => c.op)
    expect(ops).toEqual(['beginPath', 'moveTo', 'arcTo', 'arcTo', 'arcTo', 'arcTo', 'closePath'])
    for (const c of ctx.calls.filter((c) => c.op === 'arcTo')) expect(c.args[4]).toBe(6)
    // The radius never exceeds half a side.
    const small = new RecordingContext()
    roundedRectPath(small as unknown as StageContext, 0, 0, 8, 4, CARD_RADIUS)
    for (const c of small.calls.filter((c) => c.op === 'arcTo')) expect(c.args[4]).toBe(2)
    expect(stageWidthFor(360)).toBe(360)
    expect(stageWidthFor(900)).toBe(600)
    expect(stageWidthFor(50)).toBe(120)
  })

  it('reads the boxes’ corner from `--v2-radius-inner` through the region, 6 where a document has none', () => {
    expect(RADIUS_INNER_TOKEN).toBe('--v2-radius-inner')
    expect(radiusOf('6px')).toBe(6)
    expect(radiusOf(' 8px ')).toBe(8)
    expect(radiusOf('0.5px')).toBe(0.5)
    expect(radiusOf('')).toBe(CARD_RADIUS)
    expect(radiusOf('6')).toBe(CARD_RADIUS)
    expect(radiusOf('1rem')).toBe(CARD_RADIUS)
    // The cards on the stage take the token's value, not a number of the runtime's own.
    radiusToken = '8px'
    const { handle, ctx } = mount()
    key('keydown', 'Space')
    handle.state.obstacles.push(card(400))
    tick()
    const arcs = ctx.lastPaint().filter((c) => c.op === 'arcTo')
    expect(arcs.length).toBeGreaterThan(0)
    for (const c of arcs) expect(c.args[4]).toBe(8)
    handle.destroy()
    // A document without the token block: the fallback, the token's own value.
    radiusToken = ''
    const plain = mount()
    key('keydown', 'Space')
    plain.handle.state.obstacles.push(card(400))
    tick()
    for (const c of plain.ctx.lastPaint().filter((c) => c.op === 'arcTo')) expect(c.args[4]).toBe(6)
  })
})

describe('the keys (§9.17, desktop’s (2))', () => {
  it('takes Space, the arrows and Enter on the document when nothing else is aimed at; never Tab', () => {
    const { handle } = mount()
    const tab = key('keydown', 'Tab')
    expect(tab.defaultPrevented).toBe(false)
    const space = key('keydown', 'Space')
    expect(space.defaultPrevented).toBe(true)
    expect(handle.state.phase).toBe('running')
    key('keyup', 'Space')
    tick()
    key('keydown', 'ArrowUp')
    expect(handle.state.player.jumping).toBe(true)
    for (let i = 0; i < 60 && handle.state.player.jumping; i++) tick()
    expect(handle.state.player.jumping).toBe(false)
    const down = key('keydown', 'ArrowDown')
    expect(down.defaultPrevented).toBe(true)
    expect(handle.state.player.ducking).toBe(true)
    key('keyup', 'ArrowDown')
    expect(handle.state.player.ducking).toBe(false)
    // A held key repeats: the repeat is not a second input.
    key('keydown', 'Space', document, { repeat: true })
    expect(handle.state.player.jumping).toBe(false)
    // The soft keyboard reports no code: the key stands in.
    key('keyup', 'Space')
    const soft = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true })
    document.dispatchEvent(soft)
    expect(soft.defaultPrevented).toBe(true)
    expect(handle.state.player.jumping).toBe(true)
  })

  it('leaves a focused control its keys: the page’s Reload and the card’s Play again keep Space and Enter', () => {
    const { root, handle } = mount()
    const reload = document.getElementById('reload')!
    reload.focus()
    const space = key('keydown', 'Space', reload)
    expect(space.defaultPrevented).toBe(false)
    expect(handle.state.phase).toBe('waiting')
    expect(isOtherControl(reload, root)).toBe(true)
    expect(isOtherControl(root, root)).toBe(false)
    expect(isOtherControl(document, root)).toBe(false)
    expect(isOtherControl(root.querySelector('canvas'), root)).toBe(false)
    expect(isOtherControl(root.querySelector('[data-zen-game-again]'), root)).toBe(true)
    // The region itself focused: the keys are the game's.
    root.focus()
    key('keydown', 'Space', root)
    expect(handle.state.phase).toBe('running')
    crash(handle)
    const again = root.querySelector<HTMLButtonElement>('[data-zen-game-again]')!
    again.focus()
    const enter = key('keydown', 'Enter', again)
    expect(enter.defaultPrevented).toBe(false)
    expect(handle.state.phase).toBe('over')
    // Its click is what plays again.
    again.click()
    expect(handle.state.phase).toBe('running')
  })
})

describe('the crash and the card (§9.17 (e))', () => {
  it('shows the card with the score and the best, hides the meter, reports the best, announces', () => {
    const { root, handle, ctx, host } = mount()
    key('keydown', 'Space')
    for (let i = 0; i < 30; i++) tick()
    expect(handle.state.score).toBeGreaterThan(0)
    // The meter draws while the run goes.
    expect(ctx.texts()).toHaveLength(1)
    crash(handle)
    const card = root.querySelector<HTMLElement>('.zen-game-over')!
    expect(card.hidden).toBe(false)
    expect(root.dataset.phase).toBe('over')
    expect(root.querySelector('.zen-game-over-score')!.textContent).toBe(
      cardScoreText(handle.state.score, handle.state.best)
    )
    expect(handle.state.best).toBe(handle.state.score)
    // The meter hides while the card stands: the last paint wrote no text at all.
    expect(ctx.texts()).toEqual([])
    expect(host.written).toEqual([handle.state.best])
    expect(root.querySelector('.zen-game-live')!.textContent).toBe(
      `Game over. Score ${handle.state.score}. Best ${handle.state.best}.`
    )
    // Frames stop with the crash.
    expect(frames.size).toBe(0)
    // Enter plays again at once; Space only after the clear time (Chrome's rule).
    key('keydown', 'Enter')
    expect(handle.state.phase).toBe('running')
    expect(card.hidden).toBe(true)
    expect(root.querySelector('.zen-game-live')!.textContent).toBe('')
    crash(handle)
    key('keydown', 'Space')
    expect(handle.state.phase).toBe('over')
    clock += 1300
    key('keydown', 'Space')
    expect(handle.state.phase).toBe('running')
  })

  it('arrives on the 180 pop – a scale the stylesheet’s centring composes with, no translate of its own (B1) – and on the 120 fade alone under reduced motion (§11.3)', () => {
    const { root, handle } = mount()
    const card = root.querySelector<HTMLElement>('.zen-game-over')!
    const animate = vi.fn()
    card.animate = animate as unknown as HTMLElement['animate']
    key('keydown', 'Space')
    crash(handle)
    expect(animate).toHaveBeenCalledTimes(1)
    const [keyframes, options] = animate.mock.calls[0] as [
      Array<Record<string, string | number>>,
      KeyframeAnimationOptions
    ]
    expect(keyframes).toEqual([
      { opacity: 0, transform: 'scale(0.96)' },
      { opacity: 1, transform: 'none' }
    ])
    expect(options.duration).toBe(180)
    // The keyframes carry no translate: the card is centred by the stylesheet's auto margins
    // (`main.css`, held by `mark.test.ts`), so the pop scales in place instead of replacing a
    // `translateX(-50%)` for its 180 ms and arriving half its width off.
    for (const frame of keyframes) expect(String(frame.transform)).not.toContain('translate')
    handle.destroy()

    const reduced = mount({ reducedMotion: true })
    const still = reduced.root.querySelector<HTMLElement>('.zen-game-over')!
    const fade = vi.fn()
    still.animate = fade as unknown as HTMLElement['animate']
    key('keydown', 'Space')
    tick()
    // No parallax rings and no dashes under the ground: nothing is stroked in the fill ink.
    expect(
      reduced.ctx.lastPaint().some((c) => c.strokeStyle === 'light:--v2-fill' && c.op === 'stroke')
    ).toBe(false)
    expect(
      reduced.ctx
        .lastPaint()
        .some((c) => c.strokeStyle === 'light:--v2-border' && c.op === 'stroke')
    ).toBe(true)
    crash(reduced.handle)
    expect(fade).toHaveBeenCalledTimes(1)
    const [fadeFrames, fadeOptions] = fade.mock.calls[0] as [
      Array<Record<string, string | number>>,
      KeyframeAnimationOptions
    ]
    expect(fadeFrames).toEqual([{ opacity: 0 }, { opacity: 1 }])
    expect(fadeOptions).toEqual({ duration: 120, easing: 'ease-out' })
  })

  it('reports no lesser run, and a run that matches the best is the profile’s to keep again', () => {
    const { handle, host } = mount()
    host.answer(500)
    expect(handle.state.best).toBe(500)
    key('keydown', 'Space')
    crash(handle)
    expect(handle.state.score).toBeLessThan(500)
    expect(host.written).toEqual([])
    expect(meterBestText(500)).toBe('Best 00500')
    expect(meterBestText(0)).toBe('')
    expect(cardScoreText(42, 500)).toBe('Score 00042 · Best 00500')
  })
})

describe('the best from the browser (§9.17 (i))', () => {
  it('rises when the host answers, now or later, and shows on the standing stage and the card', () => {
    const { root, handle, ctx, host } = mount()
    host.answer(123)
    expect(handle.state.best).toBe(123)
    expect(ctx.texts()).toEqual(['00000', 'Best 00123'])
    expect(ctx.lastPaint().filter((c) => c.op === 'fillText')[1]!.fillStyle).toBe(
      'light:--v2-text-deemphasized'
    )
    // A lower answer later (a peer's) changes nothing; a higher one lands on the card too.
    host.answer(50)
    expect(handle.state.best).toBe(123)
    key('keydown', 'Space')
    crash(handle)
    host.answer(9000)
    expect(handle.state.best).toBe(9000)
    expect(root.querySelector('.zen-game-over-score')!.textContent).toBe(
      cardScoreText(handle.state.score, 9000)
    )
  })

  it('speaks through the window: the ask and the report as messages, the answer on the callback', () => {
    const posted: Array<[unknown, string]> = []
    const win = {
      postMessage: (data: unknown, origin: string) => posted.push([data, origin])
    } as unknown as Window & Record<string, unknown>
    const host = windowBestScoreHost(win)
    const heard: number[] = []
    const stop = host.read((best) => heard.push(best))
    expect(posted).toEqual([[{ [GAME_MESSAGE_KEY]: { ask: 'best' } }, '*']])
    const callback = win[GAME_BEST_CALLBACK] as (best: unknown) => void
    expect(typeof callback).toBe('function')
    callback(321)
    callback('junk')
    callback(1e9)
    expect(heard).toEqual([321, 0, 99999])
    host.write(77.9)
    expect(posted[1]).toEqual([{ [GAME_MESSAGE_KEY]: { best: 77 } }, '*'])
    // A second stage listening keeps the callback on the window; the last one gone takes it
    // with it (N3: `destroy()` leaves no `zenGameBest` behind).
    const other: number[] = []
    const stopOther = windowBestScoreHost(win).read((best) => other.push(best))
    stop()
    expect(typeof win[GAME_BEST_CALLBACK]).toBe('function')
    ;(win[GAME_BEST_CALLBACK] as (best: unknown) => void)(5)
    expect(heard).toEqual([321, 0, 99999])
    expect(other).toEqual([5])
    stopOther()
    expect(win[GAME_BEST_CALLBACK]).toBeUndefined()
    callback(6)
    expect(heard).toEqual([321, 0, 99999])
    expect(other).toEqual([5])
  })
})

describe('the night (§9.17 (g)): the stage flips, the page does not', () => {
  it('sets the other theme on the region alone and paints its page colour as the sky, a cut both ways', () => {
    const { root, handle, ctx } = mount()
    expect(pageThemeOf(document.documentElement)).toBe('light')
    expect(nightThemeFor('light')).toBe('dark')
    expect(nightThemeFor('dark')).toBe('light')
    // No cards for this run: the night's twelve seconds pass without a crash.
    handle.state.config.clearTime = 1e9
    key('keydown', 'Space')
    tick()
    handle.state.distance = 700 / 0.025
    tick()
    expect(handle.state.night).toBe(true)
    expect(root.dataset.theme).toBe('dark')
    expect(document.documentElement.dataset.theme).toBeUndefined()
    expect(document.body.dataset.theme).toBeUndefined()
    // The sky is §9.31's inner box (the lead's (g-look) on #607): the stage's rectangle with
    // plain-arc corners at `--v2-radius-inner`, filled in the other theme's page colour and never
    // stroked – no hairline on that edge – so the page shows at the corners; never a `fillRect`.
    const sky = ctx.sky()!
    expect(sky).not.toBeNull()
    expect(sky.fill.fillStyle).toBe('dark:--v2-page')
    expect(sky.path.map((c) => c.op)).toEqual([
      'beginPath',
      'moveTo',
      'arcTo',
      'arcTo',
      'arcTo',
      'arcTo',
      'closePath'
    ])
    expect(sky.path[1]!.args).toEqual([6, 0])
    expect(sky.path[2]!.args).toEqual([600, 0, 600, 150, 6])
    expect(sky.path[3]!.args).toEqual([600, 150, 0, 150, 6])
    for (const c of sky.path.filter((c) => c.op === 'arcTo')) expect(c.args[4]).toBe(6)
    expect(ctx.lastPaint().some((c) => c.op === 'fillRect')).toBe(false)
    expect(
      ctx.lastPaint().some((c) => c.op === 'stroke' && c.strokeStyle === 'dark:--v2-page')
    ).toBe(false)
    // The palette was read again under the flipped region: the runner in the night's accent.
    expect(
      ctx.lastPaint().some((c) => c.op === 'arc' && c.strokeStyle === 'dark:--v2-accent')
    ).toBe(true)
    // Twelve seconds on, the night lifts: the attribute goes, the sky with it.
    for (let i = 0; i < 200 && handle.state.night; i++) tick(64)
    expect(handle.state.night).toBe(false)
    expect(root.hasAttribute('data-theme')).toBe(false)
    expect(ctx.sky()).toBeNull()
    expect(document.documentElement.dataset.theme).toBeUndefined()
  })

  it('rounds the night’s sky at the token’s radius, whatever the token says', () => {
    radiusToken = '8px'
    const { handle, ctx } = mount()
    handle.state.config.clearTime = 1e9
    key('keydown', 'Space')
    tick()
    handle.state.distance = 700 / 0.025
    tick()
    expect(handle.state.night).toBe(true)
    const sky = ctx.sky()!
    expect(sky.fill.fillStyle).toBe('dark:--v2-page')
    for (const c of sky.path.filter((c) => c.op === 'arcTo')) expect(c.args[4]).toBe(8)
  })

  it('on a dark page the night is light, and a crash at night keeps it until the next run', () => {
    document.documentElement.dataset.theme = 'dark'
    const { root, handle, ctx } = mount()
    key('keydown', 'Space')
    tick()
    handle.state.distance = 700 / 0.025
    tick()
    expect(root.dataset.theme).toBe('light')
    expect(ctx.sky()!.fill.fillStyle).toBe('light:--v2-page')
    expect(document.documentElement.dataset.theme).toBe('dark')
    crash(handle)
    expect(root.dataset.theme).toBe('light')
    key('keydown', 'Enter')
    expect(handle.state.night).toBe(false)
    expect(root.hasAttribute('data-theme')).toBe(false)
    handle.destroy()
    expect(document.documentElement.dataset.theme).toBe('dark')
  })
})

describe('the pointer', () => {
  it('starts and jumps on the stage, drops on a downward swipe mid-air, and leaves the card’s button alone', () => {
    const { root, handle } = mount({ device: 'touch' })
    expect(root.querySelector('.zen-game-hint')!.textContent).toBe(START_HINTS.touch)
    const canvas = root.querySelector('canvas')!
    const down = (target: Element, pointerId: number, clientY: number): PointerEvent => {
      const e = new PointerEvent('pointerdown', {
        pointerId,
        button: 0,
        clientY,
        bubbles: true,
        cancelable: true
      })
      target.dispatchEvent(e)
      return e
    }
    expect(down(canvas, 1, 100).defaultPrevented).toBe(true)
    expect(handle.state.phase).toBe('running')
    canvas.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, bubbles: true }))
    tick()
    down(canvas, 2, 100)
    expect(handle.state.player.jumping).toBe(true)
    tick()
    canvas.dispatchEvent(
      new PointerEvent('pointermove', { pointerId: 2, clientY: 140, bubbles: true })
    )
    expect(handle.state.player.speedDrop).toBe(true)
    canvas.dispatchEvent(new PointerEvent('pointerup', { pointerId: 2, bubbles: true }))
    crash(handle)
    const again = root.querySelector<HTMLButtonElement>('[data-zen-game-again]')!
    expect(down(again, 3, 10).defaultPrevented).toBe(false)
    expect(handle.state.phase).toBe('over')
  })
})

describe('the ring (§1, A11Y-09): the keyboard’s alone', () => {
  it('keeps the root’s last input by the chrome’s rule – a press is a touch, a navigating key the keyboard – so the served stylesheet’s coarse-pointer suppressor stands the region’s ring down under a finger and never the chord’s twin', () => {
    const html = document.documentElement
    html.removeAttribute(LAST_INPUT_ATTRIBUTE)
    const { root, handle } = mount({ device: 'touch' })
    const canvas = root.querySelector('canvas')!
    const reload = document.querySelector<HTMLButtonElement>('#reload')!
    const press = (target: Element): void => {
      target.dispatchEvent(
        new PointerEvent('pointerdown', {
          pointerId: 1,
          button: 0,
          clientY: 100,
          bubbles: true,
          cancelable: true
        })
      )
    }
    // A finger's press focuses the region and says `touch` on the root in the same frame: the
    // press is cancelled, so Chromium's own bookkeeping never hears a pointer focus – the root
    // is what the suppressor reads.
    press(canvas)
    expect(document.activeElement).toBe(root)
    expect(html.getAttribute(LAST_INPUT_ATTRIBUTE)).toBe('touch')
    // The game's Space and Enter say nothing (a soft keyboard sends them); a navigating key –
    // the arrows are the game's too – says the keyboard, seen at capture even from another
    // control's handler.
    key('keydown', 'Space', document, { key: ' ' })
    expect(html.getAttribute(LAST_INPUT_ATTRIBUTE)).toBe('touch')
    key('keydown', 'Enter', reload, { key: 'Enter' })
    expect(html.getAttribute(LAST_INPUT_ATTRIBUTE)).toBe('touch')
    key('keydown', 'ArrowUp', document, { key: 'ArrowUp' })
    expect(html.getAttribute(LAST_INPUT_ATTRIBUTE)).toBe('keyboard')
    // A press anywhere – another control's included – is the next touch.
    press(reload)
    expect(html.getAttribute(LAST_INPUT_ATTRIBUTE)).toBe('touch')
    key('keydown', 'Tab', reload, { key: 'Tab' })
    expect(html.getAttribute(LAST_INPUT_ATTRIBUTE)).toBe('keyboard')
    // The rule, event by event (the chrome's `inputKindOf` is held to the same answers in
    // lib/__tests__/lastInput.test.ts – shared code imports nothing of the renderer).
    const answers: [LastInputEvent, 'touch' | 'keyboard' | null][] = [
      [{ type: 'pointerdown' }, 'touch'],
      [{ type: 'keydown', key: 'Tab' }, 'keyboard'],
      [{ type: 'keydown', key: 'ArrowDown' }, 'keyboard'],
      [{ type: 'keydown', key: 'Escape' }, 'keyboard'],
      [{ type: 'keydown', key: 'F5' }, 'keyboard'],
      [{ type: 'keydown', key: 'l', ctrlKey: true }, 'keyboard'],
      [{ type: 'keydown', key: 'Control', ctrlKey: true }, null],
      [{ type: 'keydown', key: ' ' }, null],
      [{ type: 'keydown', key: 'Enter' }, null],
      [{ type: 'keydown', key: 'a' }, null],
      [{ type: 'keydown', key: 'Tab', isComposing: true }, null],
      [{ type: 'keyup', key: 'Tab' }, null]
    ]
    for (const [e, kind] of answers) expect(lastInputKindOf(e), JSON.stringify(e)).toBe(kind)
    // Unmounted, the runtime's two capture listeners go with it (other tests' `mountGames`
    // runtimes still listen on this document, so the removal is read from the call).
    const removed = vi.spyOn(document, 'removeEventListener')
    handle.destroy()
    expect(removed).toHaveBeenCalledWith('keydown', expect.any(Function), true)
    expect(removed).toHaveBeenCalledWith('pointerdown', expect.any(Function), true)
    removed.mockRestore()
    // The served stylesheet carries the region's ring with both triggers, and the suppressor
    // on `:focus-visible` alone – the chrome's form, on the region.
    const css = errorPageStyle()
    expect(css).toContain(
      '.zen-game:focus-visible,\n.zen-game[data-keyboard-focus]:focus {\n  outline: 2px solid var(--v2-ring);'
    )
    expect(css).toContain(
      ":root[data-pointer='coarse']:where(:not([data-input='keyboard'])) .zen-game:focus-visible {\n  outline: none;\n}"
    )
    expect(css).not.toMatch(/data-input[^{]*\[data-keyboard-focus\]/)
  })
})
