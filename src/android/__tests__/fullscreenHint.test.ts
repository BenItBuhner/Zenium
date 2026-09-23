import { describe, expect, it } from 'vitest'
import { FULLSCREEN_EXIT_HINT, TOAST_SHOW_MS, type PageHint } from '@shared/fullscreenHint'
import {
  FullscreenHintCues,
  fullscreenHintDue,
  onFullscreenEntered,
  type FullscreenHintIo
} from '../fullscreenHint'

/*
 * GN-20: the first time a video goes fullscreen the phone shows how to leave, once ever, keyed
 * in settings as the gesture hint (FRE-07) is. MED-03: an element without a video (a canvas, a
 * slide deck) has no controls with a way out of their own, so the hint stands every time.
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
    expect(onFullscreenEntered(rec)).toBe(true)
    expect(rec.marked).toBe(1)
    expect(rec.posted).toEqual([
      { text: FULLSCREEN_EXIT_HINT, exit: null, duration: TOAST_SHOW_MS, dark: true, kind: 'toast' }
    ])
    expect(FULLSCREEN_EXIT_HINT).toBe('Swipe down or press back to exit full screen')
    // The second video: the record was written as the first went up, nothing more.
    expect(onFullscreenEntered(rec)).toBe(false)
    expect(rec.posted).toHaveLength(1)
    expect(rec.marked).toBe(1)
  })

  it('shows nothing once the record says it was shown', () => {
    const rec = io(true)
    expect(onFullscreenEntered(rec)).toBe(false)
    expect(onFullscreenEntered(rec, true)).toBe(false)
    expect(rec.posted).toEqual([])
    expect(rec.marked).toBe(0)
  })

  it('stands every time for an element without a video, in the same words (MED-03)', () => {
    expect(fullscreenHintDue({ fullscreenHintDone: true }, false)).toBe(true)
    expect(fullscreenHintDue({ fullscreenHintDone: true }, true)).toBe(false)
    expect(fullscreenHintDue({ fullscreenHintDone: true }, null)).toBe(false)
    const rec = io(true, true)
    expect(onFullscreenEntered(rec, false)).toBe(true)
    expect(onFullscreenEntered(rec, false)).toBe(true)
    expect(rec.posted).toHaveLength(2)
    expect(rec.posted[0]).toEqual({
      text: FULLSCREEN_EXIT_HINT,
      exit: null,
      duration: TOAST_SHOW_MS,
      dark: true,
      kind: 'toast'
    })
    // The record already stood: nothing written again.
    expect(rec.marked).toBe(0)
  })

  it("an element without a video counts as the hint's showing: the first video after it says nothing more", () => {
    const rec = io(false)
    expect(onFullscreenEntered(rec, false)).toBe(true)
    expect(rec.marked).toBe(1)
    expect(onFullscreenEntered(rec, true)).toBe(false)
    expect(onFullscreenEntered(rec)).toBe(false)
    expect(rec.posted).toHaveLength(1)
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
    onFullscreenEntered(rec)
    expect(markedBeforePost).toBe(true)
    expect(posted[0]?.dark).toBe(false)
  })
})

describe("the page's word trailing the host's cap (the late cue)", () => {
  it('raises the toast the cap withheld for an element without a video, once per fullscreen', () => {
    const rec = io(true)
    const cues = new FullscreenHintCues(() => rec)
    // The wordless cue: a video's treatment, the once had – nothing over a slow page's video.
    expect(cues.entered('t1', null)).toBe(false)
    expect(rec.posted).toHaveLength(0)
    // The canvas's `false` past the cap: the toast owed every time (MED-03) goes up late.
    expect(cues.entered('t1', false, true)).toBe(true)
    expect(rec.posted).toHaveLength(1)
    expect(rec.posted[0]?.text).toBe(FULLSCREEN_EXIT_HINT)
    // The next fullscreen's own cue reads the settings afresh: a canvas again, its own toast.
    expect(cues.entered('t1', false)).toBe(true)
    expect(rec.posted).toHaveLength(2)
    expect(rec.marked).toBe(0)
  })

  it('shows nothing late over the hint the wordless cue already raised (the first time ever)', () => {
    const rec = io(false)
    const cues = new FullscreenHintCues(() => rec)
    expect(cues.entered('t1', null)).toBe(true)
    expect(rec.marked).toBe(1)
    expect(cues.entered('t1', false, true)).toBe(false)
    expect(rec.posted).toHaveLength(1)
    // Its memory is the tab's: another tab's late word is judged on its own cue.
    expect(cues.entered('t2', null)).toBe(false)
    expect(cues.entered('t2', false, true)).toBe(true)
    expect(rec.posted).toHaveLength(2)
    // A fresh cue writes the memory over: the next fullscreen's late word is not held to this one's.
    expect(cues.entered('t1', null)).toBe(false)
    expect(cues.entered('t1', false, true)).toBe(true)
    expect(rec.posted).toHaveLength(3)
  })

  it('posts to the tab the cue names', () => {
    const tabs: string[] = []
    const cues = new FullscreenHintCues((tabId) => {
      tabs.push(tabId)
      return io(true)
    })
    cues.entered('t9', false)
    expect(tabs).toEqual(['t9'])
  })
})
