package app.zen.chromium

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * The native hover card's numbers are the chrome's (§9.23's native line): [TabHoverCardSpec]
 * reads as `.zen-tab-hover-card` and its parts in main.css, `placeHoverCard`'s constants in
 * lib/portals.tsx and the panels' pop. A re-tune happens in the CSS; a failure here says which
 * native copy to bring along.
 */
class TabHoverCardSpecTest {
    private val root = repoRoot()
    private val css = File(root, "src/renderer/src/assets/main.css").readText()
    private val portals = File(root, "src/renderer/src/lib/portals.tsx").readText()

    private fun rule(selector: String): String {
        val at = css.indexOf("$selector {")
        assertTrue("$selector is in main.css", at >= 0)
        return css.substring(at, css.indexOf('}', at))
    }

    private fun px(block: String, property: String): Int {
        val m = Regex("""(?m)^\s*$property:\s*(-?\d+)px;""").find(block) ?: error("$property in\n$block")
        return m.groupValues[1].toInt()
    }

    @Test
    fun theCardIsTheStylesheetsPanel() {
        val card = rule(".zen-tab-hover-card")
        assertEquals(TabHoverCardSpec.PADDING_DP, px(card, "padding"))
        assertEquals(TabHoverCardSpec.RADIUS_DP, px(card, "border-radius"))
        assertTrue("the card's corner is the squircle", card.contains("corner-shape: var(--zen-corner)"))
        assertTrue("the card's shadow is the panel's", card.contains("box-shadow: var(--v2-shadow-panel)"))
        val shadow = Regex("""--v2-shadow-panel:\s*0 (\d+)px""").find(css) ?: error("--v2-shadow-panel")
        assertEquals(TabHoverCardSpec.SHADOW_Y_DP, shadow.groupValues[1].toInt())
        assertEquals(TabHoverCardSpec.WIDTH_DP, Regex("""POPOVER_WIDTH = \{ list: (\d+)""").find(portals)!!.groupValues[1].toInt())
    }

    @Test
    fun thePictureBoxIsTheContentWidthAt16To10InsideTheHairline() {
        val preview = rule(".zen-tab-hover-card-preview")
        val contentWidth = TabHoverCardSpec.WIDTH_DP - 2 * (TabHoverCardSpec.PADDING_DP + PromptSheetSpec.HAIRLINE_DP)
        assertEquals(px(preview, "width"), contentWidth)
        assertEquals(px(preview, "height"), Math.round(contentWidth * TabHoverCardSpec.PREVIEW_ASPECT))
        assertEquals(TabHoverCardSpec.PREVIEW_GAP_DP, px(preview, "margin-bottom"))
        assertTrue("the box's corner is the inner radius", preview.contains("border-radius: var(--v2-radius-inner)"))
        assertEquals(TabHoverCardSpec.PREVIEW_RADIUS_DP, Regex("""--v2-radius-inner:\s*(\d+)px""").find(css)!!.groupValues[1].toInt())
    }

    @Test
    fun theTitleAndTheMetaAreTheStylesheets() {
        val title = rule(".zen-tab-hover-card-title")
        assertEquals(TabHoverCardSpec.TITLE_LINES, Regex("""-webkit-line-clamp:\s*(\d+)""").find(title)!!.groupValues[1].toInt())
        assertTrue(title.contains("font-size: var(--v2-font-body)"))
        assertTrue(title.contains("line-height: var(--v2-line-body)"))
        assertEquals(TabHoverCardSpec.META_GAP_DP, px(rule(".zen-tab-hover-card-meta"), "margin-top"))
        val host = rule(".zen-tab-hover-card-host")
        assertTrue(host.contains("font-size: var(--v2-font-small)"))
        assertTrue(host.contains("line-height: var(--v2-line-small)"))
        assertTrue(host.contains("color: var(--v2-text-deemphasized)"))
        assertEquals(PromptSheetSpec.BODY_SP, Regex("""--v2-font-body:\s*(\d+)px""").find(css)!!.groupValues[1].toInt())
        assertEquals(PromptSheetSpec.BODY_LINE_SP, Regex("""--v2-line-body:\s*(\d+)px""").find(css)!!.groupValues[1].toInt())
        assertEquals(PromptSheetSpec.SMALL_SP, Regex("""--v2-font-small:\s*(\d+)px""").find(css)!!.groupValues[1].toInt())
        assertEquals(PromptSheetSpec.SMALL_LINE_SP, Regex("""--v2-line-small:\s*(\d+)px""").find(css)!!.groupValues[1].toInt())
    }

    @Test
    fun thePlacementsMarginsAndThePopAreTheChromes() {
        assertEquals(TabHoverCardSpec.MARGIN_DP, Regex("""export const POPOVER_MARGIN = (\d+)""").find(portals)!!.groupValues[1].toInt())
        assertEquals(TabHoverCardSpec.HEIGHT_FLOOR_DP, Regex("""export const POPOVER_HEIGHT_FLOOR = (\d+)""").find(portals)!!.groupValues[1].toInt())
        val pop = Regex("""\.zen-animate-pop \{\s*animation: zen-pop (\d+)ms var\(--zen-ease\)""").find(css) ?: error(".zen-animate-pop")
        assertEquals(TabHoverCardSpec.POP_MS, pop.groupValues[1].toLong())
        val from = Regex("""@keyframes zen-pop \{\s*from \{\s*opacity: 0;\s*transform: scale\(([\d.]+)\)""").find(css) ?: error("zen-pop from")
        assertEquals(TabHoverCardSpec.POP_SCALE, from.groupValues[1].toFloat(), 0f)
        // The reduced-motion rule by its own marks – the fade declared `!important` past the foot's
        // global rule, inside `@media (prefers-reduced-motion: reduce)` – not the plain 160 ms
        // `.zen-animate-fade` that happens to follow it in the file.
        val reduced = Regex("""@media \(prefers-reduced-motion: reduce\) \{[^}]*\.zen-animate-fade \{\s*animation: zen-fade (\d+)ms var\(--zen-ease\) !important""").find(css) ?: error("reduced-motion fade")
        assertEquals(TabHoverCardSpec.FADE_MS, reduced.groupValues[1].toLong())
        val ease = Regex("""--zen-ease: cubic-bezier\(([\d.]+), ([\d.]+), ([\d.]+), ([\d.]+)\)""").find(css) ?: error("--zen-ease")
        for (i in 0 until 4) assertEquals(TabHoverCardSpec.EASE[i], ease.groupValues[i + 1].toFloat(), 0f)
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
    }
}
