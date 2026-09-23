// @vitest-environment happy-dom
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import ts from 'typescript'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../api', () => ({ cmd: vi.fn(async () => null), run: vi.fn() }))

import {
  FAKEBOX_PILL_VAR,
  FAKEBOX_VAR,
  fakeboxMorphStore,
  fakeboxScrolled,
  fakeboxScrubTravel,
  registerFakebox,
  registerFakeboxSurface
} from '../fakeboxMorph'

/*
 * Where the new tab page morph's values go (wave 5's `ntp-scrub-top`; the pattern of
 * `--zen-recede`, #269, and `--zen-bar-hide`, #270). `--zen-ntp-morph` and `--zen-ntp-pill` are
 * written every frame of the scroll scrub and of the spring; as inherited properties on the root
 * every one of those frames recalculated the whole chrome document's style – 12 to 13 ms of an
 * 18 to 20 ms scrub frame, 11 to 18 ms of every spring frame, on the emulator (the baseline
 * sweep's traces, run 35822500800). So main.css registers both `inherits: false`, and the
 * controller writes them on the root – the one readable pair, which the Android harness's probe
 * reads there (FakeboxMorphDemoBase.kt) – AND on each element a rule reads them on: the page's
 * field and column with the field's registration, the gear, the bar, the pill's slot and the
 * omnibox's sheet by their components (`useFakeboxSurface`), the double's box by its layer. What
 * reads them under one of those – the pill's words, the double's looks and contents – takes its
 * element's value by an explicit `inherit`. This pins the runtime of the registry, and over the
 * stylesheets that every reader is one of those cases; the hook's runtime is
 * `hooks/__tests__/useFakeboxSurface.test.tsx`'s.
 */

const ASSETS = resolve(__dirname, '../../assets')
const VARS = [FAKEBOX_VAR, FAKEBOX_PILL_VAR]
const root = (): HTMLElement => document.documentElement
const read = (el: HTMLElement, name: string): string => el.style.getPropertyValue(name)

function box(el: HTMLElement, x: number, y: number, width: number, height: number): void {
  Object.defineProperty(el, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ left: x, top: y, width, height, x, y, right: x + width, bottom: y + height })
  })
}

/** A new tab page's column and field as the page mounts them: the field 52 tall at 200 from the top. */
function mountPage(): { field: HTMLElement; column: HTMLElement; remove: () => void } {
  const column = document.createElement('div')
  column.className = 'zen-ntp-scroll zen-ntp-fades'
  const field = document.createElement('div')
  field.className = 'zen-ntp-field'
  column.appendChild(field)
  document.body.appendChild(column)
  box(field, 16, 200, 380, 52)
  return { field, column, remove: () => column.remove() }
}

function expectBare(el: HTMLElement, what: string): void {
  for (const name of VARS) expect(read(el, name), `${name} on ${what}`).toBe('')
}

function expectValues(el: HTMLElement, what: string, morph: string, pill: string): void {
  expect(read(el, FAKEBOX_VAR), `${FAKEBOX_VAR} on ${what}`).toBe(morph)
  expect(read(el, FAKEBOX_PILL_VAR), `${FAKEBOX_PILL_VAR} on ${what}`).toBe(pill)
}

describe('where the values go: the root and every registered surface', () => {
  const cleanups: Array<() => void> = []
  afterEach(() => {
    for (const c of cleanups.splice(0).reverse()) c()
    expectBare(root(), 'the root after the page left')
    expect(fakeboxMorphStore.get().tabId).toBeNull()
  })

  it('the page registering writes both values on the root, its field and its column at once, and its release takes them off', () => {
    const page = mountPage()
    cleanups.push(page.remove)
    expectBare(page.field, 'the field before the registration')
    const release = registerFakebox('t1', page.field, page.column)
    expectValues(root(), 'the root', '0.0000', '0.0000')
    expectValues(page.field, 'the field', '0.0000', '0.0000')
    expectValues(page.column, 'the column', '0.0000', '0.0000')
    release()
    expectBare(root(), 'the root')
    expectBare(page.field, 'the field')
    expectBare(page.column, 'the column')
  })

  it('the scrub moves the handover on the root and on every surface alike, a surface registered mid-scrub carries it at once, and a released one is left alone', () => {
    const page = mountPage()
    cleanups.push(page.remove)
    cleanups.push(registerFakebox('t2', page.field, page.column))
    const bar = document.createElement('nav')
    bar.className = 'zen-phone-bar'
    document.body.appendChild(bar)
    cleanups.push(() => bar.remove())
    const releaseBar = registerFakeboxSurface(bar)
    expectValues(bar, 'the bar at rest', '0.0000', '0.0000')
    // The handover runs over the scrub's last three tenths (FAKEBOX_PILL_LOOK_FROM): 85 % of
    // the travel is half way through it.
    const travel = fakeboxScrubTravel()!
    expect(travel).toBe(252)
    fakeboxScrolled(travel * 0.85)
    expect(fakeboxMorphStore.get().look).toBe('scrub')
    for (const [el, what] of [
      [root(), 'the root'],
      [page.field, 'the field'],
      [page.column, 'the column'],
      [bar, 'the bar']
    ] as Array<[HTMLElement, string]>) {
      expectValues(el, what, '0.0000', '0.5000')
    }
    // The pill's slot mounting part way through the scrub (the bar came back): the pose of the
    // moment on it before its first paint, not the property's 0 for a frame.
    const pill = document.createElement('div')
    pill.className = 'zen-phone-pill zen-pill-away'
    bar.appendChild(pill)
    const releasePill = registerFakeboxSurface(pill)
    expectValues(pill, 'the pill on registering', '0.0000', '0.5000')
    releaseBar()
    expectBare(bar, 'the bar once released')
    fakeboxScrolled(travel)
    expect(fakeboxMorphStore.get().look).toBe('docked')
    expectValues(root(), 'the root docked', '0.0000', '1.0000')
    expectValues(pill, 'the pill docked', '0.0000', '1.0000')
    expectValues(page.field, 'the field docked', '0.0000', '1.0000')
    expectBare(bar, 'the bar after a write it is not part of')
    releasePill()
    expectBare(pill, 'the pill once released')
  })

  it('a surface registered with no page carries nothing, takes the values when a page registers, and is bare again when it leaves', () => {
    const sheet = document.createElement('div')
    sheet.className = 'zen-omnibox-sheet'
    document.body.appendChild(sheet)
    cleanups.push(() => sheet.remove())
    const releaseSheet = registerFakeboxSurface(sheet)
    cleanups.push(releaseSheet)
    expectBare(sheet, 'the sheet with no page')
    expectBare(root(), 'the root with no page')
    const page = mountPage()
    cleanups.push(page.remove)
    const release = registerFakebox('t3', page.field, page.column)
    expectValues(sheet, 'the sheet under a page', '0.0000', '0.0000')
    release()
    expectBare(sheet, 'the sheet after the page left')
  })
})

describe('the readers (the stylesheets) and the writer (the controller)', () => {
  const sheets = readdirSync(ASSETS)
    .filter((n) => n.endsWith('.css'))
    .sort()
    .map((n) => ({ name: n, css: readFileSync(join(ASSETS, n), 'utf8') }))
  const main = sheets.find((s) => s.name === 'main.css')!.css
  const folded = main.replace(/\s+/g, ' ')
  const READ = /var\(--zen-ntp-(morph|pill)\s*[,)]/g

  /** The elements the controller or a component writes the values on, by the class a rule names them by. */
  const CARRIERS = [
    // The field and its column: `registerFakebox` registers both (lib/fakeboxMorph.ts).
    'zen-ntp-field',
    // The column and the gear (NewTabPage.tsx, `useFakeboxSurface`).
    'zen-ntp-fades',
    // The bar and the pill's slot (PhoneShell.tsx).
    'zen-phone-bar',
    'zen-phone-pill',
    // The omnibox's sheet (Urlbar.tsx's PhoneSheet).
    'zen-omnibox-sheet',
    // The double's box: its layer writes both values on it (FakeboxMorphLayer.tsx).
    'zen-fakebox'
  ]

  it('both values are registered non-inheriting with an initial 0, once each', () => {
    for (const name of VARS) {
      expect(folded).toContain(
        `@property ${name} { syntax: '<number>'; inherits: false; initial-value: 0; }`
      )
      expect(folded.match(new RegExp(`@property ${name} `, 'g'))).toHaveLength(1)
    }
  })

  it('every rule reading a value has its subject on a carrier, or takes the value by an explicit inherit from one', () => {
    const readers: Array<{ sheet: string; selector: string; body: string }> = []
    for (const { name, css } of sheets) {
      const text = css.replace(/\/\*[\s\S]*?\*\//g, '')
      for (const [, selectorList, body] of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        if (![...body.matchAll(READ)].length) continue
        for (const raw of selectorList.split(',')) {
          const selector = raw.replace(/\s+/g, ' ').trim()
          if (selector) readers.push({ sheet: name, selector, body: body.replace(/\s+/g, ' ') })
        }
      }
    }
    expect(readers.length).toBeGreaterThan(10)
    const onCarrier = (compound: string): boolean =>
      CARRIERS.some((c) => new RegExp(`\\.${c}(?![\\w-])`).test(compound))
    // The double's parts (`.zen-fakebox-*`, all rendered inside the box by the layer) take the
    // box's values by the one rule over its subtree.
    const BOX_SUBTREE =
      ":root[data-form-factor='phone'] .zen-fakebox * { --zen-ntp-morph: inherit; --zen-ntp-pill: inherit; }"
    for (const { sheet, selector, body } of readers) {
      const label = `${sheet}: ${selector}`
      expect(selector, `${label} reads on the root`).not.toMatch(/^:root(\[[^\]]*\])*$/)
      const compounds = selector.split(/\s*[>+~]\s*|\s+/)
      const subject = compounds.at(-1)!
      if (onCarrier(subject)) continue
      // Not a carrier itself: a descendant of one, taking by name each value it reads – the
      // pill's words under the pill, the double's looks and contents under the box.
      const part = /\.zen-fakebox-[\w-]+/.test(subject)
      const under = part || compounds.slice(0, -1).some(onCarrier)
      expect(under, `${label}: the subject is on no carrier and under none`).toBe(true)
      const inherits = (name: string): boolean =>
        body.includes(`${name}: inherit`) || (part && folded.includes(BOX_SUBTREE))
      for (const [, which] of body.matchAll(READ)) {
        const name = `--zen-ntp-${which}`
        expect(
          inherits(name),
          `${label}: reads ${name} under a carrier without inheriting it`
        ).toBe(true)
      }
    }
  })

  it('the controller writes the root and the surfaces from one place, and the layer writes the double’s box', () => {
    const controller = readFileSync(resolve(__dirname, '../fakeboxMorph.ts'), 'utf8')
    expect(controller).toContain('registerFakeboxSurface(field)')
    expect(controller).toContain('registerFakeboxSurface(scroller)')
    expect(controller.match(/setProperty\(FAKEBOX_VAR/g)).toHaveLength(1)
    expect(controller.match(/setProperty\(FAKEBOX_PILL_VAR/g)).toHaveLength(1)
    const layer = readFileSync(
      resolve(__dirname, '../../components/newtab/FakeboxMorphLayer.tsx'),
      'utf8'
    )
    for (const name of VARS) expect(layer).toContain(`box.style.setProperty('${name}'`)
    // The harness contract: the Android probe reads both values on the root's computed style.
    const probe = readFileSync(
      resolve(
        __dirname,
        '../../../../../android/app/src/androidTest/kotlin/app/zen/chromium/FakeboxMorphDemoBase.kt'
      ),
      'utf8'
    )
    expect(probe).toContain('getComputedStyle(document.documentElement)')
    for (const name of VARS) expect(probe).toContain(`getPropertyValue('${name}')`)
  })
})

/*
 * The components' side: each element a rule reads the values on by a class of the components'
 * – the bar, the pill's slot, the omnibox's sheet, the gear (the field and the column are the
 * controller's, the box the layer's) – carries a `ref` its component passes to
 * `useFakeboxSurface`, an identifier or a callback assigning the element to it (`(el) => {
 * barRef.current = el; … }`, inline or through `useCallback`: the bar's shape, with its other
 * bindings); and each call of the hook is on such an element. The pairing is per component.
 */
const COMPONENTS = resolve(__dirname, '../../components')
/**
 * The readers' subjects by the class tokens an element must render, all of them: the pill's
 * slot reads only as the well (`.zen-phone-pill.zen-pill-away`; the carried pill's ghost is a
 * `.zen-phone-pill` that never is). The column (`.zen-ntp-scroll.zen-ntp-fades`) is the
 * controller's, registered with the field, and is not looked for here.
 */
const HOOK_READERS: Record<string, string[]> = {
  bar: ['zen-phone-bar'],
  pill: ['zen-phone-pill', 'zen-pill-away'],
  sheet: ['zen-omnibox-sheet'],
  gear: ['zen-ntp-fades']
}

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__') out.push(...sourceFiles(path))
    } else if (entry.name.endsWith('.tsx')) out.push(path)
  }
  return out
}

/** The outermost function the node is written in: the component. */
function componentOf(node: ts.Node): ts.Node | null {
  let found: ts.Node | null = null
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if (ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n))
      found = n
  }
  return found
}

/** Every class token in the string literals under a node (a literal, `cn(…)`, a conditional). */
function classTokens(node: ts.Node): string[] {
  const tokens: string[] = []
  const visit = (n: ts.Node): void => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n))
      tokens.push(...n.text.split(/\s+/).filter(Boolean))
    ts.forEachChild(n, visit)
  }
  visit(node)
  return tokens
}

/** The `x.current = <param>` targets in a callback's body. */
function assignedRefs(fn: ts.ArrowFunction | ts.FunctionExpression): string[] {
  const param = fn.parameters[0]?.name
  if (!param || !ts.isIdentifier(param)) return []
  const out: string[] = []
  const visit = (n: ts.Node): void => {
    if (
      ts.isBinaryExpression(n) &&
      n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(n.left) &&
      n.left.name.text === 'current' &&
      ts.isIdentifier(n.left.expression) &&
      ts.isIdentifier(n.right) &&
      n.right.text === param.text
    )
      out.push(n.left.expression.text)
    ts.forEachChild(n, visit)
  }
  visit(fn.body)
  return out
}

/** `const name = (el) => …` or `const name = useCallback((el) => …, deps)` under the scope. */
function declaredCallback(
  scope: ts.Node,
  name: string
): ts.ArrowFunction | ts.FunctionExpression | null {
  let found: ts.ArrowFunction | ts.FunctionExpression | null = null
  const visit = (n: ts.Node): void => {
    if (found) return
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name) {
      let init = n.initializer
      if (
        init &&
        ts.isCallExpression(init) &&
        ts.isIdentifier(init.expression) &&
        init.expression.text === 'useCallback'
      )
        init = init.arguments[0]
      if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) found = init
      return
    }
    ts.forEachChild(n, visit)
  }
  visit(scope)
  return found
}

/** What a `ref` expression binds: the identifier, or the refs a callback assigns the element to. */
function boundRefs(expr: ts.Expression, scope: ts.Node | null): string[] {
  if (ts.isIdentifier(expr)) {
    const declared = scope ? declaredCallback(scope, expr.text) : null
    return declared ? assignedRefs(declared) : [expr.text]
  }
  return ts.isArrowFunction(expr) || ts.isFunctionExpression(expr) ? assignedRefs(expr) : []
}

interface Element {
  line: number
  classes: string[]
  refs: string[]
  refText: string | null
  component: ts.Node | null
}
interface Call {
  line: number
  ref: string
  component: ts.Node | null
}

function inspect(path: string): { elements: Element[]; calls: Call[] } {
  const source = ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  )
  const line = (n: ts.Node): number =>
    source.getLineAndCharacterOfPosition(n.getStart(source)).line + 1
  const elements: Element[] = []
  const calls: Call[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const attr = (name: string): ts.JsxAttribute | undefined =>
        node.attributes.properties.find(
          (a): a is ts.JsxAttribute =>
            ts.isJsxAttribute(a) && ts.isIdentifier(a.name) && a.name.text === name
        )
      const className = attr('className')?.initializer
      const tokens = className ? classTokens(className) : []
      const classes = tokens.includes('zen-ntp-scroll')
        ? []
        : Object.keys(HOOK_READERS).filter((r) =>
            HOOK_READERS[r]!.every((token) => tokens.includes(token))
          )
      if (classes.length > 0) {
        const ref = attr('ref')?.initializer
        const expr = ref && ts.isJsxExpression(ref) ? ref.expression : undefined
        const scope = componentOf(node)
        elements.push({
          line: line(node),
          classes,
          refs: expr ? boundRefs(expr, scope) : [],
          refText: expr ? expr.getText(source) : null,
          component: scope
        })
      }
    } else if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'useFakeboxSurface'
    ) {
      const arg = node.arguments[0]
      calls.push({
        line: line(node),
        ref: arg && ts.isIdentifier(arg) ? arg.text : (arg?.getText(source) ?? ''),
        component: componentOf(node)
      })
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return { elements, calls }
}

describe('the components register the elements the stylesheets read the values on', () => {
  const files = sourceFiles(COMPONENTS).map((path) => ({
    path: relative(COMPONENTS, path),
    ...inspect(path)
  }))

  it('every element by one of the classes carries a ref its component passes to useFakeboxSurface, and every call is on one', () => {
    const faults: string[] = []
    for (const { path, elements, calls } of files) {
      for (const el of elements) {
        const classes = el.classes
          .map((r) => HOOK_READERS[r]!.map((c) => `.${c}`).join(''))
          .join(' ')
        if (el.refs.length === 0) {
          faults.push(
            el.refText === null
              ? `${path}:${el.line}: <${classes}> carries no ref: pass one to useFakeboxSurface(ref), or the values on it are 0`
              : `${path}:${el.line}: <${classes}> has ref={${el.refText}}: not an identifier passed to useFakeboxSurface, nor a callback assigning the element to one`
          )
        } else if (!calls.some((c) => el.refs.includes(c.ref) && c.component === el.component)) {
          faults.push(
            `${path}:${el.line}: <${classes}> ref \`${el.refs.join(' / ')}\` is not registered: the component must call useFakeboxSurface on it`
          )
        }
      }
      for (const c of calls) {
        if (!elements.some((el) => el.refs.includes(c.ref) && el.component === c.component))
          faults.push(
            `${path}:${c.line}: useFakeboxSurface(${c.ref}) registers a ref on no element a rule reads the values on`
          )
      }
    }
    expect(faults).toEqual([])
    // The four: the bar and the pill (PhoneShell), the sheet (Urlbar), the gear (NewTabPage).
    const registered = files.flatMap((f) =>
      f.elements.filter((el) => el.refs.length > 0).flatMap((el) => el.classes)
    )
    expect(new Set(registered)).toEqual(new Set(Object.keys(HOOK_READERS)))
    expect(files.flatMap((f) => f.calls)).toHaveLength(4)
  })
})
