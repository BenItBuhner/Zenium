package app.zen.chromium

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * The search widget's face pin (WID-03): on Android 12+ the face takes the system's Material You
 * colours in the roles Chrome's widget uses – `colorSurfaceContainerHigh` for the pill
 * (`res/color/widget_searchbox_bg.xml`), `colorOnSurfaceVariant` for the hint and the glyphs
 * (`semantic_colors_dynamic.xml`) – written out as MDC 1.12 resolves them for dynamic colour,
 * since the launcher inflates the face without our theme. This test reads the resource files as
 * the build does and fails on a role that drifts from MDC's table, on a base (pre-31) value that
 * left the v2 tokens, on the mark taking a system colour (it keeps the brand indigo, as Chrome's
 * quick action widget keeps its app icon), on a configuration that would name the fill twice, and
 * on the info XML losing an attribute Chrome's `search_widget_info.xml` carries.
 */
class SearchWidgetFaceTest {
    private val res = File(repoRoot(), "android/app/src/main/res")

    /** The MDC 1.12 dynamic-colour table for the three roles the face uses (values-v31/tokens.xml, values-v34/tokens.xml). */
    private val roles = mapOf(
        // role → (v31 light, v31 dark, v34 light, v34 dark)
        "widget_search_ink" to listOf(
            "@android:color/system_neutral2_700", "@android:color/system_neutral2_200",
            "@android:color/system_on_surface_variant_light", "@android:color/system_on_surface_variant_dark"
        ),
        "widget_search_hairline" to listOf(
            "@android:color/system_neutral2_200", "@android:color/system_neutral2_700",
            "@android:color/system_outline_variant_light", "@android:color/system_outline_variant_dark"
        )
    )

    @Test
    fun theInkAndHairlineAreChromesRolesOnAndroid12AndUp() {
        val v31 = colours("values-v31/colors.xml")
        val nightV31 = colours("values-night-v31/colors.xml")
        val v34 = colours("values-v34/colors.xml")
        val nightV34 = colours("values-night-v34/colors.xml")
        for ((name, expected) in roles) {
            assertEquals("$name on API 31, light", expected[0], v31[name])
            assertEquals("$name on API 31, dark", expected[1], nightV31[name])
            assertEquals("$name on API 34, light", expected[2], v34[name])
            assertEquals("$name on API 34, dark", expected[3], nightV34[name])
        }
    }

    @Test
    fun theHintSitsAtTheInksRoleAtFullAlphaOnAndroid12AndUp() {
        for (file in listOf("values-v31/colors.xml", "values-night-v31/colors.xml", "values-v34/colors.xml", "values-night-v34/colors.xml")) {
            assertEquals("the hint in $file is the ink's role, as Chrome's default_text_color_secondary is", "@color/widget_search_ink", colours(file)["widget_search_hint"])
        }
    }

    @Test
    fun theFillIsSurfaceContainerHighAsMdcResolvesIt() {
        // API 31–33: the neutral variant palette re-lit to tone 92 (light) / 17 (dark) – MDC's
        // m3_ref_palette_dynamic_neutral_variant92 / …17, system_neutral2_600 under lStar.
        assertEquals("@android:color/system_neutral2_600" to "92", stateListItem("color-v31/widget_search_fill.xml"))
        assertEquals("@android:color/system_neutral2_600" to "17", stateListItem("color-night-v31/widget_search_fill.xml"))
        // API 34+: the platform's own role.
        assertEquals("@android:color/system_surface_container_high_light", colours("values-v34/colors.xml")["widget_search_fill"])
        assertEquals("@android:color/system_surface_container_high_dark", colours("values-night-v34/colors.xml")["widget_search_fill"])
    }

    @Test
    fun noConfigurationNamesTheFillTwice() {
        // The v31 fill is a colour state list file, so the v31 value files must not declare it too.
        assertNull("values-v31 leaves the fill to color-v31/widget_search_fill.xml", colours("values-v31/colors.xml")["widget_search_fill"])
        assertNull("values-night-v31 leaves the fill to color-night-v31/widget_search_fill.xml", colours("values-night-v31/colors.xml")["widget_search_fill"])
        assertFalse("no color-v34 state list competes with values-v34's fill", File(res, "color-v34/widget_search_fill.xml").exists())
        assertFalse("no color-night-v34 state list competes with values-night-v34's fill", File(res, "color-night-v34/widget_search_fill.xml").exists())
    }

    @Test
    fun theMarkKeepsTheBrandIndigoEverywhere() {
        for (file in listOf("values-v31/colors.xml", "values-night-v31/colors.xml", "values-v34/colors.xml", "values-night-v34/colors.xml")) {
            assertNull("$file does not recolour the mark", colours(file)["widget_search_mark"])
        }
        assertEquals("#6264DC", colours("values/colors.xml")["widget_search_mark"])
        assertEquals("#8284F0", colours("values-night/colors.xml")["widget_search_mark"])
    }

    @Test
    fun belowAndroid12TheFaceStaysOnTheV2Tokens() {
        val light = colours("values/colors.xml")
        val dark = colours("values-night/colors.xml")
        assertEquals("@color/v2_panel_light", light["widget_search_fill"])
        assertEquals("@color/v2_border_light", light["widget_search_hairline"])
        assertEquals("@color/v2_text_light", light["widget_search_ink"])
        assertEquals("@color/v2_panel_dark", dark["widget_search_fill"])
        assertEquals("@color/v2_border_dark", dark["widget_search_hairline"])
        assertEquals("@color/v2_text_dark", dark["widget_search_ink"])
        // The pre-31 hint is the ink at 69 % (§9.29's deemphasised text), derived, not a literal.
        val hint = read("color/widget_search_hint.xml")
        assertTrue(hint.contains("""android:alpha="0.69""""))
        assertTrue(hint.contains("""android:color="@color/widget_search_ink""""))
    }

    @Test
    fun theRolesReachTheViewsThatDrawThem() {
        val pill = read("drawable/widget_search_pill.xml")
        assertTrue("the pill fills with the fill role", pill.contains("""<solid android:color="@color/widget_search_fill" />"""))
        assertTrue("the pill's hairline is the hairline role", pill.contains("""android:color="@color/widget_search_hairline""""))
        assertTrue("the hint is drawn in the hint colour", read("layout/widget_search.xml").contains("""android:textColor="@color/widget_search_hint""""))
        assertTrue("the mic takes the ink", read("drawable/ic_widget_mic.xml").contains("@color/widget_search_ink"))
        assertTrue("the mask takes the ink", read("drawable/ic_widget_mask.xml").contains("@color/widget_search_ink"))
        val mark = read("drawable/ic_widget_mark.xml")
        assertTrue("the mark takes its own colour", mark.contains("@color/widget_search_mark"))
        assertFalse("the mark never borrows the ink", mark.contains("@color/widget_search_ink"))
    }

    @Test
    fun theInfoCarriesWhatChromesSearchWidgetInfoCarries() {
        val info = read("xml/appwidget_search.xml")
        // chrome/android/java/res/xml/search_widget_info.xml:11-19 in Chrome 152.
        for (attribute in listOf(
            """android:initialLayout="@layout/widget_search"""",
            """android:previewLayout="@layout/widget_search"""",
            """android:previewImage="@drawable/widget_search_preview"""",
            """android:description="@string/widget_search_description"""",
            """android:resizeMode="horizontal"""",
            """android:widgetCategory="home_screen|searchbox""""
        )) assertTrue("appwidget_search.xml carries $attribute", info.contains(attribute))
        // Ours beyond Chrome's, kept on purpose: one row of four cells, shrinking to three, never two.
        assertTrue(info.contains("""android:targetCellWidth="4""""))
        assertTrue(info.contains("""android:targetCellHeight="1""""))
        assertTrue(info.contains("""android:minResizeWidth="180dp""""))
        assertFalse("no vertical resize", info.contains("""android:resizeMode="vertical""""))
    }

    private fun read(path: String): String = File(res, path).readText()

    /** `name → value` for every `<color>` in a values file. */
    private fun colours(path: String): Map<String, String> =
        Regex("""<color name="([a-z0-9_]+)">([^<]+)</color>""").findAll(read(path))
            .associate { it.groupValues[1] to it.groupValues[2] }

    /** `(colour, lStar)` of the single `<item>` in a colour state list file. */
    private fun stateListItem(path: String): Pair<String, String> {
        val items = Regex("""<item\b([\s\S]*?)/>""").findAll(read(path)).toList()
        assertEquals("$path has one item", 1, items.size)
        val attributes = items.single().groupValues[1]
        val colour = Regex("""android:color="([^"]+)"""").find(attributes)?.groupValues?.get(1) ?: error("$path: item without a colour")
        val lStar = Regex("""android:lStar="([^"]+)"""").find(attributes)?.groupValues?.get(1) ?: error("$path: item without lStar")
        return colour to lStar
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
