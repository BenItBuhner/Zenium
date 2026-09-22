package app.zen.chromium

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File

/**
 * The token pin (design language v2 §9.23's native line): what the app draws natively reads the
 * chrome's v2 token block and never a number of its own. `colors.xml`'s `v2_*` colours are the
 * stylesheet's values under both themes – this test resolves every token from main.css (its
 * `var()` chains, `rgb(r g b / a)` alphas and `color-mix()`es included) and fails on a value
 * that differs, on a `v2_*` colour that pins no token, and on a pinned token with no colour –
 * and [PromptSheetSpec]'s numbers are the tokens' and the sheet rules' they are named after.
 * A re-tune happens in the CSS; the failure here says which native copy to bring along.
 */
class V2TokensPinTest {
    private val root = repoRoot()
    private val css = Css(File(root, "src/renderer/src/assets/main.css").readText())
    private val colors = File(root, "android/app/src/main/res/values/colors.xml").readText()
    private val themes = File(root, "android/app/src/main/res/values/themes.xml").readText()

    /** `colors.xml`'s `v2_<name>_<light|dark>` and the token each copies. */
    private val pins = mapOf(
        "window" to "--v2-sidebar-neutral",
        "page" to "--v2-page",
        "panel" to "--v2-panel",
        "border" to "--v2-border",
        "text" to "--v2-text",
        "scrim" to "--v2-scrim",
        "accent" to "--v2-accent",
        "on_accent" to "--v2-on-accent",
        "danger" to "--v2-danger"
    )

    @Test
    fun everyV2ColourIsItsTokenValueInBothThemes() {
        val declared = Regex("""<color name="v2_([a-z_]+)_(light|dark)">(#[0-9A-Fa-f]{6}|#[0-9A-Fa-f]{8})</color>""")
            .findAll(colors)
            .map { Triple(it.groupValues[1], it.groupValues[2], it.groupValues[3]) }
            .toList()
        assertTrue("colors.xml declares v2_* colours", declared.isNotEmpty())
        for ((name, theme, _) in declared) {
            if (name !in pins) fail("colors.xml declares v2_${name}_$theme, a colour no token pins: add it to the pins with the token it copies, or draw the token")
        }
        for ((name, token) in pins) for (theme in listOf("light", "dark")) {
            val hex = declared.firstOrNull { it.first == name && it.second == theme }?.third
                ?: error("colors.xml declares no v2_${name}_$theme for $token")
            val expected = css.color(token, dark = theme == "dark")
            assertEquals("v2_${name}_$theme copies $token in the $theme block", argb(expected), normalise(hex))
        }
    }

    @Test
    fun theSheetDimIsTheScrimAlpha() {
        val light = Regex("""<style name="ThemeOverlay\.Zen\.Sheet" [^>]*>([\s\S]*?)</style>""").find(themes)!!.groupValues[1]
        val dark = Regex("""<style name="ThemeOverlay\.Zen\.Sheet\.Dark">([\s\S]*?)</style>""").find(themes)!!.groupValues[1]
        val dim = Regex("""<item name="android:backgroundDimAmount">([\d.]+)</item>""")
        assertEquals(css.value("--zen-scrim-alpha", dark = false).toFloat(), dim.find(light)!!.groupValues[1].toFloat(), 0f)
        assertEquals(css.value("--zen-scrim-alpha", dark = true).toFloat(), dim.find(dark)!!.groupValues[1].toFloat(), 0f)
        assertEquals(PromptSheetSpec.SCRIM_ALPHA_LIGHT, css.value("--zen-scrim-alpha", dark = false).toFloat(), 0f)
        assertEquals(PromptSheetSpec.SCRIM_ALPHA_DARK, css.value("--zen-scrim-alpha", dark = true).toFloat(), 0f)
        // The scrim itself is black at that alpha, in both blocks.
        assertEquals("--v2-scrim light", "#66000000", argb(css.color("--v2-scrim", dark = false)))
        assertEquals("--v2-scrim dark", "#8C000000", argb(css.color("--v2-scrim", dark = true)))
    }

    @Test
    fun theSpecNumbersAreTheTokens() {
        assertEquals(css.px("--v2-radius-sheet"), PromptSheetSpec.SHEET_RADIUS_DP)
        assertEquals(css.px("--v2-control", css.phone), PromptSheetSpec.CONTROL_DP)
        assertEquals(css.px("--v2-radius-control", css.coarse), PromptSheetSpec.CONTROL_RADIUS_DP)
        assertEquals(css.px("--v2-checkbox", css.phone), PromptSheetSpec.CHECKBOX_DP)
        assertEquals(css.px("--v2-radius-checkbox"), PromptSheetSpec.CHECKBOX_RADIUS_DP)
        assertEquals(css.px("--v2-font-heading"), PromptSheetSpec.TITLE_SP)
        assertEquals(css.px("--v2-line-heading"), PromptSheetSpec.TITLE_LINE_SP)
        assertEquals(css.weight("--v2-weight-heading"), PromptSheetSpec.TITLE_WEIGHT)
        assertEquals(css.px("--v2-font-body"), PromptSheetSpec.BODY_SP)
        assertEquals(css.px("--v2-line-body"), PromptSheetSpec.BODY_LINE_SP)
        assertEquals(css.weight("--v2-weight-button"), PromptSheetSpec.BUTTON_WEIGHT)
        // The inks a token derives from the text: the alpha each states.
        assertEquals(css.alpha("--v2-text-deemphasized"), PromptSheetSpec.DEEMPHASIZED_ALPHA, 0f)
        assertEquals(css.alpha("--v2-fill"), PromptSheetSpec.FILL_ALPHA, 0f)
        assertEquals(css.alpha("--v2-fill-hover"), PromptSheetSpec.FILL_PRESSED_ALPHA, 0f)
        // The phone row (§9.21): the body line box plus 24, so 44 at the default size, 12 above and below.
        val row = Regex("""calc\(var\(--v2-line-body-box\) \+ (\d+)px\)""").find(css.phone["--v2-row"]!!)!!.groupValues[1].toInt()
        assertEquals(PromptSheetSpec.BODY_LINE_SP + row, PromptSheetSpec.ROW_MIN_DP)
        assertEquals(row / 2, PromptSheetSpec.ROW_PAD_DP)
    }

    @Test
    fun theSpecNumbersAreTheSheetRules() {
        // §9.9: the grabber (`.zen-sheet-handle`) in its strip (`.zen-sheet-handle-hit`: 44 tall, pulled back 24).
        val handle = css.rule(".zen-sheet-handle")
        assertEquals(PromptSheetSpec.GRABBER_WIDTH_DP, px(handle, "width"))
        assertEquals(PromptSheetSpec.GRABBER_HEIGHT_DP, px(handle, "height"))
        assertEquals(PromptSheetSpec.GRABBER_RADIUS_DP, px(handle, "border-radius"))
        assertEquals(PromptSheetSpec.GRABBER_ALPHA, alphaOf(declaration(handle, "background")), 0f)
        val hit = css.rule(".zen-sheet-handle-hit")
        assertEquals(PromptSheetSpec.GRABBER_TOP_DP, px(hit, "padding-top"))
        val margin = Regex("""margin: 0 auto (-?\d+)px;""").find(hit)!!.groupValues[1].toInt()
        assertEquals(PromptSheetSpec.GRIP_STRIP_DP, px(hit, "height") + margin)
        // §9.23: the title block's padding and its gap to the description.
        val block = css.rule(".zen-sheet-title-block")
        assertEquals(PromptSheetSpec.BLOCK_PADDING_DP, px(block, "padding"))
        assertEquals(PromptSheetSpec.DESCRIPTION_GAP_DP, px(block, "gap"))
        // §9.11: the footer's padding and the peers' gap.
        val footer = css.rule(".zen-sheet-footer")
        assertEquals(PromptSheetSpec.PEER_GAP_DP, px(footer, "gap"))
        assertEquals("${PromptSheetSpec.FOOTER_TOP_DP}px ${PromptSheetSpec.GUTTER_DP}px ${PromptSheetSpec.FOOTER_BOTTOM_DP}px", declaration(footer, "padding"))
        // §6: the button's floor, its sides, its press fade, the primary's pressed mix.
        val button = css.rule(".zen-v2-button")
        assertEquals(PromptSheetSpec.BUTTON_MIN_WIDTH_DP, px(button, "min-width"))
        assertEquals("0 ${PromptSheetSpec.BUTTON_PADDING_DP}px", declaration(button, "padding"))
        assertTrue(button.contains("background ${PromptSheetSpec.PRESS_FADE_MS}ms"))
        val pressed = css.rule(".zen-v2-button[data-primary]:active:not(:disabled)")
        val mix = Regex("""color-mix\(in srgb, var\(--v2-on-accent\) (\d+)%, var\(--v2-accent\)\)""").find(pressed)!!.groupValues[1].toInt()
        assertEquals(PromptSheetSpec.ACCENT_PRESSED_MIX, mix / 100f, 0f)
        // §9.12: the field's sides. §9.14: the checkbox's edge at rest, the mark's inset.
        assertEquals("0 ${PromptSheetSpec.FIELD_PADDING_DP}px", declaration(css.rule(".zen-v2-field"), "padding"))
        val checkbox = css.rule(".zen-v2-checkbox")
        assertEquals(PromptSheetSpec.CHECKBOX_BORDER_ALPHA, alphaOf(declaration(checkbox, "border")), 0f)
        assertTrue(css.text.contains("width: calc(var(--v2-checkbox) - ${2 * PromptSheetSpec.CHECK_MARK_INSET_DP}px);"))
        assertEquals(PromptSheetSpec.ROW_GAP_DP, px(css.rule(".zen-v2-row"), "gap"))
        // §11.3: the fade the chassis grants a native imitation, and the room kept above an expanded sheet.
        assertTrue(css.text.contains("transition: opacity ${PromptSheetSpec.FADE_MS}ms var(--zen-ease) !important;"))
        for (anim in listOf("prompt_sheet_in", "prompt_sheet_out")) {
            val xml = File(root, "android/app/src/main/res/anim/$anim.xml").readText()
            assertTrue(anim, xml.contains("android:duration=\"${PromptSheetSpec.FADE_MS}\""))
        }
        val sheet = File(root, "src/renderer/src/lib/motion/sheet.ts").readText()
        assertEquals(PromptSheetSpec.SHEET_TOP_MARGIN_DP, Regex("""export const SHEET_TOP_MARGIN = (\d+)""").find(sheet)!!.groupValues[1].toInt())
    }

    // --- the stylesheet, read ------------------------------------------------------------------

    /** main.css: its top-level `:root` blocks by theme, its rules, and the values they resolve to. */
    private class Css(val text: String) {
        private val bare = text.replace(Regex("""/\*[\s\S]*?\*/"""), "")

        /** The declarations of every top-level `selector {` block, in order, a later one winning. */
        private fun declarations(selector: String): Map<String, String> {
            val out = LinkedHashMap<String, String>()
            val open = "\n$selector {\n"
            var at = bare.indexOf(open)
            while (at >= 0) {
                val end = bare.indexOf("\n}", at)
                for (m in Regex("""^\s*(--[a-z0-9-]+):\s*([^;]+);""", RegexOption.MULTILINE).findAll(bare.substring(at + open.length, end)))
                    out[m.groupValues[1]] = m.groupValues[2].trim()
                at = bare.indexOf(open, end)
            }
            return out
        }

        val light = declarations(":root")
        val dark = declarations(":root[data-theme='dark']")
        val phone = declarations(":root[data-form-factor='phone']")
        val coarse = declarations(":root[data-pointer='coarse']")

        /** A token's value in force under a theme, its `var()`s resolved under the same theme. */
        fun value(name: String, dark: Boolean, from: Map<String, String>? = null): String {
            val raw = from?.get(name) ?: (if (dark) this.dark[name] else null) ?: light[name] ?: error("main.css declares no $name")
            return resolve(raw, dark)
        }

        private fun resolve(value: String, dark: Boolean): String {
            var out = value
            for (round in 0 until 8) {
                val m = Regex("""var\((--[a-z0-9-]+)(?:,\s*([^()]*))?\)""").find(out) ?: return out
                val name = m.groupValues[1]
                val inner = (if (dark) this.dark[name] else null) ?: light[name] ?: m.groupValues[2].ifEmpty { error("main.css declares no $name (read by $value)") }
                out = out.replaceRange(m.range, inner)
            }
            error("$value does not resolve")
        }

        fun color(name: String, dark: Boolean): Int = parseColor(value(name, dark))

        /** A length token's px, from the block given (the light block by default). */
        fun px(name: String, from: Map<String, String> = light): Int =
            Regex("""^(\d+)px$""").find(from[name] ?: error("main.css declares no $name"))?.groupValues?.get(1)?.toInt() ?: error("$name is not a px length: ${from[name]}")

        /** A weight token's base: `min(900, calc(600 + var(--zen-font-weight-adjustment)))` is 600. */
        fun weight(name: String): Int =
            Regex("""calc\((\d+) \+ var\(--zen-font-weight-adjustment\)\)""").find(light[name]!!)!!.groupValues[1].toInt()

        /** The alpha a colour token states, `rgb(r g b / a)`. */
        fun alpha(name: String): Float = alphaOf(value(name, dark = false))

        /** The body of the first rule whose whole selector line is `selector`, at any indentation. */
        fun rule(selector: String): String {
            val m = Regex("""^[ \t]*${Regex.escape(selector)} \{""", RegexOption.MULTILINE).find(bare) ?: error("main.css has no rule $selector")
            return bare.substring(m.range.last + 1, bare.indexOf('}', m.range.last))
        }
    }

    private companion object {
        fun repoRoot(): File {
            var dir: File? = File(System.getProperty("user.dir")).absoluteFile
            while (dir != null) {
                if (File(dir, "package.json").isFile && File(dir, "android").isDirectory) return dir
                dir = dir.parentFile
            }
            error("not inside the repository")
        }

        /** `#AARRGGBB` for a colour, uppercase. */
        fun argb(color: Int): String = "#%08X".format(color)

        /** colors.xml's `#RRGGBB` or `#AARRGGBB` as `#AARRGGBB`. */
        fun normalise(hex: String): String = if (hex.length == 7) "#FF" + hex.substring(1).uppercase() else hex.uppercase()

        /** The declaration `property: value;` of a rule body. */
        fun declaration(rule: String, property: String): String =
            Regex("""(?m)^\s*${Regex.escape(property)}:\s*([^;]+);""").find(rule)?.groupValues?.get(1)?.trim() ?: error("no $property in $rule")

        fun px(rule: String, property: String): Int = declaration(rule, property).removeSuffix("px").toInt()

        /** The alpha of the first `rgb(… / a)` in a value – `0.25`, or `25%` – its channels a `var()` or not. */
        fun alphaOf(value: String): Float {
            val m = Regex("""rgba?\((?:[^()]|\([^()]*\))*/\s*([\d.]+)(%?)\)""").find(value) ?: error("no alpha in $value")
            return m.groupValues[1].toFloat() / if (m.groupValues[2] == "%") 100f else 1f
        }

        /**
         * A resolved CSS colour as ARGB: `#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb(r g b / a)`,
         * `rgb(r, g, b)` and `color-mix(in srgb, a p%, b [q%])` (the two weights normalised, the
         * second defaulting to the rest of 100 %, as the spec has it), alphas rounded as `rgb()`'s are.
         */
        fun parseColor(value: String): Int {
            val v = value.trim()
            Regex("""^color-mix\(in srgb,\s*(.+?)\s+([\d.]+)%\s*,\s*(.+?)(?:\s+([\d.]+)%)?\s*\)$""").find(v)?.let { m ->
                val p1 = m.groupValues[2].toFloat()
                val p2 = m.groupValues[4].ifEmpty { null }?.toFloat() ?: (100f - p1)
                val (w1, w2) = (p1 / (p1 + p2)) to (p2 / (p1 + p2))
                val a = parseColor(m.groupValues[1])
                val b = parseColor(m.groupValues[3])
                fun mix(shift: Int): Int = Math.round(((a shr shift) and 0xFF) * w1 + ((b shr shift) and 0xFF) * w2)
                return (mix(24) shl 24) or (mix(16) shl 16) or (mix(8) shl 8) or mix(0)
            }
            Regex("""^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)\s*(?:[/,]\s*([\d.]+)(%?))?\s*\)$""").find(v)?.let { m ->
                val alpha = m.groupValues[4].ifEmpty { null }?.let { it.toFloat() / if (m.groupValues[5] == "%") 100f else 1f } ?: 1f
                return (Math.round(alpha * 255) shl 24) or (m.groupValues[1].toInt() shl 16) or (m.groupValues[2].toInt() shl 8) or m.groupValues[3].toInt()
            }
            Regex("""^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$""").find(v)?.let { m ->
                val hex = m.groupValues[1].let { if (it.length == 3) it.map { c -> "$c$c" }.joinToString("") else it }
                val rgb = hex.substring(0, 6).toLong(16).toInt()
                val alpha = if (hex.length == 8) hex.substring(6).toInt(16) else 0xFF
                return (alpha shl 24) or rgb
            }
            error("not a colour: $value")
        }
    }
}
