// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import {
  applyTextScale,
  currentTextScale,
  textScaleOf,
  textScaleProperties,
  textScaleStep,
  TWO_LINE_TITLE_ZOOM
} from '../textScale'
import { CARD_HEADER, cardHeaderHeight } from '../../components/phone/overviewCardHeader'

/**
 * The chrome's text at the system font size (A11Y-05, v2 §4 / §9.2): what the host reports
 * lands on the root as the zoom factor, the bold-text weight adjustment and the stylesheet's
 * step for the two-line rules.
 */
describe('textScaleOf', () => {
  it('reads the host’s factor and weight adjustment, with the defaults for a host that scales no text', () => {
    expect(textScaleOf({ textZoom: 1.3, fontWeightAdjustment: 300 })).toEqual({
      zoom: 1.3,
      weightAdjustment: 300
    })
    expect(textScaleOf({})).toEqual({ zoom: 1, weightAdjustment: 0 })
    expect(textScaleOf(null)).toEqual({ zoom: 1, weightAdjustment: 0 })
    expect(textScaleOf({ textZoom: Number.NaN, fontWeightAdjustment: 'x' as never })).toEqual({
      zoom: 1,
      weightAdjustment: 0
    })
  })

  it('holds the factor to what the WebView accepts and the adjustment to the platform’s 300', () => {
    expect(textScaleOf({ textZoom: 9 }).zoom).toBe(3)
    expect(textScaleOf({ textZoom: 0.1 }).zoom).toBe(0.5)
    expect(textScaleOf({ fontWeightAdjustment: 1000 }).weightAdjustment).toBe(300)
  })
})

describe('textScaleStep', () => {
  it('is unset at the default size and below, large above it, larger from the two-line title zoom', () => {
    expect(textScaleStep(0.85)).toBeNull()
    expect(textScaleStep(1)).toBeNull()
    expect(textScaleStep(1.15)).toBe('large')
    expect(textScaleStep(1.3)).toBe('large')
    expect(TWO_LINE_TITLE_ZOOM).toBe(1.5)
    expect(textScaleStep(1.5)).toBe('larger')
    expect(textScaleStep(1.8)).toBe('larger')
    expect(textScaleStep(2)).toBe('larger')
  })
})

describe('applyTextScale', () => {
  afterEach(() => applyTextScale(null))

  it('writes the factor, the adjustment and the step on the root, and takes them off again at the defaults', () => {
    const root = document.documentElement
    applyTextScale({ textZoom: 1.8, fontWeightAdjustment: 300 })
    expect(root.style.getPropertyValue('--zen-text-zoom')).toBe('1.8')
    expect(root.style.getPropertyValue('--zen-font-weight-adjustment')).toBe('300')
    expect(root.dataset.textZoom).toBe('180')
    expect(root.dataset.textScale).toBe('larger')
    expect(root.dataset.boldText).toBe('true')
    expect(currentTextScale()).toEqual({ zoom: 1.8, weightAdjustment: 300 })

    applyTextScale({ textZoom: 1.3 })
    expect(root.dataset.textScale).toBe('large')
    expect(root.dataset.boldText).toBeUndefined()

    applyTextScale({ textZoom: 1 })
    expect(root.style.getPropertyValue('--zen-text-zoom')).toBe('')
    expect(root.style.getPropertyValue('--zen-font-weight-adjustment')).toBe('')
    expect(root.dataset.textZoom).toBe('100')
    expect(root.dataset.textScale).toBeUndefined()
    expect(textScaleProperties(currentTextScale())).toEqual({
      '--zen-text-zoom': '1',
      '--zen-font-weight-adjustment': '0'
    })
  })
})

describe('cardHeaderHeight', () => {
  it('is the 44 title row at the default size, grows from the 20 line, and takes a second line from 1.5', () => {
    expect(cardHeaderHeight(1)).toBe(CARD_HEADER)
    expect(cardHeaderHeight(1.3)).toBe(50)
    expect(cardHeaderHeight(1.5)).toBe(84)
    expect(cardHeaderHeight(1.8)).toBe(96)
    // What `--zen-overview-card-header` computes to in the stylesheet, so the hero's morph in JS
    // lands on the row the card draws.
    const header = (zoom: number, lines: number): number => lines * 20 * zoom + 24
    for (const zoom of [1, 1.15, 1.3, 1.5, 1.8, 2])
      expect(cardHeaderHeight(zoom)).toBeCloseTo(header(zoom, zoom >= 1.5 ? 2 : 1), 6)
  })
})
