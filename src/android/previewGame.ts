/**
 * The preview host's stand-in for Roll's inline runtime (`shared/game/inlineRuntime.ts`): on a
 * device the no-connection page and `zen://game` carry the runtime inline and it mounts the
 * game's fragment; here `preview.ts` swaps that tag for this module (`view.loadHtml`), which
 * mounts what the inline script would – the same `mountGame`, the same pixels.
 *
 * A pose asked for (`&game=<scene>`, `PREVIEW_GAME_SCENES`; `preview.ts` writes it on this
 * module's script tag) is reached on a clock of this driver's own: the runtime's frames run only
 * as the driver pumps them, so the game stands at the pose's frame for the still, and the same
 * seeded draw gives the same cards every time. The best score is answered here, as the core
 * would through the page script's relay (`shared/game/bridge.ts`): this host's frames run no
 * page script, and a still of a returning player reads better than one of a first run.
 */
import { GAME_MOUNT_ATTRIBUTE } from '../shared/game/page'
import { MS_PER_FRAME, PLAYER_SIZE, PLAYER_X } from '../shared/game/logic'
import { mountGame, mountGames, type BestScoreHost, type GameHandle } from '../shared/game/runtime'

/** The frames a pose may take before the driver gives up on it (a minute of play). */
const MAX_POSE_FRAMES = 3600
/** How far a card may stand ahead of the runner when the `running` pose takes its jump. */
const JUMP_AHEAD_PX = 72
/** Frames into the jump the `running` pose shows: the runner near the top of its arc. */
const JUMP_SHOWN_FRAMES = 14
/** The profile's best the stand-in host answers with (§9.17's own example, `Best 00123`). */
const PREVIEW_BEST = 123

/** The runtime's clock and the frames it has asked for, pumped by hand. */
interface Clock {
  time: number
  queue: Array<(time: number) => void>
}

/** A seeded draw (a linear congruential generator): the same cards for the same pose every run. */
function seededRandom(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 0x100000000
  }
}

/** The core's side of the bridge, answered at once: the profile's best, and a report kept. */
const previewBest: BestScoreHost = {
  read(onBest) {
    onBest(PREVIEW_BEST)
    return () => {}
  },
  write: () => undefined
}

function press(code: string): void {
  document.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true, cancelable: true }))
}

/** Runs the runtime's next frames, at most `frames` of them, and how many ran. */
function pump(clock: Clock, frames: number): number {
  let ran = 0
  while (ran < frames && clock.queue.length > 0) {
    const callback = clock.queue.shift()!
    clock.time += MS_PER_FRAME
    callback(clock.time)
    ran++
  }
  return ran
}

/** Pumps until `done` holds, or MAX_POSE_FRAMES have run. */
function pumpUntil(clock: Clock, done: () => boolean): void {
  for (let i = 0; i < MAX_POSE_FRAMES && !done(); i++) if (pump(clock, 1) === 0) return
}

function pose(root: HTMLElement, scene: string): void {
  const clock: Clock = { time: 1000, queue: [] }
  const handle: GameHandle | null = mountGame(root, {
    now: () => clock.time,
    requestFrame: (callback) => {
      clock.queue.push(callback)
      return clock.queue.length
    },
    cancelFrame: () => {},
    random: seededRandom(7),
    best: previewBest
  })
  if (!handle) return
  const { state } = handle
  press('Space')
  switch (scene) {
    case 'over':
      // The runner meets the first card with no jump: the game-over card, the score it made
      // against the best it did not reach.
      pumpUntil(clock, () => state.phase === 'over')
      return
    case 'night':
      // A few seconds in, then the meter is brought to the first night's score: the next frame
      // flips the stage's theme, as 700 points do on a device – the page around it stays.
      pump(clock, 200)
      state.distance = state.nextNightAt / state.config.scoreCoefficient
      pump(clock, 1)
      return
    case 'running':
    default:
      // The first card close ahead, the jump taken, and the frame near the top of the arc.
      pumpUntil(clock, () => {
        const first = state.obstacles[0]
        return first !== undefined && first.x - (PLAYER_X + PLAYER_SIZE) < JUMP_AHEAD_PX
      })
      press('Space')
      pump(clock, JUMP_SHOWN_FRAMES)
  }
}

const script = document.querySelector<HTMLScriptElement>('script[data-zen-game-scene]')
const scene = script?.dataset.zenGameScene
const root = document.querySelector<HTMLElement>(`[${GAME_MOUNT_ATTRIBUTE}]`)
if (scene && root) pose(root, scene)
else mountGames(document, { best: previewBest })
