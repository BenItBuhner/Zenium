// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import {
  HOST_RESUME_EVENT,
  cancelPointerCaptures,
  capturePointer,
  heldPointerCaptures,
  returnsToScreen,
  watchForegroundReturn
} from '../gestures/pointerCapture'

function element(): HTMLElement {
  const el = document.createElement('div')
  document.body.appendChild(el)
  return el
}

/** What the browser does once a captured pointer lifts (or the capture is released). */
function lift(el: Element, pointerId: number): void {
  el.dispatchEvent(new PointerEvent('lostpointercapture', { pointerId }))
}

function cancelsOn(el: Element): number[] {
  const seen: number[] = []
  el.addEventListener('pointercancel', (e) => seen.push((e as PointerEvent).pointerId))
  return seen
}

function showAgain(doc: Document): void {
  let state: DocumentVisibilityState = 'hidden'
  Object.defineProperty(doc, 'visibilityState', {
    configurable: true,
    get: () => state
  })
  doc.dispatchEvent(new Event('visibilitychange'))
  state = 'visible'
  doc.dispatchEvent(new Event('visibilitychange'))
}

afterEach(() => {
  cancelPointerCaptures()
  document.body.innerHTML = ''
})

describe('capturePointer', () => {
  it('records a capture until the browser reports it lost', () => {
    const el = element()
    capturePointer(el, 3)
    expect(el.hasPointerCapture(3)).toBe(true)
    expect(heldPointerCaptures()).toBe(1)
    // Captured again on a later move (the pill does that when a drag begins): still one record.
    capturePointer(el, 3)
    expect(heldPointerCaptures()).toBe(1)
    lift(el, 3)
    expect(heldPointerCaptures()).toBe(0)
    expect(cancelPointerCaptures()).toBe(0)
  })

  it('a lift of another pointer leaves the record alone', () => {
    const el = element()
    capturePointer(el, 1)
    lift(el, 2)
    expect(heldPointerCaptures()).toBe(1)
  })
})

describe('cancelPointerCaptures', () => {
  it('ends a gesture that never got its lift with a pointercancel and lets the capture go', () => {
    const el = element()
    const seen = cancelsOn(el)
    const bubbled = cancelsOn(document.body)
    capturePointer(el, 5)
    expect(cancelPointerCaptures()).toBe(1)
    expect(seen).toEqual([5])
    expect(bubbled).toEqual([5])
    expect(el.hasPointerCapture(5)).toBe(false)
    expect(heldPointerCaptures()).toBe(0)
    // Nothing is ended twice.
    expect(cancelPointerCaptures()).toBe(0)
    expect(seen).toEqual([5])
  })

  it('ends every element’s captures, each with its own pointer', () => {
    const sheet = element()
    const pill = element()
    const onSheet = cancelsOn(sheet)
    const onPill = cancelsOn(pill)
    capturePointer(sheet, 1)
    capturePointer(pill, 2)
    capturePointer(pill, 3)
    expect(cancelPointerCaptures()).toBe(3)
    expect(onSheet).toEqual([1])
    expect(onPill.sort()).toEqual([2, 3])
  })
})

describe('returnsToScreen', () => {
  it('is the hidden → visible edge only', () => {
    expect(returnsToScreen('hidden', 'visible')).toBe(true)
    expect(returnsToScreen('visible', 'hidden')).toBe(false)
    expect(returnsToScreen('visible', 'visible')).toBe(false)
    expect(returnsToScreen('hidden', 'hidden')).toBe(false)
  })
})

describe('watchForegroundReturn', () => {
  it('ends stale captures when the document comes back on screen', () => {
    // A document of its own: the chrome's is watched from the moment the module loads.
    const doc = document.implementation.createHTMLDocument('chrome')
    const stop = watchForegroundReturn(doc)
    const el = doc.createElement('div')
    doc.body.appendChild(el)
    const seen = cancelsOn(el)
    capturePointer(el, 7)
    showAgain(doc)
    expect(seen).toEqual([7])
    expect(heldPointerCaptures()).toBe(0)
    stop()
    capturePointer(el, 8)
    showAgain(doc)
    expect(seen).toEqual([7])
  })

  it('ends stale captures when the Android host resumes, hidden or not', () => {
    const stop = watchForegroundReturn(document)
    const el = element()
    const seen = cancelsOn(el)
    capturePointer(el, 9)
    window.dispatchEvent(new Event(HOST_RESUME_EVENT))
    expect(seen).toEqual([9])
    stop()
  })
})
