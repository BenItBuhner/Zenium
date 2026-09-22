import { describe, expect, it } from 'vitest'
import { FULLSCREEN_EXIT_HINT, TOAST_SHOW_MS, type PageHint } from '@shared/fullscreenHint'
import { fullscreenHintDue, onFullscreenEntered, type FullscreenHintIo } from '../fullscreenHint'

/*
 * GN-20: the first time a page puts a video in fullscreen the phone shows how to leave, once
 * ever, keyed in settings as the gesture hint (FRE-07) is. MED-03: any other element's
 * fullscreen (a canvas, a slide deck, an embed without a video) shows the same toast every time,
 * as Chrome for Android's does.
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

const toast = (dark: boolean): PageHint => ({
  text: FULLSCREEN_EXIT_HINT,
  exit: null,
  duration: TOAST_SHOW_MS,
  dark,
  kind: 'toast'
})

describe('the first-time fullscreen exit hint (GN-20)', () => {
  it('is owed until it has had its showing', () => {
    expect(fullscreenHintDue({ fullscreenHintDone: false })).toBe(true)
    expect(fullscreenHintDue({ fullscreenHintDone: true })).toBe(false)
  })

  it("shows once for a video, in Chrome's words, as the chrome's toast drawn in the page", () => {
    const rec = io(false, true)
    expect(onFullscreenEntered(rec, true)).toBe(true)
    expect(rec.marked).toBe(1)
    expect(rec.posted).toEqual([toast(true)])
    expect(FULLSCREEN_EXIT_HINT).toBe('Swipe down or press back to exit full screen')
    // The second video: the record was written as the first went up, nothing more.
    expect(onFullscreenEntered(rec, true)).toBe(false)
    expect(rec.posted).toHaveLength(1)
    expect(rec.marked).toBe(1)
  })

  it('shows nothing for a video once the record says it was shown', () => {
    const rec = io(true)
    expect(onFullscreenEntered(rec, true)).toBe(false)
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
    onFullscreenEntered(rec, true)
    expect(markedBeforePost).toBe(true)
    expect(posted[0]?.dark).toBe(false)
  })
})

describe("the exit hint for an element that is not a video's (MED-03)", () => {
  it('shows the same toast every time, record or no record', () => {
    const rec = io(true, false)
    expect(onFullscreenEntered(rec, false)).toBe(true)
    expect(onFullscreenEntered(rec, false)).toBe(true)
    expect(rec.posted).toEqual([toast(false), toast(false)])
    // Nothing to record: the record was written already.
    expect(rec.marked).toBe(0)
  })

  it("counts as the first-time hint's showing: the way out has been shown", () => {
    const rec = io(false, true)
    expect(onFullscreenEntered(rec, false)).toBe(true)
    expect(rec.marked).toBe(1)
    expect(rec.posted).toEqual([toast(true)])
    // The first video after it owes nothing more; the next canvas shows the toast again.
    expect(onFullscreenEntered(rec, true)).toBe(false)
    expect(onFullscreenEntered(rec, false)).toBe(true)
    expect(rec.posted).toHaveLength(2)
    expect(rec.marked).toBe(1)
  })
})
