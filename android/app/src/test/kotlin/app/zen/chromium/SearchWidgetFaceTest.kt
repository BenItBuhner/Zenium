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
 * (`res/color/widget_searchbox_bg.xml`) at Chrome's 0.9 over the wallpaper
 * (`search_widget_template.xml:19`), `colorOnSurfaceVariant` for the hint and the glyphs
 * (`semantic_colors_dynamic.xml`) – written out as MDC 1.12.0 resolves them for dynamic colour
 * (`values-v31/tokens.xml`, `values-v34/tokens.xml`; the line numbers in the resource comments are
 * 1.12.0's, the version this module depends on), since the launcher inflates the face without our
 * theme. The pill is the fill alone on 12+ – no hairline, as Chrome's has none – and the 0.9 rides
 * the fill's colour, so the mark, the hint, the mic and the mask stay opaque (Chrome fades its
 * whole pill view, hint and mic with it; the lead's ruling keeps ours legible). This test reads the
 * resource files as the build does and fails on a role that drifts from MDC's table, on the fill
 * losing its alpha or a glyph gaining one, on a hairline returning to the dynamic face, on a base
 * (pre-31) value that left the v2 tokens, on the mark taking a system colour (it keeps the brand
 * indigo, as Chrome's quick action widget keeps its app icon), on a configuration that would name
 * the fill twice, on the info XML losing an attribute Chrome's `search_widget_info.xml` carries or
 * gaining a floor below four cells, and on the provider growing a size map (there is none).
 */
class SearchWidgetFaceTest {
    private val root = repoRoot()
    private val res = File(root, "android/app/src/main/res")

    private val dynamicValueFiles = listOf("values-v31/colors.xml", "values-night-v31/colors.xml", "values-v34/colors.xml", "values-night-v34/colors.xml")

    /** The MDC 1.12.0 dynamic-colour table for the ink (values-v31/tokens.xml:93 → :201, :44 → :196; values-v34/tokens.xml:93, :48). */
    private val ink = listOf(
        // v31 light, v31 dark, v34 light, v34 dark
        "@android:color/system_neutral2_700", "@android:color/system_neutral2_200",
        "@android:color/system_on_surface_variant_light", "@android:color/system_on_surface_variant_dark"
    )

    @Test
    fun theInkIsChromesRoleOnAndroid12AndUp() {
        for ((i, file) in dynamicValueFiles.withIndex()) {
            assertEquals("the ink in $file is colorOnSurfaceVariant as MDC 1.12.0 resolves it", ink[i], colours(file)["widget_search_ink"])
        }
    }

    @Test
    fun theHintSitsAtTheInksRoleAtFullAlphaOnAndroid12AndUp() {
        for (file in dynamicValueFiles) {
            assertEquals("the hint in $file is the ink's role, as Chrome's default_text_color_secondary is", "@color/widget_search_ink", colours(file)["widget_search_hint"])
        }
    }

    @Test
    fun theFillIsSurfaceContainerHighAsMdcResolvesItAtChromesAlpha() {
        // API 31–33: the neutral variant palette re-lit to tone 92 (light) / 17 (dark) – MDC 1.12.0's
        // m3_ref_palette_dynamic_neutral_variant92 / …17 (values-v31/tokens.xml:97 / :48 →
        // color-v31/m3_ref_palette_dynamic_neutral_variant{92,17}.xml:18), system_neutral2_600 under
        // lStar – at Chrome's 0.9 (search_widget_template.xml:19), the alpha on the fill's item.
        assertEquals(
            mapOf("alpha" to "0.9", "color" to "@android:color/system_neutral2_600", "lStar" to "92"),
            stateListItem("color-v31/widget_search_fill.xml")
        )
        assertEquals(
            mapOf("alpha" to "0.9", "color" to "@android:color/system_neutral2_600", "lStar" to "17"),
            stateListItem("color-night-v31/widget_search_fill.xml")
        )
        // API 34+: the platform's own role (values-v34/tokens.xml:95 / :50), at the same 0.9.
        assertEquals(
            mapOf("alpha" to "0.9", "color" to "@android:color/system_surface_container_high_light"),
            stateListItem("color-v34/widget_search_fill.xml")
        )
        assertEquals(
            mapOf("alpha" to "0.9", "color" to "@android:color/system_surface_container_high_dark"),
            stateListItem("color-night-v34/widget_search_fill.xml")
        )
    }

    @Test
    fun theAlphaRidesTheFillAloneSoTheMarkAndTheInkStayOpaque() {
        // No view of the face fades (Chrome's text_container does, hint and mic with it): the layout
        // carries no android:alpha, nor do the glyph vectors or either pill drawable.
        for (file in listOf("layout/widget_search.xml", "drawable/ic_widget_mark.xml", "drawable/ic_widget_mic.xml", "drawable/ic_widget_mask.xml", "drawable/widget_search_pill.xml", "drawable-v31/widget_search_pill.xml")) {
            assertFalse("$file fades nothing", read(file).contains("android:alpha="))
            assertFalse("$file fades nothing", read(file).contains("android:fillAlpha="))
        }
        // The ink is a plain system colour (no state list with an alpha) in every dynamic configuration.
        for (file in dynamicValueFiles) {
            assertTrue("the ink in $file is an opaque system colour", colours(file)["widget_search_ink"]!!.startsWith("@android:color/"))
        }
        assertFalse("no colour state list stands in for the ink", File(res, "color-v31/widget_search_ink.xml").exists() || File(res, "color-v34/widget_search_ink.xml").exists())
        // The mark's two literals are opaque.
        assertEquals("#6264DC", colours("values/colors.xml")["widget_search_mark"])
        assertEquals("#8284F0", colours("values-night/colors.xml")["widget_search_mark"])
    }

    @Test
    fun theDynamicPillHasNoHairline() {
        val dynamicPill = read("drawable-v31/widget_search_pill.xml")
        assertTrue("the dynamic pill fills with the fill role", dynamicPill.contains("""<solid android:color="@color/widget_search_fill" />"""))
        assertTrue("the dynamic pill keeps the 48 dp pill's radius", dynamicPill.contains("""<corners android:radius="24dp" />"""))
        assertFalse("the dynamic pill has no stroke, as Chrome's has none (search_widget_template.xml:20,24)", dynamicPill.contains("<stroke"))
        assertFalse("the dynamic pill names no hairline", dynamicPill.contains("widget_search_hairline"))
        for (file in dynamicValueFiles) {
            assertNull("$file declares no hairline: the role is the pre-31 face's alone", colours(file)["widget_search_hairline"])
        }
        // The pre-31 pill keeps the v2 border.
        val basePill = read("drawable/widget_search_pill.xml")
        assertTrue(basePill.contains("""android:width="1dp""""))
        assertTrue(basePill.contains("""android:color="@color/widget_search_hairline""""))
    }

    @Test
    fun noConfigurationNamesTheFillTwice() {
        // The fill is a colour state list file in every dynamic configuration (the alpha needs an
        // item), so no dynamic value file may declare it too – the merger would refuse the pair.
        for (file in dynamicValueFiles) {
            assertNull("$file leaves the fill to its color-* state list", colours(file)["widget_search_fill"])
        }
        for (dir in listOf("color-v31", "color-night-v31", "color-v34", "color-night-v34")) {
            assertTrue("$dir/widget_search_fill.xml exists", File(res, "$dir/widget_search_fill.xml").isFile)
        }
    }

    @Test
    fun theMarkKeepsTheBrandIndigoEverywhere() {
        for (file in dynamicValueFiles) {
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
        // The pre-31 fill is opaque: no base state list carries an alpha for it.
        assertFalse("the pre-31 fill is the opaque panel token", File(res, "color/widget_search_fill.xml").exists())
        assertFalse("the pre-31 dark fill is the opaque panel token", File(res, "color-night/widget_search_fill.xml").exists())
        // The pre-31 hint is the ink at 69 % (§9.29's deemphasised text), derived, not a literal.
        val hint = read("color/widget_search_hint.xml")
        assertTrue(hint.contains("""android:alpha="0.69""""))
        assertTrue(hint.contains("""android:color="@color/widget_search_ink""""))
    }

    @Test
    fun theRolesReachTheViewsThatDrawThem() {
        assertTrue("the face's pill is the pill drawable", read("layout/widget_search.xml").contains("""android:background="@drawable/widget_search_pill""""))
        assertTrue("the hint is drawn in the hint colour", read("layout/widget_search.xml").contains("""android:textColor="@color/widget_search_hint""""))
        assertTrue("the mic takes the ink", read("drawable/ic_widget_mic.xml").contains("@color/widget_search_ink"))
        assertTrue("the mask takes the ink", read("drawable/ic_widget_mask.xml").contains("@color/widget_search_ink"))
        val mark = read("drawable/ic_widget_mark.xml")
        assertTrue("the mark takes its own colour", mark.contains("@color/widget_search_mark"))
        assertFalse("the mark never borrows the ink", mark.contains("@color/widget_search_ink"))
    }

    @Test
    fun theInfoCarriesWhatChromesSearchWidgetInfoCarriesAndNoFloorBelowFourCells() {
        val info = read("xml/appwidget_search.xml")
        // chrome/android/java/res/xml/search_widget_info.xml:9-19 in Chrome 152.
        for (attribute in listOf(
            """android:initialLayout="@layout/widget_search"""",
            """android:previewLayout="@layout/widget_search"""",
            """android:previewImage="@drawable/widget_search_preview"""",
            """android:description="@string/widget_search_description"""",
            """android:resizeMode="horizontal"""",
            """android:widgetCategory="home_screen|searchbox"""",
            // Chrome's minWidth (:11); with no minResizeWidth the platform makes it the floor
            // (AppWidgetServiceImpl.java:2735): no face below four cells, as Chrome has none.
            """android:minWidth="240dp""""
        )) assertTrue("appwidget_search.xml carries $attribute", info.contains(attribute))
        assertFalse("no minResizeWidth: the floor is the minWidth, four cells", info.contains("android:minResizeWidth"))
        assertFalse("no maxResizeWidth: the row stretches as the launcher's does", info.contains("android:maxResizeWidth"))
        // Ours beyond Chrome's, kept on purpose: the picker's 4×1 target.
        assertTrue(info.contains("""android:targetCellWidth="4""""))
        assertTrue(info.contains("""android:targetCellHeight="1""""))
        assertFalse("no vertical resize", info.contains("""android:resizeMode="vertical""""))
    }

    @Test
    fun theProviderHasNoSizeMap() {
        // One RemoteViews per id at every width, as Chrome's SearchWidgetProvider.java:149-183:
        // no size-keyed RemoteViews, no options listener choosing a face by the cells.
        val provider = File(root, "android/app/src/main/kotlin/app/zen/chromium/SearchWidgetProvider.kt").readText()
        assertFalse(provider.contains("onAppWidgetOptionsChanged"))
        assertFalse(provider.contains("SizeF"))
        assertFalse(provider.contains("OPTION_APPWIDGET_SIZES"))
        assertFalse(provider.contains("OPTION_APPWIDGET_MIN_WIDTH"))
    }

    private fun read(path: String): String = File(res, path).readText()

    /** `name → value` for every `<color>` in a values file. */
    private fun colours(path: String): Map<String, String> =
        Regex("""<color name="([a-z0-9_]+)">([^<]+)</color>""").findAll(read(path))
            .associate { it.groupValues[1] to it.groupValues[2] }

    /** The `android:` attributes (name → value) of the single `<item>` in a colour state list file. */
    private fun stateListItem(path: String): Map<String, String> {
        val items = Regex("""<item\b([\s\S]*?)/>""").findAll(read(path)).toList()
        assertEquals("$path has one item", 1, items.size)
        return Regex("""android:([a-zA-Z]+)="([^"]+)"""").findAll(items.single().groupValues[1])
            .associate { it.groupValues[1] to it.groupValues[2] }
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
