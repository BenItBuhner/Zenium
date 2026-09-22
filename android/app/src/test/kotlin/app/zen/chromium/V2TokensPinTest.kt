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

    /**
     * What `themes.xml` draws of the sheet: the corners Material rounds are the sheet's radius (the
     * hairline's arcs follow the same constant), and the field's overlay hands the platform the v2
     * accent for the cursor and the handles, in each theme.
     */
    @Test
    fun theSheetThemesDrawTheTokens() {
        val shape = Regex("""<style name="ShapeAppearance\.Zen\.Sheet" [^>]*>([\s\S]*?)</style>""").find(themes)!!.groupValues[1]
        for (corner in listOf("cornerSizeTopLeft", "cornerSizeTopRight"))
            assertEquals("$corner is the sheet's radius", "${PromptSheetSpec.SHEET_RADIUS_DP}dp", Regex("""<item name="$corner">([^<]+)</item>""").find(shape)!!.groupValues[1])
        for (corner in listOf("cornerSizeBottomLeft", "cornerSizeBottomRight"))
            assertEquals("$corner: edge to edge at the bottom", "0dp", Regex("""<item name="$corner">([^<]+)</item>""").find(shape)!!.groupValues[1])
        for ((style, theme) in listOf("ThemeOverlay\\.Zen\\.PromptField" to "light", "ThemeOverlay\\.Zen\\.PromptField\\.Dark" to "dark")) {
            val overlay = Regex("""<style name="$style"[^>]*>([\s\S]*?)</style>""").find(themes)!!.groupValues[1]
            for (attr in listOf("android:colorControlActivated", "colorControlActivated"))
                assertEquals("$attr under the $theme field overlay is the v2 accent", "@color/v2_accent_$theme", Regex("""<item name="$attr">([^<]+)</item>""").find(overlay)!!.groupValues[1])
        }
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
        assertEquals(css.weight("--v2-weight-body"), PromptSheetSpec.BODY_WEIGHT)
        assertEquals(css.weight("--v2-weight-button"), PromptSheetSpec.BUTTON_WEIGHT)
        // The inks a token derives from the text, in both blocks (the dark block restates them): the
        // alpha each states, and the colour it comes to – `--v2-text` at that alpha, as V2Ink derives it.
        for (dark in listOf(false, true)) {
            val block = if (dark) "dark" else "light"
            val text = css.color("--v2-text", dark)
            for ((token, fraction) in listOf(
                "--v2-text-deemphasized" to PromptSheetSpec.DEEMPHASIZED_ALPHA,
                "--v2-fill" to PromptSheetSpec.FILL_ALPHA,
                "--v2-fill-hover" to PromptSheetSpec.FILL_PRESSED_ALPHA
            )) {
                assertEquals("$token in the $block block states the fraction", fraction, css.alpha(token, dark), 0f)
                assertEquals("$token in the $block block is --v2-text at the fraction", argb(css.color(token, dark)), argb(V2Ink.alpha(text, fraction)))
            }
            // §9.6: the selection is the accent at 30 % – `color-mix(in srgb, var(--v2-accent) 30%, transparent)`.
            assertEquals("--v2-selection in the $block block is --v2-accent at the fraction", argb(css.color("--v2-selection", dark)), argb(V2Ink.alpha(css.color("--v2-accent", dark), PromptSheetSpec.SELECTION_ALPHA)))
        }
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
        // §9.23: the title block's padding – its 16 to the body, body copy's 16 to what it introduces – and its gap to the description.
        val block = css.rule(".zen-sheet-title-block")
        assertEquals(PromptSheetSpec.BLOCK_PADDING_DP, px(block, "padding"))
        assertEquals(PromptSheetSpec.BODY_GAP_DP, px(block, "padding"))
        assertEquals(PromptSheetSpec.DESCRIPTION_GAP_DP, px(block, "gap"))
        // The glyph's 8 to the title (`.zen-sheet-title-block h2`'s gap).
        assertEquals(PromptSheetSpec.GLYPH_GAP_DP, px(css.rule(".zen-sheet-title-block h2"), "gap"))
        // `.zen-sheet-scroll`: the body scrolls without a scrollbar and without the ends' glow.
        val scroll = css.rule(".zen-sheet-scroll")
        assertEquals("contain", declaration(scroll, "overscroll-behavior"))
        assertEquals("none", declaration(scroll, "scrollbar-width"))
        // The hairline: `.zen-sheet`'s 1 CSS px border – a dp – round the top and the sides, none along the
        // bottom (`border-bottom: 0`); the same px on a field's and a checkbox's edge.
        val sheetRule = css.rule(".zen-sheet")
        assertEquals("${PromptSheetSpec.HAIRLINE_DP}px solid var(--v2-border)", declaration(sheetRule, "border"))
        assertEquals("the sheet meets the screen's edge without a hairline", "0", declaration(sheetRule, "border-bottom"))
        assertEquals("${PromptSheetSpec.HAIRLINE_DP}px solid var(--v2-border)", declaration(css.rule(".zen-v2-field"), "border"))
        assertTrue(declaration(css.rule(".zen-v2-checkbox"), "border").startsWith("${PromptSheetSpec.HAIRLINE_DP}px solid "))
        // §9.7: the hairline under a scrolled title block – the border ink, the same dp, on the grip's 120 ms.
        assertTrue(css.text.contains("box-shadow: 0 ${PromptSheetSpec.HAIRLINE_DP}px 0 var(--v2-border);"))
        assertTrue(css.rule(".zen-sheet-grip").contains("transition: box-shadow ${PromptSheetSpec.HAIRLINE_FADE_MS}ms var(--zen-ease);"))
        // §9.7 in the native chassis: its two dividers are one rule on the body scroller's state – the
        // block's line while content has scrolled under it, the footer's mirror while content remains
        // beneath (the platform's `canScrollVertically`, read on every scroll and layout) – each a
        // `Hairline` at [PromptSheetSpec.hairlinePx] in the border ink on the same 120 ms, a body that
        // fits drawing neither. (The web chassis fades the body's end instead – `BottomSheet.tsx`'s
        // `useFadeEdges`, `edges: 'end'` – the line its footer owes when it takes §9.7's amendment.)
        val chassis = File(root, "android/app/src/main/kotlin/app/zen/chromium/NativePromptSheet.kt").readText()
        val lines = Regex("""val scroller = BodyScroller \{ scroller ->\s*underBlock\.show\(scroller\.canScrollVertically\(-1\)\)\s*overFooter\.show\(scroller\.canScrollVertically\(1\)\)\s*\}""")
        assertTrue("both dividers read the scroller's state, the block's at -1 and the footer's at 1", lines.containsMatchIn(chassis))
        for (edge in listOf("underBlock" to "Gravity.TOP", "overFooter" to "Gravity.BOTTOM"))
            assertTrue("${edge.first} is a hairline over the body's edge", chassis.contains("frame.addView(${edge.first}, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, hairline, ${edge.second}))"))
        val hairlineView = Regex("""private inner class Hairline : View\(context\) \{([\s\S]*?)\n    \}""").find(chassis)?.groupValues?.get(1) ?: error("NativePromptSheet.kt has no Hairline view")
        assertTrue("the lines are the border ink", hairlineView.contains("setBackgroundColor(ink.border)"))
        assertTrue("the lines come and go on the hairline's fade", hairlineView.contains("setDuration(PromptSheetSpec.HAIRLINE_FADE_MS.toLong())"))
        val scroller = Regex("""private inner class BodyScroller\(([\s\S]*?)\n    \}""").find(chassis)?.groupValues?.get(1) ?: error("NativePromptSheet.kt has no BodyScroller")
        for (hook in listOf("onScrollChanged", "onLayout"))
            assertTrue("the scroller reports its edges after $hook", scroller.contains("override fun $hook(") && scroller.contains("onEdges(this)"))
        assertEquals("the hairline is one dp on this chassis, as the chrome's 1 CSS px", "private val hairline = PromptSheetSpec.hairlinePx(density)", Regex("""private val hairline = [^\n]+""").find(chassis)!!.value)
        // §9.12: the label 4 above its field (`.zen-bm-label`, the one §9.12 label rule in main.css).
        assertEquals(PromptSheetSpec.LABEL_GAP_DP, px(css.rule(".zen-bm-label"), "gap"))
        // §9.11 / §9.25: the footer's 16 above the peers, the peers' gap, the gutter at its sides;
        // its bottom is §9.25's formula, pinned in theFooterStandsSixteenAboveTheHostsInset.
        val footer = css.rule(".zen-sheet-footer")
        assertEquals(PromptSheetSpec.PEER_GAP_DP, px(footer, "gap"))
        val footerPadding = Regex("""^(\d+)px (\d+)px (\d+)px$""").find(declaration(footer, "padding"))!!.groupValues.drop(1).map { it.toInt() }
        assertEquals(PromptSheetSpec.FOOTER_TOP_DP, footerPadding[0])
        assertEquals(PromptSheetSpec.GUTTER_DP, footerPadding[1])
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

    /**
     * The hairline is one dp on the device, in whole pixels: the chrome's `1px` border is a CSS px,
     * one dp; a physical pixel would be 0.57 dp at 1.75x. Rounded at the density, never under one.
     */
    @Test
    fun theHairlineIsOneDpInWholePixels() {
        assertEquals(1, PromptSheetSpec.HAIRLINE_DP)
        assertEquals("1x (mdpi)", 1, PromptSheetSpec.hairlinePx(1f))
        assertEquals("1.5x (hdpi)", 2, PromptSheetSpec.hairlinePx(1.5f))
        assertEquals("1.75x (W4-5's run-2 device)", 2, PromptSheetSpec.hairlinePx(1.75f))
        assertEquals("2x (xhdpi)", 2, PromptSheetSpec.hairlinePx(2f))
        assertEquals("2.625x (Pixel 6 / the CI emulator's 420 dpi)", 3, PromptSheetSpec.hairlinePx(2.625f))
        assertEquals("under 1x: the floor of one pixel", 1, PromptSheetSpec.hairlinePx(0.75f))
    }

    /**
     * §9.25's formula, not the CSS as it stands: the footer's buttons stand 16 above the host's
     * safe-area inset – the gutter plus the inset the host reports, with its three hosts: 16 where
     * it reports none (the preview host), 40 over a 24 dp gesture bar, 64 over a 48 dp three-button
     * bar. The one native constant is the gutter; the Material sheet pads the inset under it.
     *
     * KNOWN DRIFT, the web chassis's: `.zen-sheet-footer` stands 8 over `BottomSheet.tsx`'s
     * `Math.max(8, insets.bottom)` – `8 + max(8, inset)`, the inset in place of the 8 floor rather
     * than added to the 16 – equal to the formula only where the host reports none (16) and 8
     * short over a real inset (32 over a 24 bar). Android primitives pass 4 corrects that line; the
     * drift assertions below fail when it lands, and this pin flips to equality with the CSS then.
     */
    @Test
    fun theFooterStandsSixteenAboveTheHostsInset() {
        assertEquals("the footer's bottom is the gutter", PromptSheetSpec.GUTTER_DP, PromptSheetSpec.FOOTER_BOTTOM_DP)
        for ((inset, edge) in listOf(0 to 16, 24 to 40, 48 to 64)) {
            assertEquals("inset $inset: §9.25's 16 + inset", edge, PromptSheetSpec.footerToEdge(PromptSheetSpec.FOOTER_BOTTOM_DP, inset))
        }
        // The web chassis as it stands, read from the CSS and BottomSheet.tsx.
        val footer = css.rule(".zen-sheet-footer")
        val cssPadding = Regex("""^(\d+)px (\d+)px (\d+)px$""").find(declaration(footer, "padding"))!!.groupValues[3].toInt()
        val bottomSheet = File(root, "src/renderer/src/components/sheet/BottomSheet.tsx").readText()
        val cssFloor = Regex("""paddingBottom: Math\.max\((\d+), insets\.bottom\)""").find(bottomSheet)?.groupValues?.get(1)?.toInt()
            ?: error("BottomSheet.tsx no longer pads Math.max(floor, insets.bottom): primitives pass 4 has landed – flip this pin to equality with the CSS")
        val web = { inset: Int -> cssPadding + maxOf(cssFloor, inset) }
        assertEquals("known drift: the web chassis's 8 over an 8 floor", 8 to 8, cssPadding to cssFloor)
        assertEquals("no inset: the web chassis meets the formula", PromptSheetSpec.footerToEdge(PromptSheetSpec.FOOTER_BOTTOM_DP, 0), web(0))
        assertEquals("a 24 bar: the web chassis 8 short – primitives pass 4's line", PromptSheetSpec.footerToEdge(PromptSheetSpec.FOOTER_BOTTOM_DP, 24) - 8, web(24))
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

        /** The alpha a colour token states, `rgb(r g b / a)`, under a theme. */
        fun alpha(name: String, dark: Boolean = false): Float = alphaOf(value(name, dark))

        /** The body of the first rule whose whole selector line is `selector`, at any indentation. */
        fun rule(selector: String): String {
            val m = Regex("""^[ \t]*${Regex.escape(selector)} \{""", RegexOption.MULTILINE).find(bare) ?: error("main.css has no rule $selector")
            return bare.substring(m.range.last + 1, bare.indexOf('}', m.range.last))
        }
    }

    private companion object {
        fun repoRoot(): File {
            var dir: File? = File(System.getProperty("user.dir") ?: ".").absoluteFile
            while (dir != null) {
                if (File(dir, "package.json").isFile && File(dir, "android").isDirectory) return dir
                dir = dir.parentFile
            }
            error("not inside the repository")
        }

        /** `#AARRGGBB` for a colour, uppercase. */
        fun argb(color: Int): String = "#%08X".format(color)

        /** A comma-separated list split at the commas outside any parentheses. */
        fun splitTopLevel(list: String): List<String> {
            val out = ArrayList<String>()
            var depth = 0
            var start = 0
            for ((i, c) in list.withIndex()) when (c) {
                '(' -> depth++
                ')' -> depth--
                ',' -> if (depth == 0) { out.add(list.substring(start, i)); start = i + 1 }
            }
            out.add(list.substring(start))
            return out
        }

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
         * `rgb(r, g, b)`, `transparent` and `color-mix(in srgb, a p%, b [q%])` (the two weights
         * normalised, the second defaulting to the rest of 100 %; the channels mixed premultiplied, as
         * the spec has it, so a mix towards `transparent` keeps the colour and thins its alpha),
         * alphas rounded as `rgb()`'s are.
         */
        fun parseColor(value: String): Int {
            val v = value.trim()
            if (v == "transparent") return 0
            Regex("""^color-mix\(in srgb,(.*)\)$""").find(v)?.let { m ->
                // The two operands, split at the top-level comma (an operand may be a mix itself), each `colour [p%]`.
                val operands = splitTopLevel(m.groupValues[1]).map { operand ->
                    Regex("""^(.+?)(?:\s+([\d.]+)%)?$""").find(operand.trim())!!.let { it.groupValues[1] to it.groupValues[2].ifEmpty { null }?.toFloat() }
                }
                require(operands.size == 2) { "not a two-colour mix: $value" }
                val p1 = operands[0].second ?: operands[1].second?.let { 100f - it } ?: 50f
                val p2 = operands[1].second ?: (100f - p1)
                val (w1, w2) = (p1 / (p1 + p2)) to (p2 / (p1 + p2))
                val a = parseColor(operands[0].first)
                val b = parseColor(operands[1].first)
                val (alphaA, alphaB) = ((a ushr 24) / 255f) to ((b ushr 24) / 255f)
                val alpha = alphaA * w1 + alphaB * w2
                fun channel(shift: Int): Int =
                    if (alpha == 0f) 0
                    else Math.round((((a shr shift) and 0xFF) * alphaA * w1 + ((b shr shift) and 0xFF) * alphaB * w2) / alpha)
                return (Math.round(alpha * 255) shl 24) or (channel(16) shl 16) or (channel(8) shl 8) or channel(0)
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
