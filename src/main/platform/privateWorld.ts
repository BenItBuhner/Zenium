import type { WebFrameMain } from 'electron'
import {
  IMAGE_THUMBNAIL_WORLD_ID,
  PRIVATE_WORLD_CHANNELS,
  readPrivateWorldAnswer
} from '../../shared/privateWorld'

/**
 * How long a frame has to answer an execution before the host gives it up and the row falls
 * back to the address form. A frame that navigated away answers never, and the menu's command
 * waits on this; the long honest case – a fetch of a big image over a slow network – is bounded
 * by the cap and the page's own network, and fifteen seconds is what a user waits on a menu row.
 */
export const PRIVATE_WORLD_DEADLINE_MS = 15_000

/** What the relay needs of a frame: Electron's `WebFrameMain`, or a test's stand-in. */
export type RelayFrame = Pick<
  WebFrameMain,
  'processId' | 'routingId' | 'detached' | 'isDestroyed' | 'send'
>

interface Pending {
  frameKey: string
  resolve(value: unknown): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
}

/**
 * The host's side of `shared/privateWorld.ts`: runs a script in a sub-frame's private world
 * through the frame's own preload (`WebFrameMain.send` down, `PRIVATE_WORLD_CHANNELS.answer`
 * back under a token), the way `webContents.executeJavaScriptInIsolatedWorld` reaches the top
 * frame – which is the only frame Electron 44 reaches that way. An answer is taken from the
 * frame it was asked of alone (its process and routing ids); a frame gone, one that never
 * answers within the deadline, or one whose script threw rejects.
 */
export class PrivateWorldRelay {
  private tokens = 0
  private readonly pending = new Map<number, Pending>()

  constructor(private readonly deadlineMs: number = PRIVATE_WORLD_DEADLINE_MS) {}

  /** Run `code` in the frame's `IMAGE_THUMBNAIL_WORLD_ID` – the one world the preload serves. */
  execute(frame: RelayFrame, code: string): Promise<unknown> {
    if (frame.isDestroyed() || frame.detached)
      return Promise.reject(new Error('The frame is no longer part of the page'))
    const token = ++this.tokens
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(token)
        reject(new Error(`The frame did not answer within ${this.deadlineMs} ms`))
      }, this.deadlineMs)
      this.pending.set(token, { frameKey: frameKey(frame), resolve, reject, timer })
      try {
        frame.send(PRIVATE_WORLD_CHANNELS.execute, {
          token,
          worldId: IMAGE_THUMBNAIL_WORLD_ID,
          code
        })
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(token)
        reject(error instanceof Error ? error : new Error('The frame could not be reached'))
      }
    })
  }

  /** `PRIVATE_WORLD_CHANNELS.answer` from a page frame. */
  answer(frame: RelayFrame | null | undefined, raw: unknown): void {
    const answer = readPrivateWorldAnswer(raw)
    if (!frame || !answer) return
    const pending = this.pending.get(answer.token)
    if (!pending || pending.frameKey !== frameKey(frame)) return
    clearTimeout(pending.timer)
    this.pending.delete(answer.token)
    if (answer.error !== undefined) pending.reject(new Error(answer.error))
    else pending.resolve(answer.result)
  }

  /** Executions still waiting on a frame (tests). */
  get pendingCount(): number {
    return this.pending.size
  }
}

function frameKey(frame: RelayFrame): string {
  return `${frame.processId}:${frame.routingId}`
}
