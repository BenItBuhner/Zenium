import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PRIVATE_WORLD_DEADLINE_MS, PrivateWorldRelay, type RelayFrame } from '../privateWorld'
import {
  EMBEDDER_WORLD_ID_MAX,
  EMBEDDER_WORLD_ID_MIN,
  IMAGE_THUMBNAIL_WORLD_ID,
  PRIVATE_WORLD_CHANNELS
} from '../../../shared/privateWorld'
import { FIRST_USER_SCRIPT_WORLD_ID } from '../../../preload/userScripts'

interface FakeFrame extends RelayFrame {
  sent: Array<{ channel: string; payload: unknown }>
  gone: boolean
}

function frame(processId: number, routingId: number, detached = false): FakeFrame {
  const f: FakeFrame = {
    processId,
    routingId,
    detached,
    gone: false,
    sent: [],
    isDestroyed: () => f.gone,
    send: (channel: string, payload: unknown) => {
      if (f.gone) throw new Error('Render frame was disposed before WebFrameMain could be accessed')
      f.sent.push({ channel, payload })
    }
  }
  return f
}

describe('the browser’s private world (CT-32, the world the thumbnail runs in)', () => {
  it('has an id Electron accepts, above every world anything else allots: the extensions’ (from 1), Electron’s preload (999), the user scripts’ (from 100 000), Electron’s retired extension band (1 << 20)', () => {
    expect(IMAGE_THUMBNAIL_WORLD_ID).toBe(268_435_456)
    expect(IMAGE_THUMBNAIL_WORLD_ID).toBe(1 << 28)
    expect(EMBEDDER_WORLD_ID_MIN).toBe(1)
    expect(EMBEDDER_WORLD_ID_MAX).toBe(536_870_911)
    expect(IMAGE_THUMBNAIL_WORLD_ID).toBeGreaterThanOrEqual(EMBEDDER_WORLD_ID_MIN)
    expect(IMAGE_THUMBNAIL_WORLD_ID).toBeLessThanOrEqual(EMBEDDER_WORLD_ID_MAX)
    expect(IMAGE_THUMBNAIL_WORLD_ID).not.toBe(0)
    expect(IMAGE_THUMBNAIL_WORLD_ID).not.toBe(999)
    expect(IMAGE_THUMBNAIL_WORLD_ID).toBeGreaterThan(1 << 20)
    // The user-script worlds count up from their first id; ten thousand extensions with
    // sixteen worlds each would still sit far below.
    expect(IMAGE_THUMBNAIL_WORLD_ID).toBeGreaterThan(FIRST_USER_SCRIPT_WORLD_ID + 160_000)
  })

  describe('the sub-frame relay', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })
    afterEach(() => {
      vi.useRealTimers()
    })

    it('sends the execution down the frame under a token, in the thumbnail world, and resolves with the frame’s answer', async () => {
      const relay = new PrivateWorldRelay()
      const f = frame(3, 7)
      const done = relay.execute(f, '(async () => 1)()')
      expect(f.sent).toEqual([
        {
          channel: PRIVATE_WORLD_CHANNELS.execute,
          payload: { token: 1, worldId: IMAGE_THUMBNAIL_WORLD_ID, code: '(async () => 1)()' }
        }
      ])
      expect(relay.pendingCount).toBe(1)
      relay.answer(f, { token: 1, result: { ok: true } })
      await expect(done).resolves.toEqual({ ok: true })
      expect(relay.pendingCount).toBe(0)
    })

    it('rejects with the frame’s error when the script threw', async () => {
      const relay = new PrivateWorldRelay()
      const f = frame(3, 7)
      const done = relay.execute(f, 'throw 1')
      relay.answer(f, { token: 1, error: 'Script failed to execute' })
      await expect(done).rejects.toThrow('Script failed to execute')
    })

    it('takes the answer from the frame it asked alone: another frame’s answer, an unknown token or a malformed answer changes nothing', async () => {
      const relay = new PrivateWorldRelay()
      const asked = frame(3, 7)
      const other = frame(3, 8)
      const done = relay.execute(asked, 'x')
      relay.answer(other, { token: 1, result: 'stolen' })
      relay.answer(asked, { token: 2, result: 'stray' })
      relay.answer(asked, { token: '1', result: 'string token' })
      relay.answer(asked, { token: 1, error: 5 })
      relay.answer(null, { token: 1, result: 'no frame' })
      relay.answer(asked, 'garbage')
      expect(relay.pendingCount).toBe(1)
      relay.answer(asked, { token: 1, result: 'right' })
      await expect(done).resolves.toBe('right')
    })

    it('numbers executions apart and answers each by its own token', async () => {
      const relay = new PrivateWorldRelay()
      const f = frame(3, 7)
      const first = relay.execute(f, 'a')
      const second = relay.execute(f, 'b')
      expect(f.sent.map((s) => (s.payload as { token: number }).token)).toEqual([1, 2])
      relay.answer(f, { token: 2, result: 'B' })
      relay.answer(f, { token: 1, result: 'A' })
      await expect(first).resolves.toBe('A')
      await expect(second).resolves.toBe('B')
    })

    it('rejects for a frame that is gone or detached, sending nothing', async () => {
      const relay = new PrivateWorldRelay()
      const gone = frame(3, 7)
      gone.gone = true
      await expect(relay.execute(gone, 'x')).rejects.toThrow('no longer part of the page')
      const detached = frame(3, 8, true)
      await expect(relay.execute(detached, 'x')).rejects.toThrow('no longer part of the page')
      expect(gone.sent).toEqual([])
      expect(detached.sent).toEqual([])
      expect(relay.pendingCount).toBe(0)
    })

    it('rejects when the frame cannot be reached (send threw), leaving nothing pending', async () => {
      const relay = new PrivateWorldRelay()
      const f = frame(3, 7)
      f.isDestroyed = () => false
      f.send = () => {
        throw new Error('Render frame was disposed')
      }
      await expect(relay.execute(f, 'x')).rejects.toThrow('Render frame was disposed')
      expect(relay.pendingCount).toBe(0)
    })

    it('gives a frame up after the deadline (a frame that navigated away answers never), and a late answer changes nothing', async () => {
      const relay = new PrivateWorldRelay(5_000)
      const f = frame(3, 7)
      const done = relay.execute(f, 'x')
      const outcome = done.then(
        () => 'resolved',
        (error: Error) => error.message
      )
      vi.advanceTimersByTime(4_999)
      expect(relay.pendingCount).toBe(1)
      vi.advanceTimersByTime(1)
      await expect(outcome).resolves.toBe('The frame did not answer within 5000 ms')
      expect(relay.pendingCount).toBe(0)
      relay.answer(f, { token: 1, result: 'late' })
      expect(relay.pendingCount).toBe(0)
    })

    it('waits fifteen seconds by default: the menu’s command waits on it, and the honest long case is bounded by the cap', () => {
      expect(PRIVATE_WORLD_DEADLINE_MS).toBe(15_000)
    })
  })
})
