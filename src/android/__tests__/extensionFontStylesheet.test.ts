// @vitest-environment happy-dom
import { COMMON_SCRIPT, SCRIPT_CODES } from '@core/extensions/api/fontSettings'
import { describe, expect, it } from 'vitest'
import {
  FONT_LAYER_NAME,
  FONT_STYLE_ID,
  SCRIPT_LANGUAGE_TAGS,
  cssFamily,
  fontLayerStylesheet,
  fontStylesheetScript,
  scriptFace,
  unmappedScripts
} from '../extensionFontStylesheet'

/*
 * The `:lang()` approximation of Chrome's per-script font preferences on the WebView: the
 * script → language tag table, the stylesheet's rules and their order, and the script that puts
 * the stylesheet into a document (at document start, and replaced in place on a layer change).
 */

describe('the script → language tag table', () => {
  it('names Chrome script codes alone, never the common script, every tag once and well-formed', () => {
    const codes = new Set(SCRIPT_CODES)
    expect(SCRIPT_LANGUAGE_TAGS[COMMON_SCRIPT]).toBeUndefined()
    const seen = new Map<string, string>()
    for (const [code, tags] of Object.entries(SCRIPT_LANGUAGE_TAGS)) {
      expect(codes.has(code), code).toBe(true)
      for (const tag of tags) {
        expect(tag).toMatch(/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/)
        expect(seen.get(tag), `${tag} under ${code} and ${seen.get(tag)}`).toBeUndefined()
        seen.set(tag, code)
      }
    }
  })

  it("covers the proof's scripts and lists the codes it has no tag for", () => {
    expect(SCRIPT_LANGUAGE_TAGS.Jpan).toContain('ja')
    expect(SCRIPT_LANGUAGE_TAGS.Cyrl).toContain('ru')
    expect(SCRIPT_LANGUAGE_TAGS.Hans).toContain('zh-Hans')
    expect(SCRIPT_LANGUAGE_TAGS.Hant).toContain('zh-TW')
    const unmapped = unmappedScripts()
    expect(unmapped).toContain('Zmth')
    expect(unmapped).toContain('Zsym')
    expect(unmapped).not.toContain('Jpan')
    expect(unmapped).not.toContain(COMMON_SCRIPT)
    // Every Chrome script code is either mapped or listed.
    for (const code of SCRIPT_CODES) {
      if (code === COMMON_SCRIPT) continue
      const mapped = (SCRIPT_LANGUAGE_TAGS[code] ?? []).length > 0
      expect(mapped || unmapped.includes(code), code).toBe(true)
    }
  })
})

describe('scriptFace and cssFamily', () => {
  it('takes the standard family first, then the faces a page is likelier to leave unnamed', () => {
    expect(scriptFace({ serif: 'S', standard: 'D' })).toBe('D')
    expect(scriptFace({ serif: 'S', sansSerif: 'SS' })).toBe('SS')
    expect(scriptFace({ fixed: ' M ' })).toBe('M')
    expect(scriptFace({ math: 'X', fantasy: 'F' })).toBe('F')
    expect(scriptFace({})).toBeNull()
    expect(scriptFace({ standard: '  ' })).toBeNull()
  })

  it('quotes a family name and escapes what would end the string', () => {
    expect(cssFamily('Noto Sans JP')).toBe('"Noto Sans JP"')
    expect(cssFamily('A"b\\c\u0007d')).toBe('"A\\"b\\\\cd"')
    // A generic keyword stays a keyword; a family that merely contains one is a name.
    expect(cssFamily('sans-serif')).toBe('sans-serif')
    expect(cssFamily(' Monospace ')).toBe('monospace')
    expect(cssFamily('Noto Serif')).toBe('"Noto Serif"')
  })
})

describe('fontLayerStylesheet', () => {
  it('writes one rule per script the layer holds a face for, inside the named layer, and `math` for the math family', () => {
    const css = fontLayerStylesheet({
      families: { math: 'STIX Two Math', cursive: 'Comic Neue' },
      scripts: {
        Jpan: { standard: 'Noto Sans JP' },
        Cyrl: { sansSerif: 'PT Sans', serif: 'PT Serif' },
        [COMMON_SCRIPT]: { standard: 'Roboto' },
        Zmth: { standard: 'Latin Modern Math' }
      },
      sizes: {}
    })
    expect(css.startsWith(`@layer ${FONT_LAYER_NAME} {\n`)).toBe(true)
    expect(css.endsWith('\n}\n')).toBe(true)
    expect(css).toContain('*:lang(ja) { font-family: "Noto Sans JP"; }')
    // One face per script: the sans-serif over the serif without a standard.
    expect(css).toContain('*:lang(ru), *:lang(uk)')
    expect(css).toContain('font-family: "PT Sans"')
    expect(css).not.toContain('PT Serif')
    // The common script's families and the slotless cursive are WebSettings' own, not the sheet's.
    expect(css).not.toContain('Roboto')
    expect(css).not.toContain('Comic Neue')
    // A script with no language tag gets no rule.
    expect(css).not.toContain('Latin Modern Math')
    expect(css).toContain('math { font-family: "STIX Two Math"; }')
  })

  it('is empty for no layer, and for a layer with nothing the stylesheet carries', () => {
    expect(fontLayerStylesheet(null)).toBe('')
    expect(
      fontLayerStylesheet({
        families: { cursive: 'Comic Neue' },
        scripts: { [COMMON_SCRIPT]: { standard: 'Roboto' }, Zsym: { standard: 'Symbola' } },
        sizes: {}
      })
    ).toBe('')
    expect(fontLayerStylesheet({ families: { math: '  ' }, scripts: {}, sizes: {} })).toBe('')
  })

  it('puts a tag after the tag it extends whatever the two scripts are, so the more specific rule wins', () => {
    const css = fontLayerStylesheet({
      families: {},
      scripts: {
        Hani: { standard: 'Noto Sans CJK SC' },
        Hans: { standard: 'Noto Sans SC' },
        Hant: { standard: 'Noto Sans TC' },
        Jpan: { standard: 'Noto Sans JP' }
      },
      sizes: {}
    })
    const at = (selector: string): number => {
      const index = css.indexOf(selector)
      expect(index, selector).toBeGreaterThan(-1)
      return index
    }
    // `lang="zh-Hans"` matches `:lang(zh)` too: Hans's rule must be the later one.
    expect(at('*:lang(zh-Hans)')).toBeGreaterThan(at('*:lang(zh)'))
    expect(at('*:lang(zh-Hant)')).toBeGreaterThan(at('*:lang(zh)'))
    // …and Hant's `yue` before Hani's `yue-Hani` and Hans's `yue-Hans`: the cycle no whole-script order resolves.
    expect(at('*:lang(yue-Hani)')).toBeGreaterThan(at('*:lang(yue)'))
    expect(at('*:lang(yue-Hans)')).toBeGreaterThan(at('*:lang(yue)'))
    expect(at('*:lang(ja-Hani)')).toBeGreaterThan(at('*:lang(ja)'))
    // Every one-subtag rule precedes every two-subtag rule.
    const lines = css.split('\n').filter((line) => line.includes(':lang('))
    const lengths = lines.map((line) => {
      const tags = [...line.matchAll(/:lang\(([^)]+)\)/g)].map((m) => m[1].split('-').length)
      expect(new Set(tags).size, line).toBe(1)
      return tags[0]
    })
    expect(lengths).toEqual([...lengths].sort((a, b) => a - b))
  })
})

describe('fontStylesheetScript', () => {
  const run = (css: string): void => {
    // The script as `evaluateJavascript` runs it: a statement in the page's realm.
    new Function(fontStylesheetScript(css))()
  }
  const element = (): HTMLElement | null => document.getElementById(FONT_STYLE_ID)

  it('inserts one <style> into the head, replaces its text in place, and takes it out for an empty sheet', () => {
    document.documentElement.innerHTML = '<head><title>t</title></head><body><p>x</p></body>'
    run('@layer zen-ext-fonts {\n  *:lang(ja) { font-family: "A"; }\n}\n')
    const first = element()
    expect(first).not.toBeNull()
    expect(first?.tagName.toLowerCase()).toBe('style')
    expect(first?.parentElement).toBe(document.head)
    expect(first?.textContent).toContain('"A"')

    run('@layer zen-ext-fonts {\n  *:lang(ja) { font-family: "B"; }\n}\n')
    expect(document.querySelectorAll(`#${FONT_STYLE_ID}`)).toHaveLength(1)
    expect(element()).toBe(first)
    expect(element()?.textContent).toContain('"B"')

    run('')
    expect(element()).toBeNull()
    run('')
    expect(element()).toBeNull()
  })

  it('is one expression with no free reference beyond the document, and carries the css as a JSON string', () => {
    const script = fontStylesheetScript('a { font-family: "x\\y"; }\n')
    expect(script.startsWith('(() => {')).toBe(true)
    expect(script.endsWith('})();')).toBe(true)
    expect(script).toContain(JSON.stringify(FONT_STYLE_ID))
    expect(script).toContain(JSON.stringify('a { font-family: "x\\y"; }\n'))
    expect(script).not.toContain('console.')
  })
})
