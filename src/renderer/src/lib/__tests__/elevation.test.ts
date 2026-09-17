import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CARD_SHADOW_DARK,
  CARD_SHADOW_LIGHT,
  FRAME_SHADOW,
  lerpShadow,
  shadowCss,
  type ShadowLayer
} from '../motion/elevation'

const css = readFileSync(resolve(__dirname, '../../assets/main.css'), 'utf8')

/** The value of a `--zen-*` custom property inside a `:root` block (light) or the dark block. */
function cssVariable(name: string, dark = false): string {
  const blocks = css.split(/\n(?=[^\s])/) // top-level rules start at column 0
  const block = blocks.find((b) =>
    dark ? b.startsWith(":root[data-theme='dark']") : b.startsWith(':root {')
  )
  if (!block) throw new Error('root block not found')
  const match = block.match(new RegExp(`${name}:\\s*([^;]+);`))
  if (!match) throw new Error(`${name} is not declared in main.css (${dark ? 'dark' : 'light'})`)
  return match[1].replace(/\s+/g, ' ').trim()
}

interface Parsed {
  inset: boolean
  lengths: number[]
  colour: string
  alpha: number
}

/** A `box-shadow` list as numbers, so two spellings of one shadow compare equal. */
function parseShadow(value: string): Parsed[] {
  const layers: string[] = []
  let depth = 0
  let current = ''
  for (const ch of value) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ',' && depth === 0) {
      layers.push(current)
      current = ''
    } else current += ch
  }
  layers.push(current)
  return layers.map((layer) => {
    const inset = /\binset\b/.test(layer)
    // One level of nesting: `rgb(var(--zen-fg-rgb) / 0.08)`.
    const colourMatch = layer.match(/rgba?\((?:[^()]|\([^()]*\))*\)/)
    const colour = colourMatch ? colourMatch[0] : ''
    const alpha = Number(
      colour.match(/\/\s*([\d.]+)/)?.[1] ?? colour.match(/,\s*([\d.]+)\s*\)$/)?.[1] ?? 1
    )
    const rest = layer.replace(colour, '').replace('inset', '')
    const lengths = [...rest.matchAll(/-?[\d.]+(?=px|\s|$)/g)].map((m) => Number(m[0]))
    while (lengths.length < 4) lengths.push(0)
    const channels = colour.replace(/\s*\/.*$/, ')').replace(/,\s*[\d.]+\s*\)$/, ')')
    return { inset, lengths, colour: channels.replace(/\s+/g, ' '), alpha }
  })
}

/** Layers that paint nothing carry no information; drop them before comparing. */
function visible(layers: Parsed[]): Parsed[] {
  return layers.filter((l) => l.alpha > 0)
}

function fromLayers(layers: ShadowLayer[]): Parsed[] {
  return parseShadow(shadowCss(layers))
}

describe('elevation', () => {
  it('matches the stylesheet at both ends of the page ↔ card morph, light and dark', () => {
    expect(visible(fromLayers(FRAME_SHADOW))).toEqual(
      visible(parseShadow(cssVariable('--zen-frame-shadow')))
    )
    expect(visible(fromLayers(CARD_SHADOW_LIGHT))).toEqual(
      visible(parseShadow(cssVariable('--zen-shadow-1')))
    )
    expect(visible(fromLayers(CARD_SHADOW_DARK))).toEqual(
      visible(parseShadow(cssVariable('--zen-shadow-1', true)))
    )
  })

  it('interpolates layer by layer and lands exactly on either look', () => {
    expect(shadowCss(lerpShadow(FRAME_SHADOW, CARD_SHADOW_LIGHT, 0))).toBe(shadowCss(FRAME_SHADOW))
    expect(shadowCss(lerpShadow(FRAME_SHADOW, CARD_SHADOW_LIGHT, 1))).toBe(
      shadowCss(CARD_SHADOW_LIGHT)
    )
    expect(shadowCss(lerpShadow(FRAME_SHADOW, CARD_SHADOW_DARK, 1))).toBe(
      shadowCss(CARD_SHADOW_DARK)
    )
    const half = lerpShadow(FRAME_SHADOW, CARD_SHADOW_LIGHT, 0.5)
    expect(half[0].alpha).toBeCloseTo(0.04)
    expect(half[2].y).toBeCloseTo(5)
    expect(half[2].blur).toBeCloseTo(19)
    expect(half[3].inset).toBe(true)
  })

  it('clamps the progress so rubber-banded drags cannot invert a shadow', () => {
    expect(shadowCss(lerpShadow(FRAME_SHADOW, CARD_SHADOW_LIGHT, -0.3))).toBe(
      shadowCss(FRAME_SHADOW)
    )
    expect(shadowCss(lerpShadow(FRAME_SHADOW, CARD_SHADOW_LIGHT, 1.4))).toBe(
      shadowCss(CARD_SHADOW_LIGHT)
    )
  })
})
