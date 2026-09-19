import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

/**
 * The contract between the frame dialog host and a sheet that brings its own chassis (#168,
 * #192). On a phone the host (`FrameDialogHost`, lib/portals.tsx) is on the sheet chassis for the
 * dialogs that have none, and main.css cuts the pointer from every child of its slot while the
 * host is not up (`[data-sheet]:not([data-sheet-up]) .zen-frame-dialogs-slot >
 * :not([data-sheet-layer])`): at progress 0 a tap must fall to the scrim, not to a dialog that
 * has not risen. A sheet that draws the stack's one scrim itself (`useFrameDialog({ ownScrim:
 * true })`, `BottomSheet` placed `hosted`) keeps the host's chassis down for good, so the host
 * never raises `data-sheet-up` for it – and the cut stands for as long as the sheet is up. The
 * only thing that exempts the sheet is the mark on the SLOT'S CHILD: `data-sheet-layer`, which
 * `BottomSheet`'s own root carries. `pointer-events` is inherited, so a wrapper between the slot
 * and the `BottomSheet` without the mark makes the whole sheet transparent to a finger, whose tap
 * lands on the host's scrim, the dismissal (v0.3.42 to v0.3.45: every phone Settings picker and
 * sheet, while accessibility clicks and the keyboard, which meet no hit test, kept working).
 *
 * The rule, pinned here over the source: the element a component returns to the slot after
 * registering with `ownScrim` is the `BottomSheet` placed `hosted`, or it carries
 * `data-sheet-layer` itself. Static over the TypeScript AST rather than rendered, since mounting
 * each consumer needs its surface's state (an install prompt, a downloads list, the new tab
 * page's settings) and a wrapper is a shape of the source, not of the state; the shipped
 * stylesheet's hit test on a real render is `settings/__tests__/sheets.test.tsx`'s.
 */
const ROOT = fileURLToPath(new URL('../../', import.meta.url))

/**
 * Every component that registers a sheet of its own with the host today. A new one is added here
 * on purpose (and the check below applies to it); one that goes is removed.
 */
const OWN_SCRIM_CONSUMERS = [
  'components/downloads/DownloadsSheet.tsx',
  'components/newtab/CustomizeSheet.tsx',
  // The password manager's phone passphrase prompt, and its prompt and picker sheets (#92).
  'components/overlays/passwords/PassphrasePrompt.tsx',
  'components/overlays/passwords/shared.tsx',
  'components/pages/settings/sheets.tsx',
  'components/phone/InstallSheet.tsx',
  'components/phone/PhoneSheet.tsx',
  // The translate surfaces' phone sheets (#106): a language menulist's picker (over the bar or
  // the selection sheet) and the selection translation sheet.
  'components/translate/Menulist.tsx',
  'components/translate/SelectionPopover.tsx'
]

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

/** The `useFrameDialog({ … ownScrim: true … })` calls in a file, each with the function that makes it. */
function ownScrimRegistrations(source: ts.SourceFile): ts.SignatureDeclaration[] {
  const found: ts.SignatureDeclaration[] = []
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'useFrameDialog' &&
      node.arguments[0] &&
      ts.isObjectLiteralExpression(node.arguments[0]) &&
      node.arguments[0].properties.some(
        (p) =>
          ts.isPropertyAssignment(p) &&
          ts.isIdentifier(p.name) &&
          p.name.text === 'ownScrim' &&
          p.initializer.kind === ts.SyntaxKind.TrueKeyword
      )
    ) {
      const fn = enclosingFunction(node)
      if (fn) found.push(fn)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

function enclosingFunction(node: ts.Node): ts.SignatureDeclaration | null {
  let current: ts.Node | undefined = node.parent
  while (current) {
    if (
      ts.isFunctionDeclaration(current) ||
      ts.isFunctionExpression(current) ||
      ts.isArrowFunction(current)
    ) {
      return current
    }
    current = current.parent
  }
  return null
}

/** The JSX a function returns, every branch of a conditional, without descending into nested functions. */
function returnedJsx(fn: ts.SignatureDeclaration): ts.Expression[] {
  const roots: ts.Expression[] = []
  const collect = (expr: ts.Expression): void => {
    if (ts.isParenthesizedExpression(expr)) collect(expr.expression)
    else if (ts.isConditionalExpression(expr)) {
      collect(expr.whenTrue)
      collect(expr.whenFalse)
    } else if (
      ts.isBinaryExpression(expr) &&
      expr.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
    ) {
      collect(expr.right)
    } else if (!(expr.kind === ts.SyntaxKind.NullKeyword)) roots.push(expr)
  }
  const visit = (node: ts.Node): void => {
    if (
      node !== fn &&
      (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node))
    ) {
      return
    }
    if (ts.isReturnStatement(node) && node.expression) collect(node.expression)
    ts.forEachChild(node, visit)
  }
  if (ts.isArrowFunction(fn) && fn.body && !ts.isBlock(fn.body)) collect(fn.body)
  else visit(fn)
  return roots
}

function openingTag(expr: ts.Expression): ts.JsxOpeningLikeElement | null {
  if (ts.isJsxElement(expr)) return expr.openingElement
  if (ts.isJsxSelfClosingElement(expr)) return expr
  return null
}

function hasAttribute(tag: ts.JsxOpeningLikeElement, name: string): boolean {
  return tag.attributes.properties.some(
    (a) => ts.isJsxAttribute(a) && ts.isIdentifier(a.name) && a.name.text === name
  )
}

/** Why a returned root is not a layer on the sheet chassis; null when it is. */
function layerFault(expr: ts.Expression, source: ts.SourceFile): string | null {
  const tag = openingTag(expr)
  const line = source.getLineAndCharacterOfPosition(expr.getStart(source)).line + 1
  if (!tag) {
    return `line ${line}: returns ${ts.isJsxFragment(expr) ? 'a fragment' : 'no JSX element'} to the slot; the slot's child must be one element on the sheet chassis`
  }
  const name = tag.tagName.getText(source)
  if (name === 'BottomSheet') {
    return hasAttribute(tag, 'hosted')
      ? null
      : `line ${line}: <BottomSheet> in the frame dialog host must be placed \`hosted\``
  }
  return hasAttribute(tag, 'data-sheet-layer')
    ? null
    : `line ${line}: <${name}> is the slot's child around the sheet and carries no data-sheet-layer, so main.css's pointer cut takes the whole sheet (inherited pointer-events); a tap falls to the host's scrim`
}

describe('a sheet that brings its own chassis to the frame dialog host', () => {
  const files = sourceFiles(ROOT)
  const parsed = files.map((path) => ({
    path: relative(ROOT, path),
    source: ts.createSourceFile(
      path,
      readFileSync(path, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX
    )
  }))
  const consumers = parsed
    .map((file) => ({ ...file, registrations: ownScrimRegistrations(file.source) }))
    .filter((file) => file.registrations.length > 0)

  it('is one of the consumers listed here (add a new one on purpose)', () => {
    expect(consumers.map((c) => c.path).sort()).toEqual([...OWN_SCRIM_CONSUMERS].sort())
  })

  it('returns the slot a BottomSheet placed hosted, or an element marked data-sheet-layer', () => {
    const faults: string[] = []
    for (const { path, source, registrations } of consumers) {
      for (const fn of registrations) {
        const roots = returnedJsx(fn)
        if (roots.length === 0) faults.push(`${path}: the registering component returns no JSX`)
        for (const root of roots) {
          const fault = layerFault(root, source)
          if (fault) faults.push(`${path}: ${fault}`)
        }
      }
    }
    expect(faults).toEqual([])
  })

  it('is what main.css exempts from the pointer cut on the host at progress 0', () => {
    const css = readFileSync(join(ROOT, 'assets/main.css'), 'utf8').replace(/\s+/g, ' ')
    expect(css).toContain(
      '.zen-frame-dialogs[data-sheet]:not([data-sheet-up]) .zen-frame-dialogs-slot > :not([data-sheet-layer]) { pointer-events: none; }'
    )
  })
})

describe('the guard itself', () => {
  const fixture = (body: string): { source: ts.SourceFile; faults: string[] } => {
    const text = `
import { useFrameDialog } from '@renderer/lib/portals'
function Sheet(): JSX.Element {
  useFrameDialog({ onScrimPress: () => {}, ownScrim: true })
  ${body}
}
`
    const source = ts.createSourceFile(
      'fixture.tsx',
      text,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX
    )
    const faults: string[] = []
    for (const fn of ownScrimRegistrations(source)) {
      for (const root of returnedJsx(fn)) {
        const fault = layerFault(root, source)
        if (fault) faults.push(fault)
      }
    }
    return { source, faults }
  }

  it('passes a hosted BottomSheet and a marked wrapper', () => {
    expect(fixture('return <BottomSheet hosted />').faults).toEqual([])
    expect(
      fixture('return (<div data-sheet-layer="true"><BottomSheet hosted /></div>)').faults
    ).toEqual([])
    expect(fixture('return open ? <BottomSheet hosted /> : null').faults).toEqual([])
  })

  it('fails the wrapper #192 fixed, a BottomSheet not placed hosted, and a fragment', () => {
    expect(
      fixture('return (<div className="absolute inset-0"><BottomSheet hosted /></div>)').faults
    ).toEqual([
      expect.stringContaining(
        "<div> is the slot's child around the sheet and carries no data-sheet-layer"
      )
    ])
    expect(fixture('return <BottomSheet />').faults).toEqual([
      expect.stringContaining('must be placed `hosted`')
    ])
    expect(fixture('return (<><BottomSheet hosted /></>)').faults).toEqual([
      expect.stringContaining('returns a fragment')
    ])
  })

  it("reads through a nested function without taking its returns for the component's", () => {
    const { faults } = fixture(`
  const dismiss = (): void => { return }
  const label = (): JSX.Element => <span />
  return (<div data-sheet-layer="true">{label()}<BottomSheet hosted /></div>)`)
    expect(faults).toEqual([])
  })
})
