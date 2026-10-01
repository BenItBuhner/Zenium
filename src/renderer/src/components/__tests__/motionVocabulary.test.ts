import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import {
  MOTION_CAP_MS,
  MOTION_MESSAGE_MS,
  MOTION_POP_MS,
  MOTION_STATE_MS,
  ZEN_EASE
} from '@renderer/lib/motion/tokens'

/*
 * One motion vocabulary (motion-and-interaction-spec §1, W8-M1): every duration, spring and
 * curve a surface moves by is one of `lib/motion/tokens.ts`'s – `MOTION_STATE_MS` 120,
 * `MOTION_POP_MS` 180, `MOTION_MESSAGE_MS` 200, `MOTION_CAP_MS` 300, the three springs, the one
 * curve – never a number written in the component. Pinned the way the tooltip vocabulary is
 * (`tooltipVocabulary.test.tsx`): the chrome's sources under `components/**` and `lib/motion/**`
 * are walked as syntax trees for a literal in a motion's seat, and the ones left are listed here
 * by file with their count and their reason – the debt by name. A new literal anywhere fails
 * here; a migrated one fails here too until its line below is shrunk or struck.
 *
 * What counts as a literal in a motion's seat (one finding each):
 *   css       a string holding a `<n>ms` time – a `transition` in a style object, an
 *             `el.style.transition = …` write, a shorthand kept in a constant – or a `<n>s` time
 *             in a `transition*` / `animation*` property. A template's `${MOTION_POP_MS}ms` is no
 *             finding: only the string's own text is read.
 *   curve     a string holding `cubic-bezier(` – the curve is `ZEN_EASE` / `var(--zen-ease)`.
 *   duration  a numeric `duration` / `delay` / `endDelay` in an object literal (the Web
 *             Animations API's options, a presenter's card) or a JSX attribute, or a bare number
 *             as `animate()`'s second argument; `0` is not a duration.
 *   named     a `*_MS` constant initialised with a token's value (120, 180, 200, 300): the token
 *             under another name. A `*_MS` of another value is a wait or a clock with a meaning
 *             of its own and is not read here.
 *   wait      `setTimeout(fn, n)` / `setInterval(fn, n)` with a numeric `n` of 1..1000 ms – a
 *             wait under a second paces a motion; longer is a clock with a token of its own
 *             (`TOAST_DURATION`, `TOAST_UNDO_MS`, `BAND_CLOCK_MS`).
 *   spring    an object literal written with a numeric `stiffness` or `damping` – a spring that
 *             is none of `SPRING_SNAPPY`, `SPRING_GENTLE`, `SPRING_FOLLOW`, nor spread from one.
 *
 * Out of the walk: `__tests__`, `lib/motion/tokens.ts` (the owner) and `lib/motion/spring.ts`
 * (`SPRING_STEP_CLAMP_MS`'s owner, re-exported by the tokens). The stylesheet's own `120ms` /
 * `180ms` (main.css), Tailwind's `duration-*` classes and the dock's own lift spring
 * (`lib/gestures/dock.ts`'s `SPRING_LIFT`) are outside `components/**` and `lib/motion/**`: the
 * wave report's debt, not this pin's.
 */

type Kind = 'css' | 'curve' | 'duration' | 'named' | 'wait' | 'spring'

interface Found {
  file: string
  line: number
  kind: Kind
  text: string
}

// `__dirname`, not `import.meta.url`, as the sibling pin does.
const SRC = resolve(__dirname, '../..')
const ROOTS = [resolve(SRC, 'components'), resolve(SRC, 'lib/motion')]

/** The owners of the numbers: the tokens module and the spring module it re-exports from. */
const OWNERS = new Set(['lib/motion/tokens.ts', 'lib/motion/spring.ts'])

/** The longest wait read as a motion's (ms); above it a `setTimeout` is a clock. */
const WAIT_CEILING_MS = 1000

const TOKEN_VALUES = new Set([MOTION_STATE_MS, MOTION_POP_MS, MOTION_MESSAGE_MS, MOTION_CAP_MS])

/** A millisecond time written in a string: `120ms`, `.3ms` – never `${x}ms`, which has no digit. */
const MS_IN_STRING = /\d(\.\d+)?ms(?![\w-])/
/** A second time written in a string: `0.2s`, `1s`. */
const S_IN_STRING = /(^|[\s,(])\d*\.?\d+s(?![\w-])/

/**
 * The literals left, by file (relative to `src/renderer/src`), each with its count and its
 * reason – the debt by name, a follow-up in the wave report. A new one anywhere else fails here;
 * one struck from its file fails here until its count is lowered.
 */
const LEFT: Record<string, { count: number; why: string }> = {
  // A keystroke debounce before the history is queried.
  'components/phone/PhoneHistoryPanel.tsx': { count: 1, why: 'an 80 ms debounce, not a motion' },
  // A Space row stepping between slots while another is held: 220 ms, no token's length.
  'components/phone/SpacesDrawer.tsx': {
    count: 1,
    why: 'a row’s 220 ms step between slots; the spring or the token for it is the lead’s call'
  },
  // Tailwind arbitrary values (`duration-[120ms]`) in class strings, which cannot read a TS
  // token: a `--zen-motion-state` custom property in main.css is the follow-up.
  'components/print/PreviewPane.tsx': {
    count: 1,
    why: 'a Tailwind `duration-[120ms]`; a stylesheet token is the follow-up'
  },
  'components/security/BlockedPopupsPanel.tsx': {
    count: 1,
    why: 'a Tailwind `duration-[120ms]`; a stylesheet token is the follow-up'
  },
  'components/siteControls/primitives.tsx': {
    count: 1,
    why: 'a Tailwind `duration-[120ms]`; a stylesheet token is the follow-up'
  },
  // Two `_MS` constants that happen to equal the cap and are not motions.
  'components/sidebar/TabItem.tsx': {
    count: 1,
    why: 'RENAME_FOCUS_GRACE_MS: a focus grace, not a motion; the number coincides with the cap'
  },
  'components/sidebar/useRailFlyout.ts': {
    count: 1,
    why: 'RAIL_FLYOUT_DWELL_MS: a pointer dwell, not a motion; the number coincides with the cap'
  }
}

function sources(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__') out.push(...sources(path))
    } else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) out.push(path)
  }
  return out
}

const rel = (file: string): string => relative(SRC, file).split('\\').join('/')

const MOTION_PROP = /^(transition|animation)/i
const DURATION_PROP = /^(duration|delay|endDelay)$/
const SPRING_PROP = /^(stiffness|damping)$/
const TIMER = /^(setTimeout|setInterval)$/

function propertyName(name: ts.PropertyName | ts.JsxAttributeName, source: ts.SourceFile): string {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name))
    return name.text
  return name.getText(source)
}

/** The literal text of a string or template, substitutions left out. */
function stringText(node: ts.Node): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  if (ts.isTemplateExpression(node))
    return [node.head.text, ...node.templateSpans.map((s) => s.literal.text)].join(' ')
  return null
}

/** A numeric literal's value (a unary minus kept), else null. */
function numberOf(node: ts.Node): number | null {
  if (ts.isNumericLiteral(node)) return Number(node.text)
  if (
    ts.isPrefixUnaryExpression(node) &&
    node.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(node.operand)
  )
    return -Number(node.operand.text)
  if (ts.isJsxExpression(node) && node.expression) return numberOf(node.expression)
  if (ts.isParenthesizedExpression(node)) return numberOf(node.expression)
  return null
}

/** The seat a value stands in: its property / attribute / assigned member name, else null. */
function seatOf(node: ts.Node, source: ts.SourceFile): string | null {
  let at: ts.Node = node
  while (
    at.parent &&
    (ts.isParenthesizedExpression(at.parent) ||
      ts.isJsxExpression(at.parent) ||
      ts.isTemplateSpan(at.parent) ||
      ts.isTemplateExpression(at.parent) ||
      ts.isConditionalExpression(at.parent) ||
      ts.isBinaryExpression(at.parent))
  )
    at = at.parent
  const parent = at.parent
  if (!parent) return null
  if (ts.isPropertyAssignment(parent)) return propertyName(parent.name, source)
  if (ts.isJsxAttribute(parent)) return propertyName(parent.name, source)
  if (
    ts.isBinaryExpression(parent) &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    ts.isPropertyAccessExpression(parent.left)
  )
    return parent.left.name.text
  if (
    ts.isCallExpression(parent) &&
    ts.isPropertyAccessExpression(parent.expression) &&
    parent.expression.name.text === 'setProperty' &&
    parent.arguments[1] === at &&
    ts.isStringLiteral(parent.arguments[0]!)
  )
    return parent.arguments[0].text
  return null
}

function findings(file: string): Found[] {
  const text = readFileSync(file, 'utf8')
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  )
  const found: Found[] = []
  const add = (node: ts.Node, kind: Kind): void => {
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source))
    found.push({
      file: rel(file),
      line: line + 1,
      kind,
      text: node.getText(source).replace(/\s+/g, ' ').slice(0, 72)
    })
  }

  const visit = (node: ts.Node): void => {
    // css / curve: the string's own text, wherever it stands.
    const str = stringText(node)
    if (str !== null) {
      const seat = seatOf(node, source)
      if (MS_IN_STRING.test(str) || (seat && MOTION_PROP.test(seat) && S_IN_STRING.test(str)))
        add(node, 'css')
      else if (str.includes('cubic-bezier(')) add(node, 'curve')
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression
      const name = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : ''
      // wait: setTimeout / setInterval / window.setTimeout with a literal delay in the motion range.
      if (TIMER.test(name) && node.arguments.length >= 2) {
        const ms = numberOf(node.arguments[1]!)
        if (ms !== null && ms > 0 && ms <= WAIT_CEILING_MS) add(node, 'wait')
      }
      // duration: el.animate(keyframes, 180)
      if (name === 'animate' && node.arguments.length >= 2) {
        const ms = numberOf(node.arguments[1]!)
        if (ms !== null && ms !== 0) add(node, 'duration')
      }
    }
    if (ts.isObjectLiteralExpression(node)) {
      let spring = false
      for (const prop of node.properties) {
        if (!ts.isPropertyAssignment(prop)) continue
        const name = propertyName(prop.name, source)
        // duration: { duration: 180 } – an animate() option, a card's clock
        if (DURATION_PROP.test(name)) {
          const n = numberOf(prop.initializer)
          if (n !== null && n !== 0) add(prop, 'duration')
        }
        if (SPRING_PROP.test(name) && numberOf(prop.initializer) !== null) spring = true
      }
      if (spring) add(node, 'spring')
    }
    if (ts.isJsxAttribute(node) && node.initializer) {
      const name = propertyName(node.name, source)
      if (DURATION_PROP.test(name)) {
        const n = numberOf(node.initializer)
        if (n !== null && n !== 0) add(node, 'duration')
      }
    }
    // named: const FOO_MS = 120
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      /MS$/.test(node.name.text) &&
      node.initializer
    ) {
      const n = numberOf(node.initializer)
      if (n !== null && TOKEN_VALUES.has(n)) add(node, 'named')
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

const files = ROOTS.flatMap(sources).filter((f) => !OWNERS.has(rel(f)))
const all = files.flatMap(findings)

const describeFound = (f: Found): string => `${f.file}:${f.line} [${f.kind}] ${f.text}`

describe('the chrome’s sources: one motion vocabulary (motion spec §1)', () => {
  it('the walk reaches the components and the motion library, and leaves the owners out', () => {
    const rels = files.map(rel)
    expect(rels).toContain('components/content/DefaultBrowserBanner.tsx')
    expect(rels).toContain('components/messages/useMessageMotion.ts')
    expect(rels).toContain('lib/motion/fade.ts')
    expect(rels).toContain('lib/motion/flip.ts')
    expect(rels).not.toContain('lib/motion/tokens.ts')
    expect(rels).not.toContain('lib/motion/spring.ts')
    expect(rels.some((r) => r.includes('__tests__'))).toBe(false)
  })

  it('the pin reads the vocabulary it guards from the tokens', () => {
    expect([...TOKEN_VALUES].sort((a, b) => a - b)).toEqual([120, 180, 200, 300])
    expect(ZEN_EASE).toMatch(/^cubic-bezier\(/)
    // The scanner's own tells, on the shapes it is for.
    expect(MS_IN_STRING.test('opacity 120ms var(--zen-ease)')).toBe(true)
    expect(MS_IN_STRING.test('opacity ms var(--zen-ease)')).toBe(false)
    expect(S_IN_STRING.test('opacity .2s ease')).toBe(true)
    expect(S_IN_STRING.test('Tabs')).toBe(false)
  })

  it('no literal duration, spring or curve stands in a file not listed here', () => {
    const unlisted = all.filter((f) => !(f.file in LEFT)).map(describeFound)
    expect(unlisted).toEqual([])
  })

  it('the literals left are the listed ones, in the listed counts, for the listed reasons', () => {
    const byFile = new Map<string, Found[]>()
    for (const f of all) byFile.set(f.file, [...(byFile.get(f.file) ?? []), f])
    const left = Object.fromEntries([...byFile].map(([file, list]) => [file, list.length]))
    const listed = Object.fromEntries(Object.entries(LEFT).map(([f, { count }]) => [f, count]))
    // The whole list on a mismatch, so the line to shrink or the literal to migrate is named.
    const detail = [...byFile.values()].flat().map(describeFound).join('\n')
    expect(left, detail).toEqual(listed)
    for (const [file, { why }] of Object.entries(LEFT))
      expect(why.length, `${file}: a reason`).toBeGreaterThan(0)
  })
})
