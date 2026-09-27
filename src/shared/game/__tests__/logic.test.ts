import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CONFIG,
  DUCK_HEIGHT,
  DUCK_WIDTH,
  MAX_FRAME_MS,
  MAX_WIDTH,
  MS_PER_FRAME,
  OBSTACLE_TYPES,
  PLAYER_SIZE,
  PLAYER_X,
  START_HINTS,
  allowedByHistory,
  collides,
  createGame,
  endJump,
  formatScore,
  minGapFor,
  playerBox,
  pressDown,
  releaseDown,
  resize,
  restartOnJump,
  spawnObstacle,
  speedForWidth,
  start,
  startHintDevice,
  startJump,
  step,
  takeBest,
  type GameState,
  type Obstacle,
  type Random
} from '../logic'

/** A random source answering the given values in turn, then the last one again. */
function sequence(...values: number[]): Random {
  let i = 0
  return () => values[Math.min(i++, values.length - 1)]
}

/** Steps `ms` of play in 60 Hz frames. */
function run(state: GameState, ms: number, random: Random = () => 0.5): void {
  for (let t = 0; t < ms; t += MS_PER_FRAME) step(state, MS_PER_FRAME, random)
}

/** A running game whose obstacles never come (the clear time is pushed out of reach). */
function running(overrides = {}): GameState {
  const state = createGame({ clearTime: 1e9, ...overrides })
  start(state)
  return state
}

function card(x: number, kind: 'card-small' | 'card-tall' = 'card-small', count = 1): Obstacle {
  const type = OBSTACLE_TYPES.find((t) => t.kind === kind)!
  const ground = DEFAULT_CONFIG.height - DEFAULT_CONFIG.bottomPad
  return {
    kind,
    x,
    y: ground - type.height,
    width: type.width * count,
    height: type.height,
    count,
    speedOffset: 0,
    gap: 200,
    gone: false
  }
}

function note(x: number, y: number): Obstacle {
  const type = OBSTACLE_TYPES.find((t) => t.kind === 'note')!
  return {
    kind: 'note',
    x,
    y,
    width: type.width,
    height: type.height,
    count: 1,
    speedOffset: 0,
    gap: 200,
    gone: false
  }
}

describe('the stage', () => {
  it('waits for its first input on the ground line, twelve up from the bottom', () => {
    const state = createGame()
    expect(state.phase).toBe('waiting')
    expect(state.ground).toBe(138)
    expect(playerBox(state.player)).toEqual({
      x: PLAYER_X,
      y: 138 - PLAYER_SIZE,
      width: PLAYER_SIZE,
      height: PLAYER_SIZE
    })
  })

  it("scales the start speed down on a narrower stage and never up (Chrome's mobile rule)", () => {
    expect(speedForWidth(6, MAX_WIDTH)).toBe(6)
    expect(speedForWidth(6, 360)).toBeCloseTo(4.32)
    expect(speedForWidth(6, 900)).toBe(6)
    expect(createGame({ width: 360 }).speed).toBeCloseTo(4.32)
  })

  it('keeps a standing runner on the ground through a resize', () => {
    const state = createGame()
    resize(state, 320, 150)
    expect(state.config.width).toBe(320)
    expect(state.player.y).toBe(138 - PLAYER_SIZE)
    resize(state, 320, 200)
    expect(state.ground).toBe(188)
    expect(state.player.y).toBe(188 - PLAYER_SIZE)
  })

  it('only advances its clock while waiting or over', () => {
    const state = createGame()
    run(state, 1000)
    expect(state.time).toBeGreaterThan(990)
    expect(state.distance).toBe(0)
    expect(state.obstacles).toEqual([])
  })

  it('caps a frame at 64 ms so a tab that slept does not resume into a wall', () => {
    const state = running()
    step(state, 5000)
    expect(state.time).toBe(MAX_FRAME_MS)
    expect(state.distance).toBeCloseTo(state.speed * (MAX_FRAME_MS / MS_PER_FRAME))
  })
})

describe('the runner', () => {
  it('starts the waiting game on the jump input without jumping', () => {
    const state = createGame()
    startJump(state)
    expect(state.phase).toBe('running')
    expect(state.player.jumping).toBe(false)
  })

  it('takes off, rises past the minimum height and lands back on the ground', () => {
    const state = running()
    startJump(state)
    expect(state.player.jumping).toBe(true)
    let apex = state.player.y
    let landedAt = -1
    for (let frame = 0; frame < 120; frame++) {
      step(state, MS_PER_FRAME)
      apex = Math.min(apex, state.player.y)
      if (!state.player.jumping) {
        landedAt = frame
        break
      }
    }
    const floor = state.ground - PLAYER_SIZE
    expect(floor - apex).toBeGreaterThanOrEqual(DEFAULT_CONFIG.minJumpHeight)
    expect(floor - apex).toBeLessThan(100)
    expect(landedAt).toBeGreaterThan(10)
    expect(state.player.y).toBe(floor)
    expect(state.player.velocity).toBe(0)
  })

  it('cuts a jump short when the input is released after the minimum height', () => {
    const apexOf = (release: boolean): number => {
      const state = running()
      startJump(state)
      let apex = state.player.y
      for (let frame = 0; frame < 120 && state.player.jumping; frame++) {
        step(state, MS_PER_FRAME)
        if (release && state.player.reachedMinHeight) endJump(state)
        apex = Math.min(apex, state.player.y)
      }
      return state.ground - PLAYER_SIZE - apex
    }
    const held = apexOf(false)
    const released = apexOf(true)
    expect(released).toBeGreaterThanOrEqual(DEFAULT_CONFIG.minJumpHeight)
    expect(released).toBeLessThan(held)
  })

  it('ignores a release before the minimum height', () => {
    const state = running()
    startJump(state)
    step(state, MS_PER_FRAME)
    const before = state.player.velocity
    endJump(state)
    expect(state.player.velocity).toBe(before)
  })

  it('drops fast when down is pressed mid-air, and lands sooner than a plain jump', () => {
    const landing = (drop: boolean): number => {
      const state = running()
      startJump(state)
      for (let frame = 0; frame < 200; frame++) {
        step(state, MS_PER_FRAME)
        if (drop && frame === 8) pressDown(state)
        if (!state.player.jumping) return frame
      }
      return Infinity
    }
    expect(landing(true)).toBeLessThan(landing(false))
    const state = running()
    startJump(state)
    step(state, MS_PER_FRAME)
    pressDown(state)
    expect(state.player.speedDrop).toBe(true)
    expect(state.player.ducking).toBe(false)
  })

  it('ducks on the ground into the low box and stands up on release', () => {
    const state = running()
    pressDown(state)
    expect(state.player.ducking).toBe(true)
    expect(playerBox(state.player)).toEqual({
      x: PLAYER_X,
      y: 138 - DUCK_HEIGHT,
      width: DUCK_WIDTH,
      height: DUCK_HEIGHT
    })
    releaseDown(state)
    expect(state.player.ducking).toBe(false)
    expect(state.player.y).toBe(138 - PLAYER_SIZE)
  })

  it('stands up to jump out of a duck', () => {
    const state = running()
    pressDown(state)
    startJump(state)
    expect(state.player.ducking).toBe(false)
    expect(state.player.jumping).toBe(true)
  })

  it('does nothing mid-air on a second jump input', () => {
    const state = running()
    startJump(state)
    step(state, MS_PER_FRAME)
    const velocity = state.player.velocity
    startJump(state)
    expect(state.player.velocity).toBe(velocity)
  })

  it('rolls the dot with the distance run', () => {
    const state = running()
    run(state, 500)
    expect(state.player.roll).toBeGreaterThan(0)
    expect(state.player.roll).toBeCloseTo(state.distance / (PLAYER_SIZE / 2))
  })
})

describe('the ramp', () => {
  it('adds a thousandth a frame from 6 towards 13 and stops there', () => {
    const state = running()
    run(state, 1000)
    expect(state.speed).toBeCloseTo(6 + 0.001 * 60, 1)
    run(state, 200_000)
    expect(state.speed).toBe(13)
  })

  it('scales the ramp by the frame, so a stalled frame is not a slower one', () => {
    const a = running()
    const b = running()
    step(a, MS_PER_FRAME)
    step(a, MS_PER_FRAME)
    step(b, 2 * MS_PER_FRAME)
    expect(a.speed).toBeCloseTo(b.speed)
    expect(a.distance).toBeCloseTo(b.distance)
  })
})

describe('the obstacles', () => {
  it('lets the runner alone for the clear time and then spawns at the right edge', () => {
    const state = createGame()
    start(state)
    run(state, DEFAULT_CONFIG.clearTime - MS_PER_FRAME)
    expect(state.obstacles).toEqual([])
    run(state, 2 * MS_PER_FRAME)
    expect(state.obstacles).toHaveLength(1)
    expect(state.obstacles[0].x).toBeLessThanOrEqual(MAX_WIDTH)
    expect(state.obstacles[0].x).toBeGreaterThan(MAX_WIDTH - 40)
  })

  it("keeps Chrome's gap: width × speed + the kind's gap × 0.6, up to 1.5 of it", () => {
    const small = OBSTACLE_TYPES[0]
    expect(minGapFor(small, 20, 6, 0.6)).toBe(Math.round(20 * 6 + 120 * 0.6))
    const state = running()
    const min = minGapFor(small, small.width, state.speed, DEFAULT_CONFIG.gapCoefficient)
    // The draws in order: the kind (the first), the group size (one), then the gap.
    const at = (r: number): Obstacle => spawnObstacle({ ...state, history: [] }, sequence(0, 0, r))
    expect(at(0).gap).toBe(min)
    expect(at(0.999).gap).toBe(Math.round(min * 1.5))
  })

  it('stands a card on the ground and floats a note at one of its three heights', () => {
    const state = running()
    const standing = spawnObstacle(state, () => 0)
    expect(standing.kind).toBe('card-small')
    expect(standing.y + standing.height).toBe(state.ground)
    const fast = running()
    fast.speed = 9
    // The last of three eligible kinds is the note; its first height is the low one.
    const floating = spawnObstacle(fast, () => 0.7)
    expect(floating.kind).toBe('note')
    expect(OBSTACLE_TYPES[2].yPositions).toContain(floating.y)
    expect(Math.abs(floating.speedOffset)).toBe(0.8)
  })

  it('holds the note back until the speed reaches 8.5', () => {
    const state = running()
    for (let i = 0; i < 40; i++) {
      state.history = []
      expect(spawnObstacle(state, () => 0.99).kind).not.toBe('note')
    }
  })

  it("groups a kind from its multiple speed on, up to three (Chrome's MAX_OBSTACLE_LENGTH; `obstacle.ts` cuts the size to one while multipleSpeed > speed)", () => {
    // Small cards group from 4: one below it, a group at 4 itself (`>=`, Chrome's letter).
    const slow = running()
    slow.speed = 3.999
    expect(spawnObstacle(slow, sequence(0, 0.999)).count).toBe(1)
    const at = running()
    at.speed = 4
    const group = spawnObstacle(at, sequence(0, 0.999))
    expect(group.kind).toBe('card-small')
    expect(group.count).toBe(3)
    const fast = running()
    fast.speed = 5
    const tall = spawnObstacle(fast, () => 0.999)
    expect(tall.kind).toBe('card-tall')
    // Tall cards group from 7: still one.
    expect(tall.count).toBe(1)
    fast.speed = 7
    fast.history = []
    const grouped = spawnObstacle(fast, () => 0.999)
    expect(grouped.count).toBe(3)
    expect(grouped.width).toBe(OBSTACLE_TYPES[1].width * 3)
  })

  it('never lets a kind follow itself more than twice', () => {
    expect(allowedByHistory([], 'note', 2)).toBe(true)
    expect(allowedByHistory(['note'], 'note', 2)).toBe(true)
    expect(allowedByHistory(['note', 'note'], 'note', 2)).toBe(false)
    expect(allowedByHistory(['card-small', 'note', 'note'], 'note', 2)).toBe(true)
    const state = running()
    // A source that always names the first kind: the third draw is turned to the other kind.
    let calls = 0
    const random: Random = () => (calls++ % 2 === 0 ? 0 : 0.999)
    const kinds = [spawnObstacle(state, () => 0), spawnObstacle(state, () => 0)].map((o) => o.kind)
    expect(kinds).toEqual(['card-small', 'card-small'])
    const third = spawnObstacle(state, random)
    expect(third.kind).not.toBe('card-small')
    expect(state.history.slice(0, 3)).toEqual([third.kind, 'card-small', 'card-small'])
  })

  it('carries them left at the speed and drops the ones that have left the stage', () => {
    const state = running()
    state.obstacles.push(card(100))
    step(state, MS_PER_FRAME)
    expect(state.obstacles[0].x).toBe(100 - Math.floor(state.speed))
    state.obstacles[0].x = -state.obstacles[0].width + 1
    step(state, MS_PER_FRAME)
    expect(state.obstacles).toEqual([])
  })
})

describe('the collision', () => {
  it('meets a card the standing runner runs into, and not one a pixel away', () => {
    const state = running()
    expect(collides(state.player, card(PLAYER_X + 10))).toBe(true)
    expect(collides(state.player, card(PLAYER_X + PLAYER_SIZE))).toBe(false)
    expect(collides(state.player, card(PLAYER_X + PLAYER_SIZE - 1))).toBe(false)
    expect(collides(state.player, card(PLAYER_X + PLAYER_SIZE - 4))).toBe(true)
  })

  it("forgives the ring's empty corner", () => {
    const state = running()
    // A card whose top-left corner alone would meet the box's bottom-right corner.
    const type = OBSTACLE_TYPES[0]
    const corner: Obstacle = {
      ...card(PLAYER_X + PLAYER_SIZE - 3),
      y: state.ground - 3,
      height: type.height
    }
    expect(collides(state.player, corner)).toBe(false)
  })

  it('lets a duck slip under the middle note and stops a standing runner there', () => {
    const state = running()
    const middle = note(PLAYER_X, OBSTACLE_TYPES[2].yPositions[1])
    expect(collides(state.player, middle)).toBe(true)
    pressDown(state)
    expect(collides(state.player, middle)).toBe(false)
  })

  it('makes the low note a jump and the high one a pass', () => {
    const state = running()
    const [low, , high] = OBSTACLE_TYPES[2].yPositions
    expect(collides(state.player, note(PLAYER_X, low))).toBe(true)
    pressDown(state)
    expect(collides(state.player, note(PLAYER_X, low))).toBe(true)
    releaseDown(state)
    expect(collides(state.player, note(PLAYER_X, high))).toBe(false)
  })

  it('checks each member of a group', () => {
    const state = running()
    const group = card(PLAYER_X + PLAYER_SIZE + 5, 'card-small', 3)
    expect(collides(state.player, group)).toBe(false)
    group.x = PLAYER_X + 5 - 20
    expect(collides(state.player, group)).toBe(true)
  })

  it('ends the run on the frame the runner meets a card', () => {
    const state = running()
    state.obstacles.push(card(PLAYER_X + PLAYER_SIZE + 2))
    step(state, MS_PER_FRAME)
    expect(state.phase).toBe('over')
    expect(state.overAt).toBe(state.time)
  })
})

describe('the score', () => {
  it("is the distance × 0.025; the best stands at the previous runs' until the crash (Chrome's way)", () => {
    const state = running()
    run(state, 4000)
    expect(state.score).toBe(Math.round(state.distance * 0.025))
    expect(state.score).toBeGreaterThan(0)
    expect(state.best).toBe(0)
    state.obstacles.push(card(PLAYER_X))
    step(state, MS_PER_FRAME)
    expect(state.phase).toBe('over')
    expect(state.best).toBe(state.score)
  })

  it('keeps the best across runs, and a lower run leaves it', () => {
    const state = createGame({}, 500)
    start(state)
    run(state, 2000)
    expect(state.best).toBe(500)
    expect(state.score).toBeLessThan(500)
    state.obstacles.push(card(PLAYER_X))
    step(state, MS_PER_FRAME)
    expect(state.phase).toBe('over')
    expect(state.best).toBe(500)
    start(state)
    expect(state.best).toBe(500)
    expect(state.score).toBe(0)
    expect(state.runs).toBe(1)
  })

  it("takes the host's best when it is higher, never lower, whole and within five digits", () => {
    const state = createGame({}, 500)
    expect(takeBest(state, 400)).toBe(false)
    expect(state.best).toBe(500)
    expect(takeBest(state, 500)).toBe(false)
    expect(takeBest(state, 620.9)).toBe(true)
    expect(state.best).toBe(620)
    expect(takeBest(state, Number.NaN)).toBe(false)
    expect(takeBest(state, Infinity)).toBe(false)
    expect(takeBest(state, 1e9)).toBe(true)
    expect(state.best).toBe(99999)
    // A run in progress keeps the best it has to beat, raised under it.
    const live = running()
    run(live, 4000)
    expect(takeBest(live, 3)).toBe(true)
    expect(live.best).toBe(3)
    expect(live.score).toBeGreaterThan(3)
    live.obstacles.push(card(PLAYER_X))
    step(live, MS_PER_FRAME)
    expect(live.best).toBe(live.score)
  })

  it("pads to Chrome's five digits", () => {
    expect(formatScore(0)).toBe('00000')
    expect(formatScore(42)).toBe('00042')
    expect(formatScore(123456)).toBe('99999')
    expect(formatScore(7.9)).toBe('00007')
  })
})

describe('the night', () => {
  it('falls at 700 and every 700 after, and lifts after twelve seconds', () => {
    const state = running()
    state.distance = 700 / 0.025 - state.speed
    step(state, MS_PER_FRAME)
    expect(state.score).toBeGreaterThanOrEqual(700)
    expect(state.night).toBe(true)
    expect(state.nextNightAt).toBe(1400)
    run(state, 11_900)
    expect(state.night).toBe(true)
    run(state, 200)
    expect(state.night).toBe(false)
  })

  it('does not fall in the first 700', () => {
    const state = running()
    run(state, 20_000)
    expect(state.score).toBeLessThan(700)
    expect(state.night).toBe(false)
  })

  it('lifts with a new run', () => {
    const state = running()
    state.night = true
    state.obstacles.push(card(PLAYER_X))
    step(state, MS_PER_FRAME)
    start(state)
    expect(state.night).toBe(false)
  })
})

describe('the game over', () => {
  it('restarts on a jump input only after the clear time', () => {
    const state = running()
    state.obstacles.push(card(PLAYER_X))
    step(state, MS_PER_FRAME)
    expect(state.phase).toBe('over')
    expect(restartOnJump(state)).toBe(false)
    run(state, 1000)
    expect(restartOnJump(state)).toBe(false)
    run(state, 250)
    expect(restartOnJump(state)).toBe(true)
    expect(state.phase).toBe('running')
    expect(state.time).toBe(0)
    expect(state.obstacles).toEqual([])
  })

  it('is not restarted by the jump input itself, nor by a running game', () => {
    const state = running()
    startJump(state)
    expect(state.phase).toBe('running')
    expect(restartOnJump(state)).toBe(false)
  })
})

describe('the words', () => {
  it("picks the start hint by the device, Chrome's way", () => {
    expect(startHintDevice(0, true)).toBe('keyboard')
    expect(startHintDevice(5, true)).toBe('hybrid')
    expect(startHintDevice(5, false)).toBe('touch')
    expect(START_HINTS.keyboard).toBe('Press Space to start')
    expect(START_HINTS.touch).toBe('Tap to start')
  })
})
