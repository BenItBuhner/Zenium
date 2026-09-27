/**
 * The offline game's rules (ERR-03 / WID-04): Zenium's own endless runner, drawn on the
 * `net::ERR_INTERNET_DISCONNECTED` page and at `zen://game`. This module is the whole of the
 * game that is not a pixel or a listener: pure functions over a `GameState`, fed a frame's
 * elapsed time and a random source, so every rule here – the speed ramp, the spawn spacing, the
 * jump arc, the collision, the score, the day-night clock – is a unit test and never a screenshot.
 *
 * The CONTRACT is Chrome's (152.0.7977.89, `components/neterror/resources/dino_game/`): one
 * input starts and jumps (`offline.ts:1064-1131`), a held jump goes higher and a release cuts it
 * short (`trex.ts`: `DROP_VELOCITY`), down mid-air is the speed drop and down on the ground is
 * the duck, the speed ramps by `ACCELERATION` a frame from 6 towards 13 (`offline.ts:61-70`),
 * obstacles keep a gap of `width × speed + minGap × gapCoefficient` up to 1.5 of it
 * (`obstacle.ts:204-208`) and never repeat more than twice (`horizon.ts`), the score is the
 * distance × 0.025 in five digits (`distance_meter.ts:28-40`), night falls every 700 points for
 * twelve seconds (`offline.ts:903-924`), and after a crash a jump input restarts only past
 * `GAMEOVER_CLEAR_TIME` (`offline.ts:1136-1162`). The ART is Zenium's own: the runner is the
 * app's mark – a ring with a dot – rolling over a page, the obstacles standing cards and floating
 * notes. Nothing here is a dinosaur, a cactus or a bird.
 *
 * Every velocity is in canvas px per 60 Hz frame, as Chrome's are, and scaled by the frame's
 * elapsed time (`dt / msPerFrame`), so a 120 Hz screen and a stalled tab play the same game.
 */

/** The stage's shape, the speeds, the timings. Chrome's numbers unless stated. */
export interface GameConfig {
  /** The stage's width in CSS px; the page fits it to the content column, at most `MAX_WIDTH`. */
  width: number
  /** The stage's height in CSS px (Chrome's runner is 150 tall, `neterror.css:367-372`). */
  height: number
  /** Ground line's distance from the stage's bottom edge. */
  bottomPad: number
  /** Speed at the start, px a frame. */
  speed: number
  maxSpeed: number
  /** Added to the speed every frame until `maxSpeed`. */
  acceleration: number
  gravity: number
  /** The jump's take-off velocity (negative is up). */
  jumpVelocity: number
  /** A release before the apex sets the velocity to this, cutting the jump short. */
  dropVelocity: number
  /** The height a jump always reaches before a release can cut it. */
  minJumpHeight: number
  /** The speed drop's multiplier on the fall. */
  speedDropCoefficient: number
  /** Ms after the start with no obstacle. */
  clearTime: number
  /** Multiplies an obstacle kind's own minimum gap. */
  gapCoefficient: number
  /** The largest gap is the smallest × this. */
  maxGapCoefficient: number
  /** The same kind may not follow itself more than this many times. */
  maxObstacleDuplication: number
  /** The score is the distance × this. */
  scoreCoefficient: number
  /** Night falls at every multiple of this score. */
  nightDistance: number
  /** How long a night lasts, ms. */
  nightDuration: number
  /** Ms after a crash before a jump input restarts (a Retry press restarts at once). */
  gameOverClearTime: number
}

/** The stage's reference width: the speed is set for it and scaled down on narrower stages. */
export const MAX_WIDTH = 600

/** Chrome's mobile scaling (`offline.ts:485-497`): the speed for a narrower stage, never faster. */
export const MOBILE_SPEED_COEFFICIENT = 1.2

/** Ms of one 60 Hz frame; every velocity is per this. */
export const MS_PER_FRAME = 1000 / 60

/** The most a frame may account for: a tab that slept resumes from where it was, not into a wall. */
export const MAX_FRAME_MS = 64

export const DEFAULT_CONFIG: Readonly<GameConfig> = {
  width: MAX_WIDTH,
  height: 150,
  bottomPad: 12,
  speed: 6,
  maxSpeed: 13,
  acceleration: 0.001,
  gravity: 0.6,
  jumpVelocity: -10,
  dropVelocity: -5,
  minJumpHeight: 30,
  speedDropCoefficient: 3,
  clearTime: 3000,
  gapCoefficient: 0.6,
  maxGapCoefficient: 1.5,
  maxObstacleDuplication: 2,
  scoreCoefficient: 0.025,
  nightDistance: 700,
  nightDuration: 12000,
  gameOverClearTime: 1200
}

/** Where the runner stands, from the stage's left edge. */
export const PLAYER_X = 24
/** The runner's box standing: the ring's diameter. */
export const PLAYER_SIZE = 30
/** The runner's box ducking: the ring squashed to a low ellipse. */
export const DUCK_WIDTH = 42
export const DUCK_HEIGHT = 16

/** A box in stage coordinates (`y` down from the stage's top). */
export interface Box {
  x: number
  y: number
  width: number
  height: number
}

/**
 * The runner's collision boxes, relative to its own box (Chrome's trex carries six,
 * `trex.ts:40-58`): standing, a cross that leaves the ring's empty corners out; ducking, the
 * ellipse's middle band.
 */
export const STANDING_BOXES: ReadonlyArray<Box> = [
  { x: 4, y: 0, width: 22, height: 30 },
  { x: 0, y: 4, width: 30, height: 22 }
]
export const DUCKING_BOXES: ReadonlyArray<Box> = [{ x: 2, y: 2, width: 38, height: 12 }]

export type ObstacleKind = 'card-small' | 'card-tall' | 'note'

/** An obstacle kind's shape and its spawn rule (Chrome's `Obstacle.types`, `obstacle.ts`). */
export interface ObstacleType {
  kind: ObstacleKind
  width: number
  height: number
  /** Its own minimum gap to the next obstacle, before the speed's share. */
  minGap: number
  /** Appears only once the speed has reached this. */
  minSpeed: number
  /** Comes in groups of up to three once the speed passes this (0: never grouped). */
  multipleSpeed: number
  /** Tops the kind may float at (stage `y`); empty for one standing on the ground. */
  yPositions: ReadonlyArray<number>
  /** A floating kind moves at the speed ± this. */
  speedOffset: number
}

/** The stage's obstacles: two standing cards to jump, a floating note to duck under or leap. */
export const OBSTACLE_TYPES: ReadonlyArray<ObstacleType> = [
  {
    kind: 'card-small',
    width: 20,
    height: 32,
    minGap: 120,
    minSpeed: 0,
    multipleSpeed: 4,
    yPositions: [],
    speedOffset: 0
  },
  {
    kind: 'card-tall',
    width: 26,
    height: 48,
    minGap: 120,
    minSpeed: 0,
    multipleSpeed: 7,
    yPositions: [],
    speedOffset: 0
  },
  {
    // Low: it must be jumped (a duck still meets it). Middle: a duck slips under, a jump clears
    // it. High: it passes over a standing runner and catches one who jumps into it.
    kind: 'note',
    width: 48,
    height: 28,
    minGap: 150,
    minSpeed: 8.5,
    multipleSpeed: 0,
    yPositions: [106, 92, 60],
    speedOffset: 0.8
  }
]

/** Up to three of a kind stand together (Chrome's `MAX_OBSTACLE_LENGTH`). */
export const MAX_OBSTACLE_LENGTH = 3

export interface Obstacle {
  kind: ObstacleKind
  x: number
  y: number
  /** The group's whole width (`count` of the kind side by side). */
  width: number
  height: number
  count: number
  /** Px a frame beside the stage's speed (a floating note's drift). */
  speedOffset: number
  /** The gap the next obstacle keeps to this one's right edge. */
  gap: number
  /** Set when it has left the stage: cleared on the next frame. */
  gone: boolean
}

export interface Player {
  /** The top of the runner's box. */
  y: number
  velocity: number
  jumping: boolean
  ducking: boolean
  speedDrop: boolean
  /** The jump has passed `minJumpHeight`: a release may end it now. */
  reachedMinHeight: boolean
  /** The dot's angle around the ring, radians: it rolls with the distance run. */
  roll: number
}

export type GamePhase = 'waiting' | 'running' | 'over'

export interface GameState {
  config: GameConfig
  phase: GamePhase
  /** Ms since the game (this run) started. */
  time: number
  /** Px a frame. */
  speed: number
  /** Px run so far. */
  distance: number
  score: number
  best: number
  night: boolean
  nightTimer: number
  /** The score at which the next night falls. */
  nextNightAt: number
  player: Player
  obstacles: Obstacle[]
  /** The kinds spawned, latest first (the duplication rule reads it). */
  history: ObstacleKind[]
  /** `time` at the crash. */
  overAt: number
  /** The runs since the stage was mounted (the first is 0). */
  runs: number
  /** Ground line's stage `y`: the runner's feet rest here. */
  ground: number
  /** The background's scroll, px, for the parallax the full-motion renderer draws. */
  parallax: number
  /** A frame counter for the frame-local effects (the score's achievement blink). */
  frames: number
}

/** A random number in [0, 1), `Math.random` unless a test hands its own. */
export type Random = () => number

/** Chrome's `getRandomNum`: an integer in [min, max]. */
export function randomInt(random: Random, min: number, max: number): number {
  return Math.floor(random() * (max - min + 1)) + min
}

/** Chrome's mobile speed: scaled by the stage's share of the reference width, never faster. */
export function speedForWidth(speed: number, width: number): number {
  const scaled = (speed * width * MOBILE_SPEED_COEFFICIENT) / MAX_WIDTH
  return Math.min(speed, scaled)
}

/** The ground line for a config: the runner's feet rest here, the cards stand on it. */
export function groundOf(config: GameConfig): number {
  return config.height - config.bottomPad
}

function newPlayer(config: GameConfig): Player {
  return {
    y: groundOf(config) - PLAYER_SIZE,
    velocity: 0,
    jumping: false,
    ducking: false,
    speedDrop: false,
    reachedMinHeight: false,
    roll: 0
  }
}

/** A fresh game, waiting for its first input; `best` is the high score the host restored. */
export function createGame(overrides: Partial<GameConfig> = {}, best = 0): GameState {
  const config: GameConfig = { ...DEFAULT_CONFIG, ...overrides }
  return {
    config,
    phase: 'waiting',
    time: 0,
    speed: speedForWidth(config.speed, config.width),
    distance: 0,
    score: 0,
    best,
    night: false,
    nightTimer: 0,
    nextNightAt: config.nightDistance,
    player: newPlayer(config),
    obstacles: [],
    history: [],
    overAt: 0,
    runs: 0,
    ground: groundOf(config),
    parallax: 0,
    frames: 0
  }
}

/** Starts the waiting game, or restarts a finished one for its next run; a running game is left alone. */
export function start(state: GameState): void {
  if (state.phase === 'running') return
  const { config } = state
  if (state.phase === 'over') state.runs++
  state.phase = 'running'
  state.time = 0
  state.speed = speedForWidth(config.speed, config.width)
  state.distance = 0
  state.score = 0
  state.night = false
  state.nightTimer = 0
  state.nextNightAt = config.nightDistance
  state.player = newPlayer(config)
  state.obstacles = []
  state.history = []
  state.overAt = 0
  state.parallax = 0
  state.frames = 0
}

/** The stage was resized: the ground moves with it and a standing runner keeps its feet on it. */
export function resize(state: GameState, width: number, height: number): void {
  const wasOnGround = !state.player.jumping
  state.config = { ...state.config, width, height }
  state.ground = groundOf(state.config)
  if (wasOnGround) state.player.y = state.ground - playerBox(state.player).height
}

/**
 * The jump input went down. Waiting: the game starts. Running, on the ground: the runner takes
 * off (a duck is released first). Over: nothing – `restartOnJump` decides that on the way up.
 */
export function startJump(state: GameState): void {
  if (state.phase === 'waiting') {
    start(state)
    return
  }
  if (state.phase !== 'running') return
  const { player, config } = state
  if (player.jumping) return
  if (player.ducking) setDuck(state, false)
  player.jumping = true
  player.velocity = config.jumpVelocity
  player.reachedMinHeight = false
  player.speedDrop = false
}

/** The jump input came up: a jump past its minimum height is cut short (Chrome's `endJump`). */
export function endJump(state: GameState): void {
  const { player, config } = state
  if (!player.jumping) return
  if (player.reachedMinHeight && player.velocity < config.dropVelocity)
    player.velocity = config.dropVelocity
}

/** The down input: mid-air it is the speed drop, on the ground the duck. */
export function pressDown(state: GameState): void {
  if (state.phase !== 'running') return
  const { player } = state
  if (player.jumping) {
    if (!player.speedDrop) {
      player.speedDrop = true
      player.velocity = 1
    }
  } else setDuck(state, true)
}

/** The down input released: the runner stands up (a speed drop runs to the ground on its own). */
export function releaseDown(state: GameState): void {
  if (state.player.ducking) setDuck(state, false)
}

function setDuck(state: GameState, ducking: boolean): void {
  const { player } = state
  if (player.ducking === ducking || player.jumping) return
  player.ducking = ducking
  player.y = state.ground - (ducking ? DUCK_HEIGHT : PLAYER_SIZE)
}

/**
 * A jump input after the crash restarts once `gameOverClearTime` has passed (Chrome's rule, so
 * the input that lost is not the one that restarts); true when it did.
 */
export function restartOnJump(state: GameState): boolean {
  if (state.phase !== 'over') return false
  if (state.time - state.overAt < state.config.gameOverClearTime) return false
  start(state)
  return true
}

/** The runner's box in stage coordinates. */
export function playerBox(player: Player): Box {
  return player.ducking
    ? { x: PLAYER_X, y: player.y, width: DUCK_WIDTH, height: DUCK_HEIGHT }
    : { x: PLAYER_X, y: player.y, width: PLAYER_SIZE, height: PLAYER_SIZE }
}

/** Two boxes overlap (edges touching do not). */
export function boxesOverlap(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
}

/** A box inset on every side (Chrome's one-pixel forgiveness on the outer check, `offline.ts:1581-1593`). */
export function inset(box: Box, by: number): Box {
  return { x: box.x + by, y: box.y + by, width: box.width - 2 * by, height: box.height - 2 * by }
}

/**
 * The runner meets an obstacle: the outer boxes first, each a pixel forgiving, then the
 * runner's own boxes against each of the group's members (a group's members are the kind's
 * boxes side by side; the empty corners of a ring or a squashed ring never count).
 */
export function collides(player: Player, obstacle: Obstacle): boolean {
  const outer = playerBox(player)
  if (!boxesOverlap(inset(outer, 1), inset(obstacle, 1))) return false
  const parts = player.ducking ? DUCKING_BOXES : STANDING_BOXES
  const memberWidth = obstacle.width / obstacle.count
  for (let i = 0; i < obstacle.count; i++) {
    const member: Box = inset(
      {
        x: obstacle.x + i * memberWidth,
        y: obstacle.y,
        width: memberWidth,
        height: obstacle.height
      },
      1
    )
    for (const part of parts) {
      const box: Box = {
        x: outer.x + part.x,
        y: outer.y + part.y,
        width: part.width,
        height: part.height
      }
      if (boxesOverlap(box, member)) return true
    }
  }
  return false
}

/** The smallest gap an obstacle keeps to the next at this speed (`obstacle.ts:204-208`). */
export function minGapFor(
  type: ObstacleType,
  width: number,
  speed: number,
  gapCoefficient: number
): number {
  return Math.round(width * speed + type.minGap * gapCoefficient)
}

/** The kind may follow the latest spawns: fewer than `max` of it lead the history (`horizon.ts`). */
export function allowedByHistory(
  history: ReadonlyArray<ObstacleKind>,
  kind: ObstacleKind,
  max: number
): boolean {
  let run = 0
  for (const k of history) {
    if (k !== kind) break
    run++
  }
  return run < max
}

/**
 * The next obstacle at the stage's right edge: a kind the speed allows and the history does not
 * refuse, in a group once the speed passes the kind's `multipleSpeed`, a floating kind at one
 * of its heights with its drift, and the gap the one after it keeps.
 */
export function spawnObstacle(state: GameState, random: Random): Obstacle {
  const { config, speed, history } = state
  const eligible = OBSTACLE_TYPES.filter((t) => speed >= t.minSpeed)
  let type = eligible[randomInt(random, 0, eligible.length - 1)]
  // Chrome draws again while the kind repeats past the cap (`Horizon.addNewObstacle`); the two
  // standing kinds are always eligible, so a third of one kind always has another to turn to.
  for (
    let tries = 0;
    tries < 8 && !allowedByHistory(history, type.kind, config.maxObstacleDuplication);
    tries++
  )
    type = eligible[randomInt(random, 0, eligible.length - 1)]
  const count =
    type.multipleSpeed > 0 && speed > type.multipleSpeed
      ? randomInt(random, 1, MAX_OBSTACLE_LENGTH)
      : 1
  const width = type.width * count
  const y = type.yPositions.length
    ? type.yPositions[randomInt(random, 0, type.yPositions.length - 1)]
    : state.ground - type.height
  const speedOffset = type.speedOffset ? (random() > 0.5 ? type.speedOffset : -type.speedOffset) : 0
  const minGap = minGapFor(type, width, speed, config.gapCoefficient)
  const gap = randomInt(random, minGap, Math.round(minGap * config.maxGapCoefficient))
  history.unshift(type.kind)
  if (history.length > 8) history.length = 8
  return {
    kind: type.kind,
    x: config.width,
    y,
    width,
    height: type.height,
    count,
    speedOffset,
    gap,
    gone: false
  }
}

/** Chrome's five-digit meter: the score padded to five, never wider. */
export function formatScore(score: number): string {
  return String(Math.max(0, Math.min(99999, Math.floor(score)))).padStart(5, '0')
}

/**
 * One frame. `dt` is the elapsed ms (capped at `MAX_FRAME_MS` while running); `random` feeds the
 * spawns. The order is Chrome's `Runner.update`: the clock, the speed, the runner, the
 * obstacles' travel and the spawn at the right edge, the collision, the score and the night. A
 * waiting or finished game only advances its clock, by the whole of `dt` (the game-over clear
 * time reads it, and a finished game's loop is not running).
 */
export function step(state: GameState, dt: number, random: Random = Math.random): void {
  if (state.phase !== 'running') {
    state.time += Math.max(0, dt)
    return
  }
  const elapsed = Math.min(Math.max(0, dt), MAX_FRAME_MS)
  state.time += elapsed
  const frames = elapsed / MS_PER_FRAME
  const { config, player } = state
  state.frames++

  if (state.speed < config.maxSpeed)
    state.speed = Math.min(config.maxSpeed, state.speed + config.acceleration * frames)

  if (player.jumping) {
    const rate = player.speedDrop ? config.speedDropCoefficient : 1
    player.y += Math.round(player.velocity * rate * frames)
    player.velocity += config.gravity * frames
    const floor = state.ground - PLAYER_SIZE
    if (floor - player.y >= config.minJumpHeight || player.speedDrop) player.reachedMinHeight = true
    if (player.y >= floor) {
      player.y = floor
      player.velocity = 0
      player.jumping = false
      player.speedDrop = false
      player.reachedMinHeight = false
    }
  }

  const travel = state.speed * frames
  state.distance += travel
  state.parallax += travel
  player.roll += travel / (PLAYER_SIZE / 2)

  for (const o of state.obstacles) {
    o.x -= Math.floor((state.speed + o.speedOffset) * frames)
    if (o.x + o.width < 0) o.gone = true
  }
  if (state.obstacles.length && state.obstacles[0].gone) state.obstacles.shift()

  if (state.time >= config.clearTime) {
    const last = state.obstacles[state.obstacles.length - 1]
    if (!last || last.x + last.width + last.gap < config.width)
      state.obstacles.push(spawnObstacle(state, random))
  }

  for (const o of state.obstacles) {
    if (collides(player, o)) {
      gameOver(state)
      return
    }
  }

  state.score = Math.round(state.distance * config.scoreCoefficient)
  if (state.score > state.best) state.best = state.score

  if (state.night) {
    state.nightTimer += elapsed
    if (state.nightTimer >= config.nightDuration) {
      state.night = false
      state.nightTimer = 0
    }
  }
  if (state.score >= state.nextNightAt) {
    state.night = true
    state.nightTimer = 0
    state.nextNightAt += config.nightDistance
  }
}

function gameOver(state: GameState): void {
  state.phase = 'over'
  state.overAt = state.time
  state.score = Math.round(state.distance * state.config.scoreCoefficient)
  if (state.score > state.best) state.best = state.score
}

/** How the page tells the user to begin, by the device it sees (Chrome's `neterror.ts:243-267`). */
export type StartHintDevice = 'keyboard' | 'hybrid' | 'touch'

export function startHintDevice(maxTouchPoints: number, hover: boolean): StartHintDevice {
  if (maxTouchPoints === 0) return 'keyboard'
  return hover ? 'hybrid' : 'touch'
}

export const START_HINTS: Readonly<Record<StartHintDevice, string>> = {
  keyboard: 'Press Space to start',
  hybrid: 'Tap or press Space to start',
  touch: 'Tap to start'
}

/** The key under which the page keeps the high score where its storage lets it. */
export const HIGH_SCORE_KEY = 'zenium.game.highScore'

/** A stored high score read back: a whole number in range, else 0. */
export function parseHighScore(value: string | null | undefined): number {
  if (!value) return 0
  const n = Number(value)
  return Number.isInteger(n) && n >= 0 && n <= 99999 ? n : 0
}
