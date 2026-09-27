package app.zen.chromium

import app.zen.chromium.QuickActionsWidgetProvider.Variant
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * The quick actions widget's face pin (WID-02): the resource files as the build reads them, held to
 * Chrome 152's quick action search widget – the info's attributes
 * (`quick_action_search_widget_small_info.xml:8-18`), the floor widths by shortest side
 * (`values{,-sw240dp,-sw280dp}/dimens.xml`), the forms' measures (`values/dimens.xml:10-79`), the
 * three surfaces in Chrome's roles as MDC 1.12.0 resolves them for dynamic colour
 * (`widget_bg.xml:8` colorSurface, `widget_searchbox_bg.xml:8` colorSurfaceContainerHigh,
 * `widget_button_bg.xml:8` colorSurfaceContainer; `values-v31/tokens.xml`, `values-v34/tokens.xml`),
 * opaque as Chrome's are, with no hairline on the dynamic face and the v2 tokens below Android 12;
 * the layouts' shared ids, the glyphs, the manifest's receiver, the strings' case.
 */
class QuickActionsWidgetFaceTest {
    private val root = repoRoot()
    private val res = File(root, "android/app/src/main/res")

    private val dynamicValueFiles = listOf("values-v31/colors.xml", "values-night-v31/colors.xml", "values-v34/colors.xml", "values-night-v34/colors.xml")
    private val surfaces = listOf("widget_quick_actions_surface", "widget_quick_actions_bar", "widget_quick_actions_button")
    private val layouts = listOf("layout/widget_quick_actions_xsmall.xml", "layout/widget_quick_actions_small.xml", "layout/widget_quick_actions_medium.xml")
    private val drawables = listOf(
        "drawable/widget_quick_actions_card.xml", "drawable/widget_quick_actions_xsmall_card.xml",
        "drawable/widget_quick_actions_xsmall_bar.xml", "drawable/widget_quick_actions_small_bar.xml", "drawable/widget_quick_actions_medium_bar.xml",
        "drawable/widget_quick_actions_xsmall_button.xml", "drawable/widget_quick_actions_small_button.xml", "drawable/widget_quick_actions_medium_button.xml",
        "drawable-v31/widget_quick_actions_card.xml", "drawable-v31/widget_quick_actions_xsmall_card.xml",
        "drawable-v31/widget_quick_actions_xsmall_bar.xml", "drawable-v31/widget_quick_actions_small_bar.xml", "drawable-v31/widget_quick_actions_medium_bar.xml",
        "drawable/ic_widget_scan.xml", "drawable/widget_quick_actions_preview.xml"
    )

    @Test
    fun theInfoCarriesWhatChromesInfoCarriesAndNothingItDoesNot() {
        val info = read("xml/appwidget_quick_actions.xml")
        for (attribute in listOf(
            """android:initialLayout="@layout/widget_quick_actions_small"""",
            """android:minWidth="@dimen/widget_quick_actions_width"""",
            """android:minResizeWidth="@dimen/widget_quick_actions_width"""",
            """android:minHeight="@dimen/widget_quick_actions_xsmall_height"""",
            """android:minResizeHeight="@dimen/widget_quick_actions_xsmall_height"""",
            """android:resizeMode="vertical|horizontal"""",
            """android:previewImage="@drawable/widget_quick_actions_preview"""",
            """android:previewLayout="@layout/widget_quick_actions_preview"""",
            """android:description="@string/widget_quick_actions_description"""",
            """android:widgetCategory="home_screen|searchbox""""
        )) assertTrue("appwidget_quick_actions.xml carries $attribute", info.contains(attribute))
        // Chrome's info names no target span and no ceiling: the launcher's default span, any size above the floor.
        assertFalse("no targetCellWidth", info.contains("android:targetCellWidth"))
        assertFalse("no targetCellHeight", info.contains("android:targetCellHeight"))
        assertFalse("no maxResizeWidth", info.contains("android:maxResizeWidth"))
        assertFalse("no maxResizeHeight", info.contains("android:maxResizeHeight"))
        // Stateless: nothing to refresh on a period.
        assertTrue(info.contains("""android:updatePeriodMillis="0""""))
    }

    @Test
    fun theFloorWidthIsChromesByShortestSide() {
        // values/dimens.xml:10 300 dp; values-sw240dp/dimens.xml:9 220 dp; values-sw280dp/dimens.xml:9 260 dp.
        assertEquals("300dp", dimens("values/dimens.xml")["widget_quick_actions_width"])
        assertEquals("220dp", dimens("values-sw240dp/dimens.xml")["widget_quick_actions_width"])
        assertEquals("260dp", dimens("values-sw280dp/dimens.xml")["widget_quick_actions_width"])
        for (file in listOf("values-sw240dp/dimens.xml", "values-sw280dp/dimens.xml")) {
            assertEquals("$file overrides the floor alone", setOf("widget_quick_actions_width"), dimens(file).keys)
        }
    }

    @Test
    fun theFormsMeasuresAreChromesAndTheProvidersOwn() {
        val base = dimens("values/dimens.xml")
        // The heights the provider picks by (Variant.heightDp) are the layouts' fixed heights.
        assertEquals("${Variant.XSMALL.heightDp}dp", base["widget_quick_actions_xsmall_height"])
        assertEquals("${Variant.SMALL.heightDp}dp", base["widget_quick_actions_small_height"])
        assertEquals("${Variant.MEDIUM.heightDp}dp", base["widget_quick_actions_medium_height"])
        // A button with both margins (Variant.buttonWidthDp) is the layouts' button and margin.
        assertEquals(Variant.XSMALL.buttonWidthDp, dp(base["widget_quick_actions_xsmall_button"]) + 2 * dp(base["widget_quick_actions_xsmall_button_margin"]))
        assertEquals(Variant.SMALL.buttonWidthDp, dp(base["widget_quick_actions_small_button"]) + 2 * dp(base["widget_quick_actions_small_button_margin"]))
        assertEquals(Variant.MEDIUM.buttonWidthDp, dp(base["widget_quick_actions_medium_button"]) + 2 * dp(base["widget_quick_actions_medium_button_margin"]))
        // Chrome's measures, values/dimens.xml:10-79 there – but the xsmall hint, which is the chassis's
        // smallest type, 13 sp (§4; the gate's (c) on #599), where Chrome's is 11 sp.
        assertEquals("13sp", base["widget_quick_actions_xsmall_hint"])
        for ((name, value) in mapOf(
            "widget_quick_actions_radius" to "20dp", "widget_quick_actions_xsmall_radius" to "16dp",
            "widget_quick_actions_xsmall_margin" to "8dp", "widget_quick_actions_xsmall_bar_height" to "32dp", "widget_quick_actions_xsmall_bar_margin" to "3dp",
            "widget_quick_actions_xsmall_bar_radius" to "16dp", "widget_quick_actions_xsmall_mark" to "16dp",
            "widget_quick_actions_xsmall_button" to "28dp", "widget_quick_actions_xsmall_button_margin" to "5dp", "widget_quick_actions_xsmall_button_padding" to "6dp",
            "widget_quick_actions_small_margin" to "8dp", "widget_quick_actions_small_bar_height" to "48dp", "widget_quick_actions_small_bar_inset_horizontal" to "3.5dp",
            "widget_quick_actions_small_bar_inset_vertical" to "4.5dp", "widget_quick_actions_small_bar_radius" to "20dp", "widget_quick_actions_small_mark" to "20dp",
            "widget_quick_actions_small_button" to "48dp", "widget_quick_actions_small_button_margin" to "0dp", "widget_quick_actions_small_button_inset" to "3.5dp",
            "widget_quick_actions_small_button_radius" to "21dp", "widget_quick_actions_small_button_padding" to "15.5dp",
            "widget_quick_actions_medium_margin" to "15dp", "widget_quick_actions_medium_row_margin" to "15dp", "widget_quick_actions_medium_bar_height" to "50dp",
            "widget_quick_actions_medium_bar_radius" to "25dp", "widget_quick_actions_medium_mark" to "28dp", "widget_quick_actions_medium_button" to "54dp",
            "widget_quick_actions_medium_button_margin" to "3dp", "widget_quick_actions_medium_button_radius" to "27dp", "widget_quick_actions_medium_button_padding" to "17dp"
        )) assertEquals(name, value, base[name])
        // On Android 12+ the card's radii are the system's widget radius (Chrome's values-v31/dimens.xml:9-13).
        val v31 = dimens("values-v31/dimens.xml")
        assertEquals("@android:dimen/system_app_widget_background_radius", v31["widget_quick_actions_radius"])
        assertEquals("@android:dimen/system_app_widget_background_radius", v31["widget_quick_actions_xsmall_radius"])
    }

    @Test
    fun theXsmallBarLeavesTheWholeWordItsRoomAtEveryWidth() {
        // The gate's (c) on #599: the short hint at 13 sp, "Search" about 40 dp wide, never cut. The
        // room the xsmall bar leaves the word is what the width leaves after the card's margins, the
        // buttons the drop rule shows (Variant.XSMALL.shown), the bar's margins, the mark and its
        // margins and the hint's end margin – the layout's own dimens, read here rather than retyped.
        val base = dimens("values/dimens.xml")
        val fixed = 2 * dp(base["widget_quick_actions_xsmall_margin"]) + 2 * dp(base["widget_quick_actions_xsmall_bar_margin"]) +
            dp(base["widget_quick_actions_xsmall_mark_margin"]) + dp(base["widget_quick_actions_xsmall_mark"]) +
            dp(base["widget_quick_actions_xsmall_mark_margin_text"]) + dp(base["widget_quick_actions_xsmall_mark_margin"])
        val button = dp(base["widget_quick_actions_xsmall_button"]) + 2 * dp(base["widget_quick_actions_xsmall_button_margin"])
        assertEquals(Variant.XSMALL.buttonWidthDp, button)
        fun room(widthDp: Int) = widthDp - fixed - button * Variant.XSMALL.shown(widthDp).size
        val word = 40
        // The narrowest width a launcher can hand: the sw240dp floor less the host's default padding (8 dp a side).
        val narrowest = dp(dimens("values-sw240dp/dimens.xml")["widget_quick_actions_width"]) - 16
        assertEquals(204, narrowest)
        assertEquals(107, room(narrowest))
        // At the phone's floor (values-sw280dp, 260 dp) handed whole, as the driver hands it, and less the padding.
        assertEquals(125, room(260))
        assertEquals(109, room(244))
        // Every width from the narrowest up leaves the word more than twice its room; every width from 99 dp up leaves it whole.
        for (width in narrowest..600) assertTrue("$width dp leaves the word ${room(width)} dp", room(width) >= 2 * word)
        for (width in 99..600) assertTrue("$width dp leaves the word ${room(width)} dp", room(width) >= word)
        assertTrue("below 99 dp the word would be cut – a width no launcher offers", room(98) < word)
    }

    @Test
    fun theThreeSurfacesAreChromesRolesAsMdcResolvesThemOpaque() {
        // API 31–33: the neutral variant palette re-lit – surface 98 / 6, surface container high
        // 92 / 17, surface container 94 / 12 (values-v31/tokens.xml:90,97,99 light; :41,48,50 dark →
        // color-v31/m3_ref_palette_dynamic_neutral_variant*.xml:18, system_neutral2_600 under lStar).
        assertEquals(mapOf("color" to "@android:color/system_neutral2_600", "lStar" to "98"), stateListItem("color-v31/widget_quick_actions_surface.xml"))
        assertEquals(mapOf("color" to "@android:color/system_neutral2_600", "lStar" to "92"), stateListItem("color-v31/widget_quick_actions_bar.xml"))
        assertEquals(mapOf("color" to "@android:color/system_neutral2_600", "lStar" to "94"), stateListItem("color-v31/widget_quick_actions_button.xml"))
        assertEquals(mapOf("color" to "@android:color/system_neutral2_600", "lStar" to "6"), stateListItem("color-night-v31/widget_quick_actions_surface.xml"))
        assertEquals(mapOf("color" to "@android:color/system_neutral2_600", "lStar" to "17"), stateListItem("color-night-v31/widget_quick_actions_bar.xml"))
        assertEquals(mapOf("color" to "@android:color/system_neutral2_600", "lStar" to "12"), stateListItem("color-night-v31/widget_quick_actions_button.xml"))
        // API 34+: the platform's own roles (values-v34/tokens.xml:90,95,96 light; :45,50,51 dark).
        assertEquals(mapOf("color" to "@android:color/system_surface_light"), stateListItem("color-v34/widget_quick_actions_surface.xml"))
        assertEquals(mapOf("color" to "@android:color/system_surface_container_high_light"), stateListItem("color-v34/widget_quick_actions_bar.xml"))
        assertEquals(mapOf("color" to "@android:color/system_surface_container_light"), stateListItem("color-v34/widget_quick_actions_button.xml"))
        assertEquals(mapOf("color" to "@android:color/system_surface_dark"), stateListItem("color-night-v34/widget_quick_actions_surface.xml"))
        assertEquals(mapOf("color" to "@android:color/system_surface_container_high_dark"), stateListItem("color-night-v34/widget_quick_actions_bar.xml"))
        assertEquals(mapOf("color" to "@android:color/system_surface_container_dark"), stateListItem("color-night-v34/widget_quick_actions_button.xml"))
        // The bar is the search widget's fill role (colorSurfaceContainerHigh) – the same palette step, without its 0.9.
        assertEquals(stateListItem("color-v31/widget_search_fill.xml") - "alpha", stateListItem("color-v31/widget_quick_actions_bar.xml"))
        assertEquals(stateListItem("color-v34/widget_search_fill.xml") - "alpha", stateListItem("color-v34/widget_quick_actions_bar.xml"))
    }

    @Test
    fun nothingOnTheFaceFades() {
        // Chrome's quick action widget carries no alpha anywhere (the 0.9 is the search widget's,
        // search_widget_template.xml:19): no state list item, layout, drawable or glyph here does.
        for (dir in listOf("color-v31", "color-night-v31", "color-v34", "color-night-v34")) {
            for (surface in surfaces) assertNull("$dir/$surface.xml has no alpha", stateListItem("$dir/$surface.xml")["alpha"])
        }
        for (file in layouts + drawables) {
            assertFalse("$file fades nothing", read(file).contains("android:alpha="))
            assertFalse("$file fades nothing", read(file).contains("android:fillAlpha="))
        }
    }

    @Test
    fun noConfigurationNamesASurfaceTwiceAndTheHairlineIsThePre31FacesAndThePickerFramesAlone() {
        for (file in dynamicValueFiles) {
            for (surface in surfaces) assertNull("$file leaves $surface to its color-* state list", colours(file)[surface])
            assertNull("$file declares no hairline", colours(file)["widget_quick_actions_hairline"])
        }
        for (dir in listOf("color-v31", "color-night-v31", "color-v34", "color-night-v34")) {
            for (surface in surfaces) assertTrue("$dir/$surface.xml exists", File(res, "$dir/$surface.xml").isFile)
        }
        assertFalse(File(res, "color/widget_quick_actions_hairline.xml").exists())
        // The one day value and the one night value reach the pre-31 card and bars, the pre-31 picker's
        // vector (its card's and bar's strokes) and the picker's frame – nothing else.
        val naming = res.walk().filter { it.isFile && it.readText().contains("widget_quick_actions_hairline") }.map { it.relativeTo(res).path }.toSortedSet()
        assertEquals(
            sortedSetOf(
                "drawable/widget_quick_actions_card.xml", "drawable/widget_quick_actions_medium_bar.xml", "drawable/widget_quick_actions_preview.xml",
                "drawable/widget_quick_actions_preview_frame.xml", "drawable/widget_quick_actions_small_bar.xml", "drawable/widget_quick_actions_xsmall_bar.xml",
                "drawable/widget_quick_actions_xsmall_card.xml", "values-night/colors.xml", "values/colors.xml"
            ),
            naming
        )
    }

    @Test
    fun theRowIsChromesOrderVoicePrivateScan() {
        // Chrome 152's three layouts put the row Voice, Incognito, Lens, Dino
        // (chrome/browser/ui/android/quickactionsearchwidget/java/res/layout/quick_action_search_widget_small_layout.xml:65/72/79/86,
        // the xsmall :65/72/79/86, the medium :61/68/75/82); ours is that order less the Dino, the bar before the row.
        val order = listOf("widget_quick_actions_bar", "widget_quick_actions_voice", "widget_quick_actions_private", "widget_quick_actions_scan")
        for (file in layouts) {
            val layout = read(file)
            val positions = order.map { id -> layout.indexOf("""android:id="@+id/$id"""") }
            assertTrue("$file names every part", positions.all { it >= 0 })
            assertEquals("$file lays the parts in Chrome's order: ${order.joinToString()}", positions, positions.sorted())
        }
        // The provider wires the same four in the same order (its FACES; the row's BUTTONS are the last three).
        assertEquals(
            listOf(R.id.widget_quick_actions_bar, R.id.widget_quick_actions_voice, R.id.widget_quick_actions_private, R.id.widget_quick_actions_scan),
            QuickActionsWidgetProvider.FACES.map { it.viewId }
        )
        assertEquals(QuickActionsWidgetProvider.FACES.drop(1), QuickActionsWidgetProvider.BUTTONS)
    }

    @Test
    fun theDynamicCardAndBarsHaveNoHairlineAndThePre31OnesDo() {
        for (file in listOf("drawable-v31/widget_quick_actions_card.xml", "drawable-v31/widget_quick_actions_xsmall_card.xml", "drawable-v31/widget_quick_actions_xsmall_bar.xml", "drawable-v31/widget_quick_actions_small_bar.xml", "drawable-v31/widget_quick_actions_medium_bar.xml")) {
            assertFalse("$file has no stroke, as Chrome's shapes have none", read(file).contains("<stroke"))
            assertFalse("$file names no hairline", read(file).contains("widget_quick_actions_hairline"))
        }
        for (file in listOf("drawable/widget_quick_actions_card.xml", "drawable/widget_quick_actions_xsmall_card.xml", "drawable/widget_quick_actions_xsmall_bar.xml", "drawable/widget_quick_actions_small_bar.xml", "drawable/widget_quick_actions_medium_bar.xml")) {
            val drawable = read(file)
            assertTrue("$file keeps the v2 hairline below Android 12", drawable.contains("""android:width="1dp""""))
            assertTrue(drawable.contains("""android:color="@color/widget_quick_actions_hairline""""))
        }
        // The buttons are discs without a hairline at every level, and one drawable each.
        for (file in listOf("drawable/widget_quick_actions_small_button.xml", "drawable/widget_quick_actions_medium_button.xml", "drawable/widget_quick_actions_xsmall_button.xml")) {
            assertFalse("$file has no stroke", read(file).contains("<stroke"))
            assertFalse(File(res, file.replace("drawable/", "drawable-v31/")).exists())
        }
        // The extra-small button is Chrome's bare ripple (quick_action_search_widget_xsmall_button_background.xml).
        val xsmallButton = read("drawable/widget_quick_actions_xsmall_button.xml")
        assertTrue(xsmallButton.contains("<ripple"))
        assertFalse(xsmallButton.contains("<shape"))
    }

    @Test
    fun theRolesReachTheShapesThatDrawThem() {
        for (file in listOf("drawable/widget_quick_actions_card.xml", "drawable-v31/widget_quick_actions_card.xml", "drawable/widget_quick_actions_xsmall_card.xml", "drawable-v31/widget_quick_actions_xsmall_card.xml")) {
            assertTrue("$file fills with the surface", read(file).contains("""<solid android:color="@color/widget_quick_actions_surface" />"""))
        }
        for (file in listOf("drawable/widget_quick_actions_xsmall_bar.xml", "drawable/widget_quick_actions_small_bar.xml", "drawable/widget_quick_actions_medium_bar.xml", "drawable-v31/widget_quick_actions_xsmall_bar.xml", "drawable-v31/widget_quick_actions_small_bar.xml", "drawable-v31/widget_quick_actions_medium_bar.xml")) {
            val bar = read(file)
            assertTrue("$file fills with the bar role", bar.contains("""<solid android:color="@color/widget_quick_actions_bar" />"""))
            assertTrue("$file ripples in the system's highlight, as Chrome's", bar.contains("""android:color="?android:attr/colorControlHighlight""""))
        }
        for (file in listOf("drawable/widget_quick_actions_small_button.xml", "drawable/widget_quick_actions_medium_button.xml")) {
            val button = read(file)
            assertTrue("$file fills with the button role", button.contains("""<solid android:color="@color/widget_quick_actions_button" />"""))
            assertTrue(button.contains("""android:color="?android:attr/colorControlHighlight""""))
        }
        // The card's radii and the pills' are the dimens (the system radius on 12+ through values-v31/dimens.xml).
        assertTrue(read("drawable/widget_quick_actions_card.xml").contains("@dimen/widget_quick_actions_radius"))
        assertTrue(read("drawable/widget_quick_actions_xsmall_card.xml").contains("@dimen/widget_quick_actions_xsmall_radius"))
        assertTrue(read("drawable/widget_quick_actions_small_bar.xml").contains("@dimen/widget_quick_actions_small_bar_inset_vertical"))
        assertTrue(read("drawable/widget_quick_actions_small_button.xml").contains("@dimen/widget_quick_actions_small_button_inset"))
    }

    @Test
    fun belowAndroid12TheFaceStaysOnTheV2Tokens() {
        val light = colours("values/colors.xml")
        val dark = colours("values-night/colors.xml")
        assertEquals("@color/v2_page_light", light["widget_quick_actions_surface"])
        assertEquals("@color/v2_panel_light", light["widget_quick_actions_bar"])
        assertEquals("@color/v2_panel_light", light["widget_quick_actions_button"])
        assertEquals("@color/v2_border_light", light["widget_quick_actions_hairline"])
        assertEquals("@color/v2_page_dark", dark["widget_quick_actions_surface"])
        assertEquals("@color/v2_panel_dark", dark["widget_quick_actions_bar"])
        assertEquals("@color/v2_panel_dark", dark["widget_quick_actions_button"])
        assertEquals("@color/v2_border_dark", dark["widget_quick_actions_hairline"])
        for (surface in surfaces) {
            assertFalse("the pre-31 $surface is the opaque token", File(res, "color/$surface.xml").exists() || File(res, "color-night/$surface.xml").exists())
        }
    }

    @Test
    fun theLayoutsShareTheirPartsAndEachRowIsItsOwn() {
        for ((i, file) in layouts.withIndex()) {
            val layout = read(file)
            // The root is the view a launcher clips to the system radius on Android 12+, as Chrome's.
            assertTrue("$file's root is @android:id/background", layout.contains("""android:id="@android:id/background""""))
            assertTrue("$file clips to its outline", layout.contains("""android:clipToOutline="true""""))
            // The four parts the provider wires, by their shared ids.
            for (id in listOf("widget_quick_actions_bar", "widget_quick_actions_voice", "widget_quick_actions_private", "widget_quick_actions_scan")) {
                assertEquals("$file has one $id", 1, Regex("""android:id="@\+id/$id"""").findAll(layout).count())
            }
            assertTrue("$file names its row", layout.contains("""android:id="@+id/${listOf("widget_quick_actions_row_xsmall", "widget_quick_actions_row_small", "widget_quick_actions_row_medium")[i]}""""))
            // The glyphs: the search widget's mic and mask, the scanner's scan-line; the mark on the bar.
            assertTrue(layout.contains("""android:src="@drawable/ic_widget_mic""""))
            assertTrue(layout.contains("""android:src="@drawable/ic_widget_mask""""))
            assertTrue(layout.contains("""android:src="@drawable/ic_widget_scan""""))
            assertTrue(layout.contains("""android:src="@drawable/ic_widget_mark""""))
            // The hint is drawn in the search widget's hint colour; the buttons' names are the shared strings.
            assertTrue(layout.contains("""android:textColor="@color/widget_search_hint""""))
            assertTrue(layout.contains("""android:contentDescription="@string/widget_search_mic""""))
            assertTrue(layout.contains("""android:contentDescription="@string/widget_search_private""""))
            assertTrue(layout.contains("""android:contentDescription="@string/widget_quick_actions_scan""""))
            assertTrue("$file's bar reads as the omnibox", layout.contains("""android:contentDescription="@string/widget_search_hint""""))
        }
        // The forms' fixed heights and cards.
        assertTrue(read(layouts[0]).contains("""android:layout_height="@dimen/widget_quick_actions_xsmall_height""""))
        assertTrue(read(layouts[0]).contains("""android:background="@drawable/widget_quick_actions_xsmall_card""""))
        assertTrue(read(layouts[1]).contains("""android:layout_height="@dimen/widget_quick_actions_small_height""""))
        assertTrue(read(layouts[1]).contains("""android:background="@drawable/widget_quick_actions_card""""))
        assertTrue(read(layouts[2]).contains("""android:layout_height="@dimen/widget_quick_actions_medium_height""""))
        assertTrue(read(layouts[2]).contains("""android:background="@drawable/widget_quick_actions_card""""))
        // The hints: the short "Search" on the rows (Chrome's search_widget_default), the omnibox's own on the column.
        assertTrue(read(layouts[0]).contains("""android:text="@string/widget_quick_actions_hint_short""""))
        assertTrue(read(layouts[1]).contains("""android:text="@string/widget_quick_actions_hint_short""""))
        assertTrue(read(layouts[2]).contains("""android:text="@string/widget_search_hint""""))
        assertTrue(read(layouts[0]).contains("""android:textSize="@dimen/widget_quick_actions_xsmall_hint""""))
        // The column: the bar over the row.
        assertTrue(read(layouts[2]).contains("""android:orientation="vertical""""))
    }

    @Test
    fun thePreviewIsTheSmallFormAtTheFloorUnderADayAndNightHairline() {
        val preview = read("layout/widget_quick_actions_preview.xml")
        assertTrue(preview.contains("""android:layout_width="@dimen/widget_quick_actions_width""""))
        assertTrue(preview.contains("""android:layout_height="@dimen/widget_quick_actions_small_height""""))
        assertTrue(preview.contains("""<include layout="@layout/widget_quick_actions_small" />"""))
        assertTrue(preview.contains("""android:foreground="@drawable/widget_quick_actions_preview_frame""""))
        // Chrome frames its preview in black_alpha_12 (hairline_border.xml:10), a black literal the gate's
        // (f) on #599 rules out: the frame's stroke is the v2 border, one value by day and one by night.
        val frame = read("drawable/widget_quick_actions_preview_frame.xml")
        assertTrue(frame.contains("""android:width="1dp""""))
        assertTrue(frame.contains("""android:color="@color/widget_quick_actions_hairline""""))
        assertFalse("no colour literal in the frame", Regex("""#[0-9A-Fa-f]{6,8}""").containsMatchIn(frame))
        assertEquals("@color/v2_border_light", colours("values/colors.xml")["widget_quick_actions_hairline"])
        assertEquals("@color/v2_border_dark", colours("values-night/colors.xml")["widget_quick_actions_hairline"])
        assertEquals("#26000000", colours("values/colors.xml")["v2_border_light"])
        assertEquals("#1FFFFFFF", colours("values/colors.xml")["v2_border_dark"])
        // The pre-31 picker's vector is the small form's size.
        val image = read("drawable/widget_quick_actions_preview.xml")
        assertTrue(image.contains("""android:width="300dp""""))
        assertTrue(image.contains("""android:height="72dp""""))
        for (colour in surfaces + listOf("widget_search_mark", "widget_search_hint", "widget_search_ink")) {
            assertTrue("the preview draws in $colour", image.contains("@color/$colour"))
        }
    }

    @Test
    fun theScanGlyphIsTheShortcutsScanLineInTheInk() {
        val glyph = read("drawable/ic_widget_scan.xml")
        val paths = Regex("""android:pathData="([^"]+)"""").findAll(glyph).map { it.groupValues[1] }.toList()
        val shortcut = Regex("""android:pathData="([^"]+)"""").findAll(read("drawable/ic_shortcut_scan_foreground.xml")).map { it.groupValues[1] }.toList()
        assertEquals(shortcut, paths)
        assertEquals(5, paths.size)
        assertEquals("every path takes the ink", 5, Regex("""android:strokeColor="@color/widget_search_ink"""").findAll(glyph).count())
        assertEquals("every path is §9.3's stroke", 5, Regex("""android:strokeWidth="1\.75"""").findAll(glyph).count())
        assertFalse(glyph.contains("android:fillColor"))
    }

    @Test
    fun theManifestOffersTheReceiverForTheSystemsUpdateAlone() {
        val manifest = File(root, "android/app/src/main/AndroidManifest.xml").readText()
        val receiver = Regex("""<receiver\s+android:name="\.QuickActionsWidgetProvider"[\s\S]*?</receiver>""").find(manifest)?.value
        assertTrue("the manifest declares QuickActionsWidgetProvider", receiver != null)
        receiver!!
        assertTrue(receiver.contains("""android:exported="true""""))
        assertTrue(receiver.contains("""android:label="@string/widget_quick_actions_label""""))
        assertTrue(receiver.contains("""<action android:name="android.appwidget.action.APPWIDGET_UPDATE" />"""))
        assertTrue(receiver.contains("""android:name="android.appwidget.provider""""))
        assertTrue(receiver.contains("""android:resource="@xml/appwidget_quick_actions""""))
        assertEquals("one action: the system's update", 1, Regex("<action ").findAll(receiver).count())
    }

    @Test
    fun theWordsAreSentenceCaseAndTheSharedOnesShared() {
        val strings = Regex("""<string name="([a-z0-9_]+)">([^<]+)</string>""").findAll(read("values/strings.xml")).associate { it.groupValues[1] to it.groupValues[2] }
        assertEquals("Zenium quick actions", strings["widget_quick_actions_label"])
        assertEquals("Search or enter an address, search with your voice, open a new private tab, or scan a QR code", strings["widget_quick_actions_description"])
        assertEquals("Search", strings["widget_quick_actions_hint_short"])
        assertEquals("Scan a QR code", strings["widget_quick_actions_scan"])
        // §9.1: sentence case – after the first word only proper nouns and initialisms carry a capital.
        for (name in listOf("widget_quick_actions_label", "widget_quick_actions_description", "widget_quick_actions_scan")) {
            val words = strings[name]!!.split(" ").drop(1)
            assertTrue("$name is sentence case", words.all { it == "QR" || it.first().isLowerCase() })
        }
        // The layouts reuse the search widget's words rather than retyping them.
        for (name in listOf("widget_search_hint", "widget_search_mic", "widget_search_private")) assertTrue(strings.containsKey(name))
    }

    @Test
    fun theProviderHasTheSizeMapTheSearchWidgetHasNot() {
        val provider = File(root, "android/app/src/main/kotlin/app/zen/chromium/QuickActionsWidgetProvider.kt").readText()
        assertTrue(provider.contains("onAppWidgetOptionsChanged"))
        assertTrue(provider.contains("OPTION_APPWIDGET_SIZES"))
        assertTrue(provider.contains("OPTION_APPWIDGET_MIN_WIDTH"))
        assertTrue(provider.contains("OPTION_APPWIDGET_MAX_HEIGHT"))
        assertTrue(provider.contains("OPTION_APPWIDGET_MAX_WIDTH"))
        assertTrue(provider.contains("OPTION_APPWIDGET_MIN_HEIGHT"))
        assertTrue("the pre-12 pair is landscape then portrait, as the constructor takes them", provider.contains("RemoteViews(landscape, portrait)"))
        // The tokens are the search widget's shape: its intent, its flags, distinct request codes.
        assertTrue(provider.contains("SearchWidgetProvider.pendingIntent(context, face)"))
        assertFalse("no second flag set", provider.contains("FLAG_UPDATE_CURRENT"))
    }

    private fun read(path: String): String = File(res, path).readText()

    /** `name → value` for every `<color>` in a values file. */
    private fun colours(path: String): Map<String, String> =
        Regex("""<color name="([a-z0-9_]+)">([^<]+)</color>""").findAll(read(path)).associate { it.groupValues[1] to it.groupValues[2] }

    /** `name → value` for every `<dimen>` in a values file. */
    private fun dimens(path: String): Map<String, String> =
        Regex("""<dimen name="([a-z0-9_]+)">([^<]+)</dimen>""").findAll(read(path)).associate { it.groupValues[1] to it.groupValues[2] }

    private fun dp(value: String?): Int = value!!.removeSuffix("dp").toInt()

    /** The `android:` attributes (name → value) of the single `<item>` in a colour state list file. */
    private fun stateListItem(path: String): Map<String, String> {
        val items = Regex("""<item\b([\s\S]*?)/>""").findAll(read(path)).toList()
        assertEquals("$path has one item", 1, items.size)
        return Regex("""android:([a-zA-Z]+)="([^"]+)"""").findAll(items.single().groupValues[1]).associate { it.groupValues[1] to it.groupValues[2] }
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
