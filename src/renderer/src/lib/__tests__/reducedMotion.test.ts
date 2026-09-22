import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { NEW_TAB_PAGE_STYLE } from '@shared/newTabPage'
import { REDUCED_FADE_MS } from '../motion/fade'

/**
 * Reduced motion is no transition, not a short one (design language v2 §11.3 as amended): a
 * shortened transition still draws its start value until the compositor starts it, so a layout
 * change shows a frame of stale geometry and a `visibility` change a frame of the wrong state
 * (#243 measured a hidden new tab page for over a second). So every stylesheet's
 * `prefers-reduced-motion` blocks are held to the rule's two halves: ONE global rule removes –
 * `transition-property: none` and `animation: none` on everything – and the 120 ms opacity fades
 * §11.3 keeps are re-declared explicitly where they live, `!important`, opacity alone, at the fade
 * length and no other; nothing re-declares a duration on its own, nothing shortens.
 */

const asset = (file: string): string =>
  readFileSync(fileURLToPath(new URL(`../../assets/${file}`, import.meta.url)), 'utf8')

/** The chrome document's stylesheets: main.css and what is imported beside it. */
const CHROME_SHEETS: ReadonlyArray<readonly [name: string, css: string]> = [
  ['main.css', asset('main.css')],
  ['extensions.css', asset('extensions.css')],
  ['translate.css', asset('translate.css')],
  ['autofill.css', asset('autofill.css')],
  ['passwords.css', asset('passwords.css')],
  [
    'phonePanels.css',
    readFileSync(
      fileURLToPath(new URL('../../components/phone/phonePanels.css', import.meta.url)),
      'utf8'
    )
  ]
]

/** Stylesheets that are a document of their own and so need a remover of their own. */
const DOCUMENTS: ReadonlyArray<readonly [name: string, css: string]> = [
  ['main.css', asset('main.css')],
  ['newTabPage.ts NEW_TAB_PAGE_STYLE', NEW_TAB_PAGE_STYLE]
]

interface Decl {
  prop: string
  value: string
  important: boolean
}

interface Rule {
  selector: string
  decls: Decl[]
  /** Inside an `@layer` block: an important declaration there beats an unlayered important one. */
  layered: boolean
}

const REDUCED_QUERY = /^@media\s*\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)\s*$/

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '')
}

/** The declarations of a rule body (no nested blocks). */
function parseDecls(body: string): Decl[] {
  return body
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const colon = s.indexOf(':')
      const prop = s.slice(0, colon).trim()
      let value = s.slice(colon + 1).trim()
      const important = /!important$/.test(value)
      if (important) value = value.replace(/\s*!important$/, '').trim()
      return { prop, value: value.replace(/\s+/g, ' '), important }
    })
}

/**
 * The rules inside a block's text, nested blocks (`@starting-style`, `@supports`) walked into.
 * Each rule's selector is the text between the previous `{`, `}` or `;` and its own `{`.
 */
function parseRules(block: string, layered: boolean, out: Rule[]): void {
  let at = 0
  for (;;) {
    const open = block.indexOf('{', at)
    if (open < 0) return
    const before = block.slice(at, open)
    const preludeStart = Math.max(before.lastIndexOf('}'), before.lastIndexOf(';')) + 1
    const selector = before.slice(preludeStart).trim().replace(/\s+/g, ' ')
    let depth = 1
    let i = open + 1
    while (i < block.length && depth > 0) {
      if (block[i] === '{') depth++
      else if (block[i] === '}') depth--
      i++
    }
    const body = block.slice(open + 1, i - 1)
    if (selector.startsWith('@')) parseRules(body, layered || /^@layer\b/.test(selector), out)
    else out.push({ selector, decls: parseDecls(body), layered })
    at = i
  }
}

/** Every rule under a `prefers-reduced-motion: reduce` media query in `css`. */
function reducedRules(css: string): Rule[] {
  const bare = stripComments(css)
  const rules: Rule[] = []
  // Walk the whole sheet with a brace stack so each media block knows whether a layer holds it.
  const layers: boolean[] = []
  let preludeStart = 0
  for (let i = 0; i < bare.length; i++) {
    const c = bare[i]
    if (c === '{') {
      const prelude = bare.slice(preludeStart, i).trim().replace(/\s+/g, ' ')
      if (REDUCED_QUERY.test(prelude)) {
        let depth = 1
        let j = i + 1
        while (j < bare.length && depth > 0) {
          if (bare[j] === '{') depth++
          else if (bare[j] === '}') depth--
          j++
        }
        parseRules(bare.slice(i + 1, j - 1), layers.some(Boolean), rules)
        i = j - 1
        preludeStart = j
        continue
      }
      layers.push(/^@layer\b/.test(prelude))
      preludeStart = i + 1
    } else if (c === '}') {
      layers.pop()
      preludeStart = i + 1
    } else if (c === ';') {
      preludeStart = i + 1
    }
  }
  return rules
}

/** The properties each `@keyframes` in `css` animates, by name. */
function keyframeProps(css: string): Map<string, Set<string>> {
  const bare = stripComments(css)
  const out = new Map<string, Set<string>>()
  for (const m of bare.matchAll(/@keyframes\s+([\w-]+)\s*\{/g)) {
    let depth = 1
    let i = m.index + m[0].length
    const start = i
    while (i < bare.length && depth > 0) {
      if (bare[i] === '{') depth++
      else if (bare[i] === '}') depth--
      i++
    }
    const props = new Set<string>()
    for (const d of bare.slice(start, i - 1).matchAll(/([a-z-]+)\s*:/g)) props.add(d[1])
    out.set(m[1], props)
  }
  return out
}

const isMotion = (d: Decl): boolean => /^(transition|animation)(-|$)/.test(d.prop)
const isRemover = (r: Rule): boolean => r.selector.split(',').some((s) => s.trim() === '*')
const times = (value: string): string[] => value.match(/\d*\.?\d+m?s\b/g) ?? []
const where = (name: string, r: Rule, d: Decl): string =>
  `${name}: ${r.selector} { ${d.prop}: ${d.value}${d.important ? ' !important' : ''} }`

describe('reduced motion removes, never shortens (v2 §11.3)', () => {
  const sheets = [...CHROME_SHEETS, DOCUMENTS[1]]

  it('leaves no shortened duration under any prefers-reduced-motion block', () => {
    for (const [name, css] of sheets) {
      for (const r of reducedRules(css)) {
        for (const d of r.decls.filter(isMotion)) {
          for (const t of times(d.value)) {
            expect(t, where(name, r, d)).toBe(`${REDUCED_FADE_MS}ms`)
          }
          expect(
            ['transition-duration', 'animation-duration', 'animation-delay'].includes(d.prop),
            `a duration on its own re-declares no fade – write it out: ${where(name, r, d)}`
          ).toBe(false)
        }
      }
    }
  })

  it('has one global rule per document that removes, unlayered, and none that removes elsewhere', () => {
    for (const [name, css] of DOCUMENTS) {
      const rules = reducedRules(css)
      const removers = rules.filter(isRemover)
      expect(removers, `${name}: one universal rule`).toHaveLength(1)
      const [remover] = removers
      expect(remover.layered, `${name}: the remover is unlayered`).toBe(false)
      expect(
        remover.decls.map((d) => `${d.prop}: ${d.value}${d.important ? ' !important' : ''}`).sort()
      ).toEqual(['animation: none !important', 'transition-property: none !important'])
      for (const r of rules.filter((r) => !isRemover(r))) {
        for (const d of r.decls.filter(isMotion)) {
          expect(d.value === 'none', `only the global rule removes: ${where(name, r, d)}`).toBe(
            false
          )
        }
      }
    }
    // The other chrome sheets share main.css's document and its remover: none of their own.
    for (const [name, css] of CHROME_SHEETS.slice(1)) {
      expect(reducedRules(css).filter(isRemover), name).toHaveLength(0)
    }
  })

  it('keeps every fade opacity-only, 120 ms, written out and !important', () => {
    for (const [name, css] of sheets) {
      const keyframes = keyframeProps(css)
      for (const r of reducedRules(css).filter((r) => !isRemover(r))) {
        for (const d of r.decls.filter(isMotion)) {
          const at = where(name, r, d)
          expect(d.important, `beats the remover only as !important: ${at}`).toBe(true)
          switch (d.prop) {
            case 'transition': {
              const segments = d.value.split(',').map((s) => s.trim().split(/\s+/))
              expect(segments, `one transition, on opacity: ${at}`).toHaveLength(1)
              expect(segments[0][0], `opacity alone: ${at}`).toBe('opacity')
              expect(times(d.value), `at the fade length: ${at}`).toEqual([`${REDUCED_FADE_MS}ms`])
              break
            }
            case 'animation': {
              const tokens = d.value.split(/\s+/)
              const named = tokens.find((t) => keyframes.has(t))
              expect(named, `a keyframes rule of this sheet: ${at}`).toBeDefined()
              expect([...keyframes.get(named!)!], `an opacity-only fade: ${at}`).toEqual(['opacity'])
              expect(times(d.value), `at the fade length: ${at}`).toEqual([`${REDUCED_FADE_MS}ms`])
              break
            }
            case 'animation-play-state':
              // The new tab page's tiles wait while the page is not painted, under the fade too.
              expect(d.value, at).toBe('paused')
              break
            default:
              expect.fail(`a longhand re-declares no fade – write it out: ${at}`)
          }
        }
      }
    }
  })

  it('declares the fades §11.3 keeps where they live', () => {
    const kept = new Set<string>()
    for (const r of reducedRules(asset('main.css')).filter((r) => !isRemover(r))) {
      if (r.decls.some((d) => d.prop === 'transition' || d.prop === 'animation')) {
        for (const s of r.selector.split(',')) kept.add(s.trim())
      }
    }
    for (const selector of [
      // The sheet chassis: a sheet fades in at its detent and out from it with its scrim.
      '.zen-sheet-scrim',
      '.zen-sheet-detents',
      // The phone frame-dialog host's sheet, on the chassis.
      '.zen-frame-dialogs[data-sheet] .zen-frame-scrim',
      '.zen-frame-dialogs[data-sheet] .zen-frame-dialogs-slot',
      // The load bar's appearance and departure.
      '.zen-load-progress',
      // The overview fades in at scale 1; a pane switch cross-fades in place; the select-tabs
      // action band (#304) comes and goes on its fade in place of the slide.
      '.zen-overview',
      '.zen-overview-pane',
      '.zen-overview-actions-band',
      // A group's header and tint at the end of the glide.
      '.zen-group-header',
      '.zen-group::before',
      // The segment's line arriving on the picked tab; read aloud's glyph swap.
      ".zen-v2-segment > [role='tab']::after",
      '.zen-read-aloud-toggle > svg',
      // The new tab page's tiles, and the morph's fades (#243).
      ":root[data-form-factor='phone'] .zen-ntp-site",
      ":root[data-fakebox='opening'] .zen-fakebox-layer",
      ":root[data-fakebox='closing'] .zen-fakebox-layer",
      ":root[data-fakebox='opening'] .zen-omnibox-sheet",
      ":root[data-fakebox='closing'] .zen-omnibox-sheet",
      ":root[data-fakebox='opening'] .zen-phone-bar",
      ":root[data-fakebox='closing'] .zen-phone-bar",
      ":root[data-fakebox='opening'] .zen-ntp-fades",
      ":root[data-fakebox='closing'] .zen-ntp-fades",
      // The desktop program's: the panels' pop, the frame dialogs' way out, the sidebar's toast.
      '.zen-animate-pop',
      '.zen-animate-in',
      '.zen-animate-fade',
      '.zen-frame-dialogs:not([data-sheet]) .zen-frame-dialogs-slot > [data-leaving]',
      '.zen-frame-dialogs:not([data-sheet]) .zen-frame-scrim[data-leaving]',
      '.zen-toast'
    ]) {
      expect(kept.has(selector), `${selector} keeps its fade`).toBe(true)
    }
  })

  it('has the shared new tab page keep the Undo toast alone', () => {
    const kept = reducedRules(NEW_TAB_PAGE_STYLE).filter((r) => !isRemover(r))
    expect(kept.map((r) => r.selector)).toEqual(['.zen-toast'])
  })
})
