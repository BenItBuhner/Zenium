import { describe, expect, it } from 'vitest'
import { FULLSCREEN_EXIT_HINT, TOAST_SHOW_MS, type PageHint } from '@shared/fullscreenHint'
import { fullscreenHintDue, onFullscreenVideo, type FullscreenHintIo } from '../fullscreenHint'

/*
 * GN-20: the first time a video goes fullscreen the phone shows how to leave, once ever, keyed
 * in settings as the gesture hint (FRE-07) is.
 */

function io(
  done: boolean,
  dark = false
): FullscreenHintIo & { posted: PageHint[]; marked: number } {
  const state = { fullscreenHintDone: done }
  const rec = {
    posted: [] as PageHint[],
    marked: 0,
    settings: () => state,
    dark: () => dark,
    markShown: () => {
      rec.marked++
      state.fullscreenHintDone = true
    },
    post: (hint: PageHint) => {
      rec.posted.push(hint)
    }
  }
  return rec
}

describe('the first-time fullscreen exit hint (GN-20)', () => {
  it('is owed until it has had its showing', () => {
    expect(fullscreenHintDue({ fullscreenHintDone: false })).toBe(true)
    expect(fullscreenHintDue({ fullscreenHintDone: true })).toBe(false)
  })

  it("shows once, in Chrome's words, as the chrome's toast drawn in the page", () => {
    const rec = io(false, true)
    expect(onFullscreenVideo(rec)).toBe(true)
    expect(rec.marked).toBe(1)
    expect(rec.posted).toEqual([
      { text: FULLSCREEN_EXIT_HINT, exit: null, duration: TOAST_SHOW_MS, dark: true, kind: 'toast' }
    ])
    expect(FULLSCREEN_EXIT_HINT).toBe('Swipe down or press back to exit full screen')
    // The second video: the record was written as the first went up, nothing more.
    expect(onFullscreenVideo(rec)).toBe(false)
    expect(rec.posted).toHaveLength(1)
    expect(rec.marked).toBe(1)
  })

  it('shows nothing once the record says it was shown', () => {
    const rec = io(true)
    expect(onFullscreenVideo(rec)).toBe(false)
    expect(rec.posted).toEqual([])
    expect(rec.marked).toBe(0)
  })

  it('records the showing before posting, so a second report inside the round trip cannot show it twice', () => {
    const state = { fullscreenHintDone: false }
    const posted: PageHint[] = []
    let markedBeforePost = false
    const rec: FullscreenHintIo = {
      settings: () => state,
      dark: () => false,
      markShown: () => {
        state.fullscreenHintDone = true
      },
      post: (hint) => {
        markedBeforePost = state.fullscreenHintDone
        posted.push(hint)
      }
    }
    onFullscreenVideo(rec)
    expect(markedBeforePost).toBe(true)
    expect(posted[0]?.dark).toBe(false)
  })
})
