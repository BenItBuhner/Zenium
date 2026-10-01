import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MOTION_MESSAGE_MS, MOTION_POP_MS, MOTION_STATE_MS } from '@renderer/lib/motion/tokens'

/*
 * The stylesheet's twin of `motionVocabulary.test.ts` (motion-and-interaction-spec §1 and the
 * lead's ruling (a) on W8-M1b, §10): main.css's own declarations read the durations' CSS face –
 * `var(--zen-motion-state)` on a control's property changing (fill, ink, border, opacity,
 * transform, shadow, radius, outline, width), `var(--zen-motion-pop)` on an animation that brings
 * a surface in or out, `var(--zen-motion-message)` on a toast's, a band's or a bubble's travel –
 * never digits before `ms`. W8-M1b made the sheet read the face where its number was already its
 * class's; W8-M1c, the sweep, made the conversions §10 (a) ruled where it was not (the toasts'
 * 180 → the message's 200, the hint bubble's linear 200 → the pop on `--zen-ease`, the lift
 * shadows' 200 and the fade edges' 180 → the state's 120) and folded every other mapped number
 * by the ruling's table – 100 / 140 / 150 on a transition → the state, 160 / 220 / 240 / 250 on
 * an animation in or out → the pop, a 160 transition on a control's property the state by its
 * class. The sheet is read as text, comments dropped, every rule walked with its at-rule context
 * (`@media`, `@supports`; an `@layer` wraps and is not named), and every declaration still
 * carrying a time literal – any `<n>ms` or `<n>s`, not only the three tokens' digits – is listed
 * below by its rule with the times it carries and its reason. A new literal anywhere fails here;
 * one migrated to its token fails here too until its line below is shrunk or struck.
 *
 * Out of the findings: the two declarations of the face itself – `:root`'s and
 * `.zen-error-document`'s `--zen-motion-*` – which are read instead, and held at the tokens'
 * values (as `lib/__tests__/motionTokens.test.ts` holds them).
 *
 * What stays, and why (the list is the whole of it):
 *   - Android reads the digits (`face`). Five declarations are at their class's token value
 *     already but are written as digits because the Android program's pins read the number from
 *     this file's text (`V2TokensPinTest.kt`, `TabHoverCardSpecTest.kt`); each is tagged with its
 *     token and held to the token's value here, so the two faces cannot drift apart. They fold
 *     into the face the day those pins read `var(--zen-motion-*)`.
 *   - A loop (`kind: 'loop'`). A repeating animation – a busy ring, an indeterminate progress's
 *     sweep, Chrome's IPH anchor pulse – is not a travel and takes no token: §10 (a) keeps a loop
 *     by name with its reason, and each is held to loop (`infinite` in its declaration). The
 *     ruling names indeterminate progress (`zen-progress`, the downloads slide) and the IPH pulse
 *     and says nothing else loops (v2 §9.33); a loop it does not name is marked for the lead.
 *   - A progress (`kind: 'progress'`). A fill catching up with its value – a bar's transform, a
 *     meter's width, a ring's dash offset – is a progress (§2's one linear place), none of the
 *     three classes; its smoothing's number is its own.
 *   - A delay (`kind: 'delay'`). A stagger's step or an animation's wait before it starts is not
 *     a duration; nothing in the table names one.
 *   - Flagged for the lead (`kind: 'flagged'`). A motion whose number is in no mapping – 260,
 *     280, 600 – is neither converted (a token is not invented) nor at home: each names the spec
 *     clause that stands over it and waits for the ruling; none carries a mapped number.
 */

type Face = 'state' | 'pop' | 'message'

const FACE_MS: Record<Face, number> = {
  state: MOTION_STATE_MS,
  pop: MOTION_POP_MS,
  message: MOTION_MESSAGE_MS
}

/** The literal times the rule carries, in the order they are written, and the reason they stay. */
interface Literal {
  times: string[]
  why: string
}

type Left =
  /**
   * The face the literal is by class, when it stands at the face's value and stays digits only
   * because Android's pins read the digits: held equal to the token below.
   */
  | (Literal & { face: Face; kind?: never })
  | (Literal & { kind: 'loop' | 'progress' | 'delay' | 'flagged'; face?: never })

/**
 * The numbers §10 (a)'s table maps to a token (the three faces' own and the sweep's): one of
 * these may stay only as Android's digits, a progress or a delay – never as a motion.
 */
const MAPPED = new Set([
  '100ms',
  '120ms',
  '140ms',
  '150ms',
  '160ms',
  '180ms',
  '200ms',
  '220ms',
  '240ms',
  '250ms'
])

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
  // Loops: §10 (a) keeps each by name. Busy rings (v2 §9.30: a 16 ring spinning in the control's
  // ink) and indeterminate progress are the ruling's "indeterminate progress"; the two IPH
  // pulses are Chrome's anchor pulse; the live dot is a loop the ruling does not name.
  '.zen-spin': {
    times: ['900ms'],
    kind: 'loop',
    why: 'the house busy ring (v2 §9.30), `zen-spin` 900ms linear infinite: indeterminate progress, a loop §10 (a) keeps by name'
  },
  '.zen-tab-throbber': {
    times: ['900ms'],
    kind: 'loop',
    why: 'the tab row’s throbber (tabs-41, Chrome’s two phases), `zen-spin` 900ms linear infinite reverse while the load waits: indeterminate progress (§10 (a))'
  },
  '.zen-interstitial-spinner > svg': {
    times: ['900ms'],
    kind: 'loop',
    why: 'the interstitial page’s spinner, `zen-interstitial-spin` 900ms linear infinite: indeterminate progress (§10 (a))'
  },
  '.zen-ptr-glyph[data-spinning]': {
    times: ['900ms'],
    kind: 'loop',
    why: 'the pull-to-refresh glyph spinning while the reload runs, `zen-ptr-spin` 900ms linear infinite: indeterminate progress (§10 (a))'
  },
  '.zen-settings-spinner': {
    times: ['900ms'],
    kind: 'loop',
    why: 'the Settings page’s busy ring (v2 §9.30), `zen-spin` 900ms linear infinite: indeterminate progress (§10 (a))'
  },
  '.zen-dl-spinner': {
    times: ['800ms'],
    kind: 'loop',
    why: 'the downloads bubble’s busy ring (v2 §9.30), `zen-spin` 800ms linear infinite: indeterminate progress (§10 (a)); its 800 against the other rings’ 900 is a drift of its own, not a token matter'
  },
  '.zen-dl-ring-spin': {
    times: ['900ms'],
    kind: 'loop',
    why: 'the downloads toolbar ring spinning while the aggregate progress is unknown, `zen-spin` 900ms linear infinite: indeterminate progress (§10 (a))'
  },
  '.zen-tab-progress::after': {
    times: ['1.1s'],
    kind: 'loop',
    why: 'the tab row’s indeterminate load bar, `zen-progress` 1.1s infinite: the indeterminate progress §10 (a) names'
  },
  '.zen-dl-bar-sweep': {
    times: ['1.1s'],
    kind: 'loop',
    why: 'the downloads bubble’s indeterminate sweep, `zen-progress` 1.1s infinite: the indeterminate progress §10 (a) names'
  },
  '.zen-downloads-progress[data-indeterminate] .zen-downloads-progress-bar': {
    times: ['1.4s'],
    kind: 'loop',
    why: 'the downloads page’s indeterminate bar, `zen-downloads-progress-slide` 1.4s infinite: the downloads slide §10 (a) names'
  },
  ".zen-phone-bar[data-iph-anchor='tabs'] [data-bar-item='tabs']::before": {
    times: ['1250ms'],
    kind: 'loop',
    why: 'the IPH anchor’s halo on the tab switcher button, `zen-iph-pulse` 1250ms infinite alternate: Chrome’s `PulseDrawable` cycle (1.25 s each way), the IPH anchor pulse §10 (a) names'
  },
  '.zen-overview-grid [data-cell][data-iph-anchor]::before': {
    times: ['1250ms'],
    kind: 'loop',
    why: 'the IPH anchor’s halo on an overview card, `zen-iph-pulse-card` 1250ms infinite alternate: the same Chrome cycle, the IPH anchor pulse §10 (a) names'
  },
  '.zen-live-dot': {
    times: ['2.4s'],
    kind: 'loop',
    why: 'a live folder’s dot breathing (`SpacePanel.tsx`: "Live folder – updates automatically"), `zen-pulse` 2.4s infinite: a loop §10 (a) does not name ("nothing else loops", v2 §9.33) – marked for the lead on W8-M1c, kept as it was'
  },
  // A progress: a fill catching up with its value, §2's one linear place.
  '.zen-settings-progress > div': {
    times: ['200ms'],
    kind: 'progress',
    why: 'an update download’s or a meter’s fill catching up with its value: a progress (§2), not a control’s state, a surface’s pop or a message’s travel; its smoothing’s own number'
  },
  '.zen-dl-bar-fill': {
    times: ['260ms'],
    kind: 'progress',
    why: 'the downloads bubble’s bar scaling to the transfer’s value (`transition: transform`): a progress (§2), its smoothing’s own number'
  },
  '.zen-dl-ring-value': {
    times: ['260ms'],
    kind: 'progress',
    why: 'the downloads toolbar ring’s arc catching up with the aggregate progress (`transition: stroke-dashoffset`): a progress (§2), its smoothing’s own number'
  },
  '.zen-downloads-progress-bar': {
    times: ['250ms'],
    kind: 'progress',
    why: 'the downloads page’s bar scaling to the row’s value, `transition: transform` 250ms linear: a progress, §2’s one linear place – a 250 the sweep leaves because it is not an animation in or out'
  },
  // A delay, not a duration.
  ":root[data-form-factor='phone'] .zen-ntp-site": {
    times: ['20ms'],
    kind: 'delay',
    why: 'the tiles’ stagger step, `animation-delay: calc(var(--zen-ntp-i, 0) * 20ms)`: eight tiles in within v1 §7’s 300 ms (7 × 20 + the state’s 120); the fade itself reads the state token'
  },
  ":root[data-form-factor='phone'] .zen-mstack": {
    times: ['160ms'],
    kind: 'delay',
    why: 'the Magic Stack’s wait for the last tile, the `animation` shorthand’s delay (8 × the 20 ms step = 160ms) before a fade that reads the state token: a delay, not a duration'
  },
  // Flagged for the lead: a motion at a number no mapping names; left as it was, not converted.
  '.zen-window': {
    times: ['600ms'],
    kind: 'flagged',
    why: 'the whole-window tint on a space switch, `transition: background` 600ms: §10 (a) rules it rides the switch’s spring or takes the state token, never a clock of its own, and §1’s cap (300) stands over it – which of the two is the lead’s call, flagged on W8-M1c'
  },
  '.zen-rail-flyout[data-flyout-rows]::before': {
    times: ['600ms'],
    kind: 'flagged',
    why: 'the collapsed rail flyout’s backdrop wearing the window’s gradient, `transition: background` 600ms: it follows the window’s tint and goes where `.zen-window`’s 600 goes (§10 (a)) – flagged with it on W8-M1c'
  },
  '.zen-firstrun': {
    times: ['600ms'],
    kind: 'flagged',
    why: 'the first run’s page wearing the window’s gradient, `transition: background` 600ms: it follows a change of look as the window does and goes where `.zen-window`’s 600 goes (§10 (a)) – flagged with it on W8-M1c'
  },
  '.zen-space-strip': {
    times: ['280ms'],
    kind: 'flagged',
    why: 'the sidebar’s panes sliding a width on a space switch, `transition: transform` 280ms: §2 rules the space switch a `SPRING_SNAPPY` travel (~250 ms to the eye); the clock stands in for the spring until the strip’s slide is spring-driven – flagged on W8-M1c, no token at 280'
  },
  ":root[data-form-factor='phone'] .zen-space-strip": {
    times: ['260ms'],
    kind: 'flagged',
    why: 'the same slide on the phone form factor, `transition-duration` 260ms: §2’s spring stands over it as over the desktop’s 280 – flagged with it on W8-M1c'
  },
  '.zen-message-glyph-pop': {
    times: ['260ms'],
    kind: 'flagged',
    why: 'the toast glyph that reports a change just made (the star that filled), `zen-glyph-pop` 260ms once, scale .4 → 1.18 → 1: §1 names a glyph swap the state token and v2 §11 has no scale pop in the vocabulary, and no token stands at 260 – flagged on W8-M1c'
  },
  '.zen-dl-glyph-pulse': {
    times: ['260ms'],
    kind: 'flagged',
    why: 'the downloads button’s pulse as a transfer starts, `zen-dl-pulse` 260ms once, scale 1 → 1.14 → 1: a one-shot scale pulse v2 §11 does not have, at a number no mapping names – flagged on W8-M1c'
  },
  '.zen-dl-glyph-pulse::before': {
    times: ['260ms'],
    kind: 'flagged',
    why: 'the pulse’s fill behind the glyph, `zen-dl-pulse-fill` 260ms once (opacity 0 → 1 → 0): the pulse’s other half, flagged with it on W8-M1c'
  }
}

const css = readFileSync(resolve(__dirname, '../../assets/main.css'), 'utf8')

/** A time as digits, where it stands in a rule's text: `120ms`, `1.1s`, `20ms`. */
const LITERAL = /\b\d+(?:\.\d+)?m?s\b/g
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
/** The literal times left, by rule, in order, with the declarations that carry them. */
const found = new Map<string, { times: string[]; decls: string[] }>()
for (const leaf of all) {
  for (const decl of leaf.decls) {
    const face = FACE_DECL.exec(decl)
    if (face) {
      declared.set(leaf.where, { ...declared.get(leaf.where), [face[1]!]: `${face[2]}ms` })
      continue
    }
    const times = [...decl.matchAll(LITERAL)].map((m) => m[0])
    if (!times.length) continue
    const had = found.get(leaf.where) ?? { times: [], decls: [] }
    found.set(leaf.where, { times: [...had.times, ...times], decls: [...had.decls, decl] })
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
    // Every time literal is read, in ms or s, each whole: a 1120 is not a 120, a 1.1s is one time.
    expect('transition: opacity 120ms, transform 1120ms'.match(LITERAL)).toEqual([
      '120ms',
      '1120ms'
    ])
    expect('animation: zen-progress 1.1s var(--zen-ease) infinite'.match(LITERAL)).toEqual(['1.1s'])
    expect('animation-delay: calc(var(--zen-ntp-i, 0) * 20ms)'.match(LITERAL)).toEqual(['20ms'])
    expect('width: 36px; line-height: 1.75; --zen-fade-start: 24px'.match(LITERAL)).toBeNull()
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
    // and go (the panels, the sheet, the omnibox field, the drill-in, the hint bubble's in), the
    // message's on the two toasts' rise and the hint bubble's leave.
    expect(reads.state).toBeGreaterThan(100)
    expect(reads.pop).toBeGreaterThan(10)
    expect(reads.message).toBeGreaterThanOrEqual(3)
  })

  it('no time literal stands in a rule not listed here', () => {
    const unlisted = [...found]
      .filter(([where]) => !(where in LEFT))
      .map(([where, { times }]) => describeLeft(where, times))
    expect(unlisted).toEqual([])
  })

  it('the literals left are the listed ones, in the listed times, for the listed reasons', () => {
    const left = Object.fromEntries([...found].map(([w, { times }]) => [w, times]))
    const listed = Object.fromEntries(Object.entries(LEFT).map(([w, { times }]) => [w, times]))
    // The whole list on a mismatch, so the line to shrink or the literal to migrate is named.
    const detail = [...found].map(([w, { times }]) => describeLeft(w, times)).join('\n')
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

  it('a loop loops: every declaration listed as one repeats', () => {
    for (const [where, left] of Object.entries(LEFT)) {
      if (left.kind !== 'loop') continue
      for (const decl of found.get(where)!.decls) expect(decl, where).toMatch(/\binfinite\b/)
    }
  })

  it('a mapped number stays only as Android’s digits, a progress or a delay – never as a motion', () => {
    // The ten numbers §10 (a) maps are converted or Android's; a motion left for the lead is one
    // whose number no mapping names, else the sweep would have folded it.
    for (const [where, left] of Object.entries(LEFT)) {
      if (left.face || left.kind === 'progress' || left.kind === 'delay') continue
      if (left.kind === 'loop') continue
      for (const time of left.times) expect(MAPPED.has(time), `${where}: ${time}`).toBe(false)
    }
    // And the flagged are motions, not progress: a transition or an animation that runs once.
    for (const [where, left] of Object.entries(LEFT)) {
      if (left.kind !== 'flagged') continue
      for (const decl of found.get(where)!.decls) {
        expect(decl, where).toMatch(/^(transition(-duration)?|animation):/)
        expect(decl, where).not.toMatch(/\binfinite\b/)
      }
    }
  })
})
