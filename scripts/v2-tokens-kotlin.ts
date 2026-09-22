/**
 * Writes the Kotlin table of the design language v2 inks a native Android view draws with –
 * `android/app/src/main/kotlin/app/zen/chromium/V2Tokens.kt` – from the chrome's stylesheet
 * (`src/renderer/src/assets/main.css`), so the one native imitation of a chrome surface (the
 * page-unresponsive prompt, v2 §9.23) takes every colour from the values the CSS declares and
 * retypes none. The table is checked in; `v2-tokens-kotlin.test.ts` fails when it is stale, and
 * `V2TokensTest.kt` parses the same CSS on the JVM and fails when the two disagree.
 *
 *     node --experimental-strip-types --no-warnings scripts/v2-tokens-kotlin.ts
 *
 * What it reads, per theme (`:root` and `:root[data-theme='dark']` of the v2 token block, the
 * first `:root` blocks for the `--zen-danger` the block aliases): `--v2-panel`, `--v2-border`,
 * `--v2-text`, `--v2-text-deemphasized`, `--v2-fill`, `--v2-fill-hover`, `--zen-scrim-alpha`
 * (`--v2-scrim` is black at that alpha) and `--v2-danger`; and the chassis's grabber alpha from
 * `.zen-sheet-handle` (`rgb(var(--v2-text-rgb) / a)`), one value for both themes.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
export const REPO = path.resolve(here, '..')
export const CSS_PATH = path.join(REPO, 'src/renderer/src/assets/main.css')
export const KOTLIN_PATH = path.join(
  REPO,
  'android/app/src/main/kotlin/app/zen/chromium/V2Tokens.kt'
)

/** The inks one theme of the table carries, as `#aarrggbb` strings (Kotlin `Long` literals). */
export interface ThemeInks {
  panel: string
  border: string
  text: string
  textDeemphasized: string
  fill: string
  fillHover: string
  scrim: string
  danger: string
  /** `--zen-scrim-alpha`: the window's dim amount. */
  scrimAlpha: number
}

export interface Tokens {
  light: ThemeInks
  dark: ThemeInks
  /** `.zen-sheet-handle`'s alpha on the text ink. */
  handleAlpha: number
}

/** The declarations of the rule `selector { … }` whose body contains `marker`; the first such rule. */
function block(css: string, selector: string, marker: string): Map<string, string> {
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const pattern = new RegExp(
    `^${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([\\s\\S]*?)^\\}`,
    'gm'
  )
  for (const m of bare.matchAll(pattern)) {
    if (!m[1].includes(marker)) continue
    const out = new Map<string, string>()
    for (const line of m[1].split('\n')) {
      const d = /^\s*(--[\w-]+):\s*([^;]+);/.exec(line)
      if (d) out.set(d[1], d[2].trim())
    }
    return out
  }
  throw new Error(`no ${selector} block declaring ${marker} in main.css`)
}

/** A CSS colour – `#rrggbb`, `rgb(r g b)`, `rgb(r g b / a)` – as `#aarrggbb`. */
export function argb(value: string): string {
  const hex = /^#([0-9a-f]{6})$/i.exec(value)
  if (hex) return `#ff${hex[1].toLowerCase()}`
  const rgb = /^rgb\((\d+) (\d+) (\d+)(?: \/ ([\d.]+))?\)$/.exec(value)
  if (!rgb) throw new Error(`not a colour the table can carry: ${value}`)
  const a = rgb[4] === undefined ? 1 : Number(rgb[4])
  const byte = (n: number): string => Math.round(n).toString(16).padStart(2, '0')
  return `#${byte(a * 255)}${byte(Number(rgb[1]))}${byte(Number(rgb[2]))}${byte(Number(rgb[3]))}`
}

/** The alpha of a `rgb(… / a)` value. */
function alphaOf(value: string): number {
  const m = /\/ ([\d.]+)\)$/.exec(value)
  if (!m) throw new Error(`no alpha in ${value}`)
  return Number(m[1])
}

export function readTokens(css: string = fs.readFileSync(CSS_PATH, 'utf8')): Tokens {
  const theme = (dark: boolean): ThemeInks => {
    const selector = dark ? ":root[data-theme='dark']" : ':root'
    const v2 = block(css, selector, '--v2-page:')
    const v1 = block(css, selector, '--zen-danger:')
    const get = (map: Map<string, string>, name: string): string => {
      const value = map.get(name)
      if (!value) throw new Error(`${selector} declares no ${name}`)
      return value
    }
    const scrimAlpha = Number(get(v2, '--zen-scrim-alpha'))
    if (get(v2, '--v2-scrim') !== 'rgb(0 0 0 / var(--zen-scrim-alpha))')
      throw new Error(
        `--v2-scrim is no longer black at --zen-scrim-alpha: ${get(v2, '--v2-scrim')}`
      )
    // The alias stands on the light root alone; the dark root redeclares `--zen-danger`, which it follows.
    if (!dark && get(v2, '--v2-danger') !== 'var(--zen-danger)')
      throw new Error(`--v2-danger no longer aliases --zen-danger: ${get(v2, '--v2-danger')}`)
    return {
      panel: argb(get(v2, '--v2-panel')),
      border: argb(get(v2, '--v2-border')),
      text: argb(get(v2, '--v2-text')),
      textDeemphasized: argb(get(v2, '--v2-text-deemphasized')),
      fill: argb(get(v2, '--v2-fill')),
      fillHover: argb(get(v2, '--v2-fill-hover')),
      scrim: argb(`rgb(0 0 0 / ${scrimAlpha})`),
      danger: argb(get(v1, '--zen-danger')),
      scrimAlpha
    }
  }
  const handle =
    /\.zen-sheet-handle \{[^}]*background: (rgb\(var\(--v2-text-rgb\) \/ [\d.]+\));/.exec(
      css.replace(/\/\*[\s\S]*?\*\//g, '')
    )
  if (!handle) throw new Error('no .zen-sheet-handle background on the text ink in main.css')
  return { light: theme(false), dark: theme(true), handleAlpha: alphaOf(handle[1]) }
}

/** `#aarrggbb` as a Kotlin colour literal. */
function kotlinColor(argbHex: string): string {
  return `0x${argbHex.slice(1).toUpperCase()}.toInt()`
}

export function kotlinSource(tokens: Tokens = readTokens()): string {
  const theme = (name: string, t: ThemeInks): string =>
    `    val ${name} = Theme(
        panel = ${kotlinColor(t.panel)},
        border = ${kotlinColor(t.border)},
        text = ${kotlinColor(t.text)},
        textDeemphasized = ${kotlinColor(t.textDeemphasized)},
        fill = ${kotlinColor(t.fill)},
        fillHover = ${kotlinColor(t.fillHover)},
        scrim = ${kotlinColor(t.scrim)},
        danger = ${kotlinColor(t.danger)},
        scrimAlpha = ${t.scrimAlpha}f
    )`
  return `package app.zen.chromium

/**
 * GENERATED by \`scripts/v2-tokens-kotlin.ts\` from \`src/renderer/src/assets/main.css\` – do not edit;
 * run \`node --experimental-strip-types --no-warnings scripts/v2-tokens-kotlin.ts\` after the CSS.
 *
 * The design language v2 inks a native Android view draws with, as the chrome's stylesheet
 * declares them (the token block's \`:root\` and \`:root[data-theme='dark']\`), for the one chrome
 * surface the app imitates natively: the page-unresponsive prompt ([UnresponsivePrompt], v2
 * §9.23), raised while the renderer the chrome shares is hung. \`v2-tokens-kotlin.test.ts\` fails
 * when this file is stale against the CSS; \`V2TokensTest\` parses the CSS on the JVM and fails
 * when the two disagree, so no value here can drift from the sheet the chrome draws.
 */
object V2Tokens {
    /** One theme's inks, ARGB. */
    class Theme(
        /** \`--v2-panel\`: a panel, sheet or menu's fill. */
        val panel: Int,
        /** \`--v2-border\`: the 1 px hairline. */
        val border: Int,
        /** \`--v2-text\`. */
        val text: Int,
        /** \`--v2-text-deemphasized\`: the text at 69 %. */
        val textDeemphasized: Int,
        /** \`--v2-fill\`: the text at 10 %, a control's fill at rest. */
        val fill: Int,
        /** \`--v2-fill-hover\`: the text at 16 %, the control under a hover or a press. */
        val fillHover: Int,
        /** \`--v2-scrim\`: black at [scrimAlpha]. */
        val scrim: Int,
        /** \`--v2-danger\` (the chrome's \`--zen-danger\`): the destructive ink. */
        val danger: Int,
        /** \`--zen-scrim-alpha\`: the window's dim behind a sheet. */
        val scrimAlpha: Float
    )

${theme('light', tokens.light)}

${theme('dark', tokens.dark)}

    /** \`.zen-sheet-handle\`: the grabber's alpha on [Theme.text]. */
    const val HANDLE_ALPHA = ${tokens.handleAlpha}f

    fun of(dark: Boolean): Theme = if (dark) this.dark else light
}
`
}

function main(): void {
  const source = kotlinSource()
  const current = fs.existsSync(KOTLIN_PATH) ? fs.readFileSync(KOTLIN_PATH, 'utf8') : null
  if (current === source) {
    console.log(`up to date: ${path.relative(REPO, KOTLIN_PATH)}`)
    return
  }
  fs.writeFileSync(KOTLIN_PATH, source)
  console.log(`wrote ${path.relative(REPO, KOTLIN_PATH)}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
