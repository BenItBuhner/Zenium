import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

/**
 * Where the recede's value goes, pinned over the source (PERF-2, #269). `--zen-recede` does not
 * inherit (main.css registers it `@property … inherits: false`: written on the root every frame
 * as an inherited property it had the whole chrome document's style recalculated every frame of
 * a sheet's motion), so a stylesheet rule reading `var(--zen-recede)` on an element sees the
 * property's initial 0 unless the element carries the value itself: its component registers it
 * (`useRecedeSurface(ref)` on the JSX element's `ref`, hooks/useRecedeSurface.ts), or it is
 * tagged `data-recede-surface` and found when a sheet registers (`lib/motion/recede.ts`).
 *
 * Neither side is listed here. The readers are what the stylesheets say – every rule under
 * assets/ whose body reads the value, by the class of its subject – and each is matched to the
 * JSX that renders that class, over the TypeScript AST of every component: the element carries
 * `data-recede-surface`, or a `ref` the same component passes to `useRecedeSurface`. A rule
 * with no element, an element without the hook, a hook on a ref no reader is on, a ref left
 * off the element (the hook does nothing on a null ref): each fails here with the file and the
 * line. Static rather than rendered, since mounting the content frame or the phone shell needs
 * the whole store; the hook's runtime is `hooks/__tests__/useRecedeSurface.test.tsx`'s, the
 * registry's `recede.test.ts`'s.
 */
const ROOT = fileURLToPath(new URL('../../', import.meta.url))

/** `var(--zen-recede,` or `var(--zen-recede)`: not `--zen-recede-gain`, which every element reads. */
const READ = /var\(--zen-recede\s*[,)]/

interface Reader {
  path: string
  selector: string
  /** The classes of the selector's subject (the element the value is read on). */
  classes: string[]
}

/** Every rule across the stylesheets whose body reads the value, one entry per selector of its list. */
function stylesheetReaders(): Reader[] {
  const out: Reader[] = []
  const dir = join(ROOT, 'assets')
  for (const name of readdirSync(dir)
    .filter((n) => n.endsWith('.css'))
    .sort()) {
    const text = readFileSync(join(dir, name), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    for (const [, selectorList, body] of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (!READ.test(body)) continue
      for (const raw of selectorList.split(',')) {
        const selector = raw.trim()
        if (!selector) continue
        const subject = selector.split(/\s*[>+~]\s*|\s+/).at(-1) ?? ''
        out.push({
          path: `assets/${name}`,
          selector,
          classes: [...subject.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((m) => m[1])
        })
      }
    }
  }
  return out
}

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__') out.push(...sourceFiles(path))
    } else if (entry.name.endsWith('.tsx') || entry.name.endsWith('.ts')) out.push(path)
  }
  return out
}

function parse(path: string): ts.SourceFile {
  return ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  )
}

/** The outermost function the node is written in: the component, not a callback inside it. */
function component(node: ts.Node): ts.Node | null {
  let found: ts.Node | null = null
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if (ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n)) {
      found = n
    }
  }
  return found
}

/** Every class token in the string literals under a node (a literal, `cn(…)`, a conditional, a template). */
function classTokens(node: ts.Node): string[] {
  const tokens: string[] = []
  const visit = (n: ts.Node): void => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
      tokens.push(...n.text.split(/\s+/).filter(Boolean))
    } else if (ts.isTemplateExpression(n)) {
      tokens.push(...n.head.text.split(/\s+/).filter(Boolean))
      for (const span of n.templateSpans)
        tokens.push(...span.literal.text.split(/\s+/).filter(Boolean))
    }
    ts.forEachChild(n, visit)
  }
  visit(node)
  return tokens
}

/** What a `ref` expression binds: the identifier itself, or the `x.current = el` targets of a callback. */
function boundRefs(expr: ts.Expression): string[] {
  if (ts.isIdentifier(expr)) return [expr.text]
  if (!ts.isArrowFunction(expr) && !ts.isFunctionExpression(expr)) return []
  const param = expr.parameters[0]?.name
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
    ) {
      out.push(n.left.expression.text)
    }
    ts.forEachChild(n, visit)
  }
  visit(expr.body)
  return out
}

function attribute(tag: ts.JsxOpeningLikeElement, name: string): ts.JsxAttribute | undefined {
  return tag.attributes.properties.find(
    (a): a is ts.JsxAttribute =>
      ts.isJsxAttribute(a) && ts.isIdentifier(a.name) && a.name.text === name
  )
}

interface Surface {
  line: number
  tag: string
  /** The reader classes on the element. */
  classes: string[]
  tagged: boolean
  /**
   * The identifiers the element's `ref` binds: the identifier passed as `ref`, or those a
   * callback ref assigns its element to (`ref={(el) => { barRef.current = el; other(el) }}`,
   * the shape for two bindings on one element). Empty with no `ref`, or one of another shape.
   */
  refs: string[]
  refText: string | null
  component: ts.Node | null
}

interface Registration {
  line: number
  ref: string
  component: ts.Node | null
}

interface Findings {
  surfaces: Surface[]
  registrations: Registration[]
  /** Lines where a source builds a calc reading the value itself (outside the stylesheets). */
  inlineReads: number[]
}

/** What one source file says: the elements rendering a reader class, the hook's calls, inline reads. */
function inspect(source: ts.SourceFile, readerClasses: ReadonlySet<string>): Findings {
  const surfaces: Surface[] = []
  const registrations: Registration[] = []
  const inlineReads: number[] = []
  const line = (n: ts.Node): number =>
    source.getLineAndCharacterOfPosition(n.getStart(source)).line + 1
  const visit = (node: ts.Node): void => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const className = attribute(node, 'className')
      const classes = className?.initializer
        ? [...new Set(classTokens(className.initializer).filter((t) => readerClasses.has(t)))]
        : []
      if (classes.length > 0) {
        const ref = attribute(node, 'ref')
        const expr =
          ref?.initializer && ts.isJsxExpression(ref.initializer)
            ? ref.initializer.expression
            : undefined
        surfaces.push({
          line: line(node),
          tag: node.tagName.getText(source),
          classes,
          tagged: attribute(node, 'data-recede-surface') !== undefined,
          refs: expr ? boundRefs(expr) : [],
          refText: expr ? expr.getText(source) : null,
          component: component(node)
        })
      }
    } else if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'useRecedeSurface'
    ) {
      const arg = node.arguments[0]
      registrations.push({
        line: line(node),
        ref: arg && ts.isIdentifier(arg) ? arg.text : (arg?.getText(source) ?? ''),
        component: component(node)
      })
    } else if (
      (ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isTemplateExpression(node)) &&
      READ.test(node.getText(source))
    ) {
      inlineReads.push(line(node))
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return { surfaces, registrations, inlineReads }
}

/** Every way a file breaks the pairing, each naming its line. */
function faults(path: string, { surfaces, registrations }: Findings): string[] {
  const out: string[] = []
  for (const s of surfaces) {
    const classes = s.classes.map((c) => `.${c}`).join(' ')
    if (s.tagged) continue
    if (s.refs.length === 0) {
      out.push(
        s.refText === null
          ? `${path}:${s.line}: <${s.tag} ${classes}> is read \`--zen-recede\` on and carries no ref: pass one to useRecedeSurface(ref), or tag the element data-recede-surface`
          : `${path}:${s.line}: <${s.tag} ${classes}> has ref={${s.refText}}: not an identifier the component passes to useRecedeSurface, nor a callback assigning its element to one (\`(el) => { ref.current = el; … }\`)`
      )
      continue
    }
    if (!registrations.some((r) => s.refs.includes(r.ref) && r.component === s.component)) {
      const ref = s.refs.join(' / ')
      out.push(
        `${path}:${s.line}: <${s.tag} ${classes}> is read \`--zen-recede\` on, and its ref \`${ref}\` is not registered: the component must call useRecedeSurface(${ref}), or the value on it is 0`
      )
    }
  }
  for (const r of registrations) {
    if (!surfaces.some((s) => s.refs.includes(r.ref) && s.component === r.component)) {
      out.push(
        `${path}:${r.line}: useRecedeSurface(${r.ref}) registers a ref that is on no element a stylesheet reads \`--zen-recede\` on (the ref is not on the element, or the rule's class is another): the hook writes to nothing`
      )
    }
  }
  return out
}

describe('the surfaces the stylesheets read --zen-recede on are the elements the components register', () => {
  const readers = stylesheetReaders()
  const readerClasses = new Set(readers.flatMap((r) => r.classes))
  const files = sourceFiles(ROOT).map((path) => ({
    path: relative(ROOT, path),
    source: parse(path)
  }))
  const findings = files.map((f) => ({ ...f, ...inspect(f.source, readerClasses) }))

  it('every reader names its element by a class (the value does not inherit; the subject is what is read)', () => {
    expect(readers.length).toBeGreaterThanOrEqual(4)
    expect(
      readers.filter((r) => r.classes.length === 0).map((r) => `${r.path}: ${r.selector}`)
    ).toEqual([])
  })

  it('every reader class is rendered by a component, and every such element registers or is tagged', () => {
    const rendered = new Set(findings.flatMap((f) => f.surfaces.flatMap((s) => s.classes)))
    const dead = readers
      .filter((r) => !r.classes.some((c) => rendered.has(c)))
      .map(
        (r) =>
          `${r.path}: \`${r.selector}\` reads --zen-recede on an element no component renders by that class: the rule reads 0 (or the element is not this tree's)`
      )
    expect(dead).toEqual([])
    expect(findings.flatMap((f) => faults(f.path, f))).toEqual([])
  })

  it('a calc reading the value in a source is the recede module\u2019s own (its consumers apply it to the registered bar)', () => {
    // `recedeFade` / `barFade` build the bar's fade; the shell puts the string on the phone bar's
    // own inline opacity (`PhoneShell.tsx`), an element that registers. Another source composing
    // `var(--zen-recede)` inline would read 0 on any other element: build it in the recede
    // module, and register the element it goes on.
    expect(findings.filter((f) => f.inlineReads.length > 0).map((f) => f.path)).toEqual([
      'lib/motion/recede.ts'
    ])
  })
})

describe('the guard itself', () => {
  const classes = new Set(['zen-content-frame', 'zen-phone-bar'])
  const check = (body: string): string[] => {
    const source = ts.createSourceFile(
      'fixture.tsx',
      `import { useRef } from 'react'\nimport { useRecedeSurface } from '@renderer/hooks/useRecedeSurface'\n${body}\n`,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX
    )
    return faults('fixture.tsx', inspect(source, classes))
  }

  it('passes a registered ref, a tagged element, a class composed through cn(), and a callback ref binding the element to the registered ref beside another binding', () => {
    expect(
      check(
        `function Frame() { const r = useRef(null); useRecedeSurface(r); return <div ref={r} className="zen-content-frame relative" /> }`
      )
    ).toEqual([])
    expect(
      check(`function Frame() { return <div data-recede-surface className="zen-content-frame" /> }`)
    ).toEqual([])
    expect(
      check(
        `function Bar({ lifted }) { const barRef = useRef(null); useRecedeSurface(barRef); return <nav ref={barRef} className={cn('zen-phone-bar absolute', lifted && 'zen-phone-bar-lifted')} /> }`
      )
    ).toEqual([])
    // `zen-phone-bar-row` is not the bar: a token, not a prefix.
    expect(check(`function Row() { return <div className="zen-phone-bar-row flex" /> }`)).toEqual(
      []
    )
    // Two bindings on one element (the bar that hides on scroll AND recedes, #270 with #269).
    expect(
      check(
        `function Bar() { const barRef = useRef(null); useRecedeSurface(barRef); const bindHide = useBarHideBinding(); return <nav ref={(el) => { barRef.current = el; bindHide(el) }} className="zen-phone-bar" /> }`
      )
    ).toEqual([])
  })

  it('fails an element without the hook, a hook on another ref, a ref left off the element, and a callback ref binding the element to no registered ref', () => {
    expect(
      check(
        `function Frame() { const r = useRef(null); return <div ref={r} className="zen-content-frame" /> }`
      )
    ).toEqual([expect.stringContaining('its ref `r` is not registered')])
    expect(
      check(
        `function Frame() { const r = useRef(null); const other = useRef(null); useRecedeSurface(other); return <div ref={r} className="zen-content-frame" /> }`
      )
    ).toEqual([
      expect.stringContaining('its ref `r` is not registered'),
      expect.stringContaining('useRecedeSurface(other) registers a ref that is on no element')
    ])
    expect(
      check(
        `function Frame() { const r = useRef(null); useRecedeSurface(r); return <div className="zen-content-frame" /> }`
      )
    ).toEqual([
      expect.stringContaining('carries no ref'),
      expect.stringContaining('useRecedeSurface(r) registers a ref that is on no element')
    ])
    expect(
      check(
        `function Frame() { const r = useRef(null); useRecedeSurface(r); return <div ref={(el) => bindHide(el)} className="zen-content-frame" /> }`
      )
    ).toEqual([
      expect.stringContaining('not an identifier the component passes to useRecedeSurface'),
      expect.stringContaining('useRecedeSurface(r) registers a ref that is on no element')
    ])
    // The hook in one component, the element in another: the pairing is per component.
    expect(
      check(
        `function A() { const r = useRef(null); useRecedeSurface(r); return null }\nfunction B() { const r = useRef(null); return <div ref={r} className="zen-content-frame" /> }`
      )
    ).toEqual([
      expect.stringContaining('fixture.tsx:4: <div .zen-content-frame>'),
      expect.stringContaining('fixture.tsx:3: useRecedeSurface(r)')
    ])
  })
})
