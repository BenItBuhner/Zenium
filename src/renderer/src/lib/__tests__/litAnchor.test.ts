import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The lit anchor (design language v2 §9.20): the pressed fill an icon button keeps while its
 * popover is up is the popover ANCHOR's – a control that says `aria-haspopup` and `aria-expanded`
 * together. `aria-expanded` alone is also WAI-ARIA's disclosure attribute (a control that folds
 * rows out: History's device twisty, a tree's branch), and a disclosure takes no fill at rest.
 * These tests pin the shared rule's scope, keep every disclosure from needing a local override
 * (#326's twisty rule went with the scoping), and audit the anchors: every control that opens a
 * popover, menu or dialog from the chrome carries `aria-haspopup` – the fix for an anchor that
 * lost its fill is the attribute, never a widened selector.
 */
const assets = fileURLToPath(new URL('../../assets/', import.meta.url))
const strip = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '')
const extensions = strip(readFileSync(join(assets, 'extensions.css'), 'utf8'))
const main = strip(readFileSync(join(assets, 'main.css'), 'utf8'))
const sheets = readdirSync(assets)
  .filter((f) => f.endsWith('.css'))
  .map((f) => [f, strip(readFileSync(join(assets, f), 'utf8'))] as const)

describe('the lit anchor (§9.20)', () => {
  it('is the popover anchor’s fill: the shared icon-button rule keys on aria-haspopup with aria-expanded', () => {
    expect(extensions).toMatch(
      /\.zen-v2-icon-button\[aria-haspopup\]\[aria-expanded='true'\] \{\s*background: var\(--v2-fill\);\s*\}/
    )
    // On a phone the anchor opens a sheet, not a popover: the same scope, no fill.
    expect(extensions).toMatch(
      /\[data-form-factor='phone'\] \.zen-v2-icon-button\[aria-haspopup\]\[aria-expanded='true'\] \{\s*background: transparent;\s*\}/
    )
  })

  it('lights no disclosure: no stylesheet fills an icon button on aria-expanded alone', () => {
    for (const [file, text] of sheets) {
      expect(text, file).not.toMatch(/\.zen-v2-icon-button\[aria-expanded='true'\]/)
    }
  })

  it('needs no local override for a disclosure: #326’s twisty rule is gone with the scoping', () => {
    expect(main).not.toMatch(/\.zen-page-heading-twisty\[aria-expanded='true'\]/)
    // The twisty keeps its 4 from the heading's text and nothing else of its own.
    expect(main).toMatch(
      /\.zen-page-heading > \.zen-page-heading-twisty \{\s*margin-inline-start: 4px;\s*\}/
    )
  })

  it('has every popover anchor say aria-haspopup, the tab picker’s Choose a tab included', () => {
    const components = fileURLToPath(new URL('../../components/', import.meta.url))
    const source = (path: string): string => readFileSync(join(components, path), 'utf8')
    // The anchors named by the audit, each with the popup it opens.
    const anchors: ReadonlyArray<[string, string, string]> = [
      ['app/AppTitleBar.tsx', 'data-zen-app-menu-button', 'menu'],
      ['media/MediaHubButton.tsx', 'data-zen-media-hub-button', 'dialog'],
      ['downloads/DownloadButton.tsx', 'data-zen-downloads-button', 'dialog'],
      ['extensions/ToolbarActions.tsx', 'zen-ext-puzzle', 'dialog'],
      ['bookmarks/BookmarksBar.tsx', 'data-bm-id={OVERFLOW_ANCHOR}', 'menu'],
      ['content/EmptyPane.tsx', 'data-pick-tab={tabId}', 'dialog']
    ]
    for (const [file, mark, popup] of anchors) {
      const text = source(file)
      const at = text.indexOf(mark)
      expect(at, `${file}: ${mark}`).toBeGreaterThan(0)
      const tag = openingTag(text, text.lastIndexOf('<button', at))
      expect(tag, `${file}: ${mark} opens a ${popup} and says so`).toMatch(
        new RegExp(`aria-haspopup=(?:"${popup}"|\\{[^}]*'${popup}'[^}]*\\})`)
      )
    }
  })
})

/** The JSX opening tag starting at `from`: up to the `>` outside every `{…}` that is not an arrow's. */
function openingTag(text: string, from: number): string {
  let depth = 0
  for (let i = from; i < text.length; i++) {
    const ch = text[i]
    if (ch === '{') depth++
    else if (ch === '}') depth--
    else if (ch === '>' && depth === 0 && text[i - 1] !== '=') return text.slice(from, i + 1)
  }
  return text.slice(from)
}
