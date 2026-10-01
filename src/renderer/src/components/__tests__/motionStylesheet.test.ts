import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MOTION_MESSAGE_MS, MOTION_POP_MS, MOTION_STATE_MS } from '@renderer/lib/motion/tokens'

/*
 * The stylesheet's twin of `motionVocabulary.test.ts` (motion-and-interaction-spec §1 and the
 * lead's ruling (a) on W8-M1b, §10): main.css's own declarations read the durations' CSS face –
 * `var(--zen-motion-state)` on a control's property changing (fill, ink, border, opacity,
 * transform, shadow, radius, outline, width), `var(--zen-motion-pop)` on an animation that brings
 * a surface in or out, `var(--zen-motion-message)` on a toast's, a band's or a bubble's leave –
 * never the digits `120ms`, `180ms`, `200ms` themselves. The sheet is read as text, comments
 * dropped, every rule walked with its at-rule context (`@media`, `@supports`; an `@layer` wraps
 * and is not named), and every declaration still carrying one of the three times is listed below
 * by its rule with the times it carries and its reason. A new literal anywhere fails here; one
 * migrated to its token fails here too until its line below is shrunk or struck.
 *
 * Out of the findings: the two declarations of the face itself – `:root`'s and
 * `.zen-error-document`'s `--zen-motion-*` – which are read instead, and held at the tokens'
 * values (as `lib/__tests__/motionTokens.test.ts` holds them).
 *
 * What stays, and why (the list is the whole of it):
 *   - Android reads the digits. Five declarations are at their class's token value already but
 *     are written as digits because the Android program's pins read the number from this file's
 *     text (`V2TokensPinTest.kt`, `TabHoverCardSpecTest.kt`); each is tagged with its token and
 *     held to the token's value here, so the two faces cannot drift apart. They fold into the
 *     face the day those pins read `var(--zen-motion-*)`.
 *   - A value that is not its class's token. §10 (a) rules the class and the value together
 *     (a shadow's 200 → 120, the hint bubble's linear 200 → the pop on `--zen-ease`, a toast's
 *     travel the message token); W8-M1b changes no value, so a declaration whose number is not
 *     its class's stays digits, listed with the clause that will move it, for the lead's pass.
 *   - Not a motion. A progress fill's width catching up with its value is a progress (§2's one
 *     linear place), none of the three classes; its number is its own.
 */

type Face = 'state' | 'pop' | 'message'

const FACE_MS: Record<Face, number> = {
  state: MOTION_STATE_MS,
  pop: MOTION_POP_MS,
  message: MOTION_MESSAGE_MS
}

interface Left {
  /** The literal times the rule carries, in the order they are written. */
  times: string[]
  why: string
  /**
   * The face the literal is by class, when it stands at the face's value and stays digits only
   * because Android's pins read the digits: held equal to the token below.
   */
  face?: Face
}

/**
 * The literals left, by rule – the selector, with the `@media` block that holds it where there
 * is one – each with its times and its reason.
 */
const LEFT: Record<string, Left> = {
  // Android reads the digits.
  '.zen-v2-button': {
    times: ['120ms', '120ms'],
    face: 'state',
    why: 'the v2 button’s press fade (background, transform) at the state token’s value; digits because Android’s V2TokensPinTest.kt reads `background 120ms` from this rule (PromptSheetSpec.PRESS_FADE_MS)'
  },
  '@media (prefers-reduced-motion: reduce) { .zen-animate-pop, .zen-animate-in, .zen-animate-fade }':
    {
      times: ['120ms'],
      face: 'state',
      why: 'the desktop panels’ reduced-motion fade (§0.5: 120 ms of opacity in place) at the state token’s value; digits because Android’s TabHoverCardSpecTest.kt reads `zen-fade (\\d+)ms` from this block (TabHoverCardSpec.FADE_MS)'
    },
  '.zen-animate-pop': {
    times: ['180ms'],
    face: 'pop',
    why: 'a panel’s pop (§2) at the pop token’s value; digits because Android’s TabHoverCardSpecTest.kt reads `zen-pop (\\d+)ms` from this rule (TabHoverCardSpec.POP_MS)'
  },
  '.zen-sheet-grip': {
    times: ['120ms'],
    face: 'state',
    why: 'the grip’s hairline fade (v2 §9.7) at the state token’s value; digits because Android’s V2TokensPinTest.kt reads `box-shadow 120ms` from this rule (PromptSheetSpec.HAIRLINE_FADE_MS)'
  },
  '@media (prefers-reduced-motion: reduce) { .zen-sheet-scrim, .zen-sheet-detents }': {
    times: ['120ms'],
    face: 'state',
    why: 'the sheet chassis’ reduced-motion fade (§0.5) at the state token’s value; digits because Android’s V2TokensPinTest.kt reads the whole declaration `transition: opacity 120ms var(--zen-ease) !important;` (PromptSheetSpec.FADE_MS)'
  },
  // A value that is not its class's token: §10 (a)'s change, deferred with every other value.
  '.zen-toast': {
    times: ['180ms'],
    why: 'a toast’s rise in: §1 / §2 make a toast’s travel the message token (200); this one runs 180 – a value change §10 (a) rules and W8-M1b does not make'
  },
  '.zen-capture-toast': {
    times: ['180ms'],
    why: 'the capture toast’s rise in, the sidebar toast’s number: as `.zen-toast`'
  },
  '.zen-hint-bubble': {
    times: ['200ms'],
    why: 'the hint bubble’s `linear` 200 in: §10 (a) makes it the pop on --zen-ease (180) – a value and a curve change, not made here'
  },
  '.zen-pill-ghost': {
    times: ['200ms'],
    why: 'the carried pill’s shadow swap: a transition on a shadow is the state token (120) by §10 (a); this one runs 200 – a value change not made here'
  },
  '.zen-space-row': {
    times: ['200ms'],
    why: 'a space row’s lift shadow at 200: as `.zen-pill-ghost`'
  },
  '.zen-overview-ghost': {
    times: ['200ms'],
    why: 'the overview card’s lift shadow at 200: as `.zen-pill-ghost`'
  },
  '.zen-group': {
    times: ['200ms'],
    why: 'a group card’s shadow at 200: as `.zen-pill-ghost`'
  },
  '.zen-ntp-tile': {
    times: ['200ms'],
    why: 'a new tab page tile’s shadow at 200: as `.zen-pill-ghost`'
  },
  '.zen-bar-row': {
    times: ['200ms'],
    why: 'a bookmarks bar row’s shadow at 200: as `.zen-pill-ghost`'
  },
  '[data-fade-axis]': {
    times: ['180ms', '180ms'],
    why: 'the scroll edges’ fade lengths (`--zen-fade-start` / `--zen-fade-end`) easing to a new edge: a transition on an element’s own property is the state token (120) by §10 (a); these run 180 – a value change not made here'
  },
  // Not a motion.
  '.zen-settings-progress > div': {
    times: ['200ms'],
    why: 'an update download’s or a meter’s fill catching up with its value: a progress (§2), not a control’s state, a surface’s pop or a message’s travel; its smoothing’s own number'
  }
}

const css = readFileSync(resolve(__dirname, '../../assets/main.css'), 'utf8')

/** The three times as digits, where they stand in a rule's text. */
const LITERAL = /\b(120|180|200)ms\b/g
/** A declaration of the face: `--zen-motion-state: 120ms`. */
const FACE_DECL = /^--zen-motion-(state|pop|message): (\d+)ms$/
/** A rule reading the face. */
const FACE_READ = /var\(--zen-motion-(state|pop|message)\)/g

interface Leaf {
  /** The rule's selector, inside the at-rules that hold it: `@media (…) { .selector }`. */
  where: string
  /** Its own declarations (nested blocks left out), whitespace folded. */
  decls: string[]
}

const stripComments = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '')

/**
 * Every block's own declarations, the block named by its prelude chain. A nested block (an
 * `@media` around rules, a rule's `@starting-style`, a `@keyframes`' steps) is walked as its own
 * leaf; `@layer` preludes wrap and are left out of the name.
 */
function leaves(block: string, chain: string[], out: Leaf[]): void {
  let own = ''
  let at = 0
  for (;;) {
    const open = block.indexOf('{', at)
    if (open < 0) {
      own += block.slice(at)
      break
    }
    const before = block.slice(at, open)
    const preludeStart = before.lastIndexOf(';') + 1
    own += before.slice(0, preludeStart)
    const prelude = before.slice(preludeStart).trim().replace(/\s+/g, ' ')
    let depth = 1
    let i = open + 1
    while (i < block.length && depth > 0) {
      if (block[i] === '{') depth++
      else if (block[i] === '}') depth--
      i++
    }
    leaves(block.slice(open + 1, i - 1), [...chain, prelude], out)
    at = i
  }
  const decls = own
    .split(';')
    .map((d) => d.trim().replace(/\s+/g, ' '))
    .filter(Boolean)
  if (decls.length === 0) return
  const named = chain.filter((p) => !/^@layer\b/.test(p))
  const where = named.length
    ? named.reduceRight((inner, outer) => `${outer} { ${inner} }`)
    : '(the sheet’s top-level statements)'
  out.push({ where, decls })
}

const all: Leaf[] = []
leaves(stripComments(css), [], all)

/** The face's declarations, by rule: `:root` → { state: '120ms', … }. */
const declared = new Map<string, Record<string, string>>()
/** The literal times left, by rule, in order. */
const found = new Map<string, string[]>()
for (const leaf of all) {
  for (const decl of leaf.decls) {
    const face = FACE_DECL.exec(decl)
    if (face) {
      declared.set(leaf.where, { ...declared.get(leaf.where), [face[1]!]: `${face[2]}ms` })
      continue
    }
    const times = [...decl.matchAll(LITERAL)].map((m) => m[0])
    if (times.length) found.set(leaf.where, [...(found.get(leaf.where) ?? []), ...times])
  }
}

const describeLeft = (where: string, times: string[]): string => `${where}: ${times.join(', ')}`

describe('the stylesheet’s motion vocabulary (motion spec §1, §10 (a))', () => {
  it('the walk reaches the sheet’s rules with their at-rule context, and names no layer', () => {
    const wheres = all.map((l) => l.where)
    expect(wheres).toContain(':root')
    expect(wheres).toContain('.zen-error-document')
    expect(wheres).toContain('.zen-v2-button')
    expect(wheres).toContain('.zen-animate-pop')
    expect(wheres).toContain(
      '@media (prefers-reduced-motion: reduce) { .zen-sheet-scrim, .zen-sheet-detents }'
    )
    expect(wheres.some((w) => w.includes('@layer'))).toBe(false)
    // A rule's own declarations, its nested block's apart.
    const sample: Leaf[] = []
    leaves(
      '@layer x { .a { color: red; transition: opacity 120ms; @starting-style { opacity: 0 } } }',
      [],
      sample
    )
    expect(sample).toEqual([
      { where: '.a { @starting-style }', decls: ['opacity: 0'] },
      { where: '.a', decls: ['color: red', 'transition: opacity 120ms'] }
    ])
    expect('transition: opacity 120ms, transform 1120ms'.match(LITERAL)).toEqual(['120ms'])
  })

  it('declares the durations’ face twice, at the tokens’ values, and reads it', () => {
    const face = {
      state: `${MOTION_STATE_MS}ms`,
      pop: `${MOTION_POP_MS}ms`,
      message: `${MOTION_MESSAGE_MS}ms`
    }
    expect(Object.fromEntries(declared)).toEqual({ ':root': face, '.zen-error-document': face })
    const reads = { state: 0, pop: 0, message: 0 }
    for (const leaf of all)
      for (const decl of leaf.decls) for (const m of decl.matchAll(FACE_READ)) reads[m[1] as Face]++
    // Every face is in use: the state's on the controls, the pop's on the surfaces that come
    // and go, the message's on the hint bubble's leave.
    expect(reads.state).toBeGreaterThan(100)
    expect(reads.pop).toBeGreaterThan(0)
    expect(reads.message).toBeGreaterThan(0)
  })

  it('no literal 120ms / 180ms / 200ms stands in a rule not listed here', () => {
    const unlisted = [...found]
      .filter(([where]) => !(where in LEFT))
      .map(([where, times]) => describeLeft(where, times))
    expect(unlisted).toEqual([])
  })

  it('the literals left are the listed ones, in the listed times, for the listed reasons', () => {
    const left = Object.fromEntries(found)
    const listed = Object.fromEntries(Object.entries(LEFT).map(([w, { times }]) => [w, times]))
    // The whole list on a mismatch, so the line to shrink or the literal to migrate is named.
    const detail = [...found].map(([w, t]) => describeLeft(w, t)).join('\n')
    expect(left, detail).toEqual(listed)
    for (const [where, { why }] of Object.entries(LEFT))
      expect(why.length, `${where}: a reason`).toBeGreaterThan(0)
  })

  it('a literal Android reads stands at its face’s value', () => {
    for (const [where, { times, face }] of Object.entries(LEFT)) {
      if (!face) continue
      for (const time of times) expect(time, where).toBe(`${FACE_MS[face]}ms`)
    }
  })
})
