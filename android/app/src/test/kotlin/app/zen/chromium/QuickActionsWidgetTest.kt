package app.zen.chromium

import app.zen.chromium.QuickActionsWidgetProvider.Variant
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.ceil
import kotlin.math.max

/**
 * The quick actions widget's size map (WID-02), pinned to Chrome's `QuickActionSearchWidgetProviderDelegate`
 * (Chrome 152): the form by the height (`:464-471`), the buttons by the width (`:101-110`, dropped
 * in Chrome's order `:145-174`), the variants' numbers (`:216-249`), and the parts' landings and
 * tokens.
 */
class QuickActionsWidgetTest {
    @Test
    fun theHeightPicksTheFormAtChromesBreakpoints() {
        // Under the small form's 72 dp the extra-small row; under the medium form's 155 dp the small
        // row; from 155 dp the medium column – heights compared as Chrome compares them (< the next).
        for (height in listOf(0, 1, 47, 48, 71)) assertEquals("$height dp", Variant.XSMALL, Variant.forHeight(height))
        for (height in listOf(72, 73, 100, 154)) assertEquals("$height dp", Variant.SMALL, Variant.forHeight(height))
        for (height in listOf(155, 156, 200, 400)) assertEquals("$height dp", Variant.MEDIUM, Variant.forHeight(height))
    }

    @Test
    fun theFormsCarryChromesNumbers() {
        // Delegate.java:216-249 → values/dimens.xml there: heights 48 / 72 / 155; a button with both
        // margins 28 + 2·5 / 48 + 2·0 / 54 + 2·3; reference widths 312 / 312 / 264 for four buttons.
        assertEquals(listOf(48, 72, 155), Variant.values().map { it.heightDp })
        assertEquals(listOf(38, 48, 60), Variant.values().map { it.buttonWidthDp })
        assertEquals(listOf(312, 312, 264), Variant.values().map { it.chromeReferenceWidthDp })
        assertEquals(4, QuickActionsWidgetProvider.CHROME_BUTTONS)
    }

    @Test
    fun theReferenceWidthIsChromesLessTheDinoSlotItDoesNotHaveYet() {
        // Three buttons where Chrome has four: the bar keeps Chrome's minimum width at the reference,
        // and every button dropped gives back exactly one button's width, as there.
        assertEquals(3, QuickActionsWidgetProvider.BUTTONS.size)
        for (variant in Variant.values()) {
            assertEquals(variant.name, variant.chromeReferenceWidthDp - variant.buttonWidthDp, variant.referenceWidthDp)
        }
        assertEquals(274, Variant.XSMALL.referenceWidthDp)
        assertEquals(264, Variant.SMALL.referenceWidthDp)
        assertEquals(204, Variant.MEDIUM.referenceWidthDp)
    }

    @Test
    fun everyButtonShortOfTheReferenceWidthDropsOneButton() {
        for (variant in Variant.values()) {
            val reference = variant.referenceWidthDp
            val button = variant.buttonWidthDp
            assertEquals("${variant.name} at its reference", 0, variant.buttonsToHide(reference))
            assertEquals("${variant.name} wider than its reference", 0, variant.buttonsToHide(reference + 500))
            assertEquals("${variant.name} one dp short", 1, variant.buttonsToHide(reference - 1))
            assertEquals("${variant.name} one button short", 1, variant.buttonsToHide(reference - button))
            assertEquals("${variant.name} one button and a dp short", 2, variant.buttonsToHide(reference - button - 1))
            assertEquals("${variant.name} two buttons short", 2, variant.buttonsToHide(reference - 2 * button))
            assertEquals("${variant.name} three buttons short", 3, variant.buttonsToHide(reference - 3 * button))
            assertTrue("${variant.name} with no width at all asks for every button", variant.buttonsToHide(0) >= 3)
        }
    }

    @Test
    fun theRowGivesItsButtonsUpInChromesOrderLessTheDino() {
        // Chrome's row, left to right in all three layouts at the tag: Voice, Incognito, Lens, Dino
        // (chrome/browser/ui/android/quickactionsearchwidget/java/res/layout/
        // quick_action_search_widget_small_layout.xml:65/72/79/86; xsmall :65/72/79/86; medium
        // :61/68/75/82) → ours Voice, Private, Scan (gate #599 (h)). Chrome drops them from the right:
        // Dino, Lens, Incognito, Voice (Delegate.java:145-174). Without the Dino: the scanner (Lens's
        // slot) first, then the mask, the mic last.
        val voice = QuickActionsWidgetProvider.VOICE
        val private = QuickActionsWidgetProvider.PRIVATE
        val scan = QuickActionsWidgetProvider.SCAN
        assertEquals(listOf(voice, private, scan), QuickActionsWidgetProvider.BUTTONS)
        assertEquals(listOf(scan, private, voice), QuickActionsWidgetProvider.DROP_ORDER)
        for (variant in Variant.values()) {
            val reference = variant.referenceWidthDp
            val button = variant.buttonWidthDp
            assertEquals(listOf(voice, private, scan), variant.shown(reference))
            assertEquals(listOf(voice, private), variant.shown(reference - 1))
            assertEquals(listOf(voice), variant.shown(reference - button - 1))
            assertEquals(emptyList<SearchWidgetProvider.Face>(), variant.shown(reference - 2 * button - 1))
            assertEquals("no width at all hides every button and nothing worse", emptyList<SearchWidgetProvider.Face>(), variant.shown(0))
        }
    }

    @Test
    fun atChromesPhoneFloorTheVisibleButtonsAreChromesOwn() {
        // 260 dp is Chrome's minWidth on every phone (values-sw280dp/dimens.xml:9). Chrome's rows
        // there: small hides ceil((312-260)/48) = 2 → Voice and Incognito stay; extra-small hides
        // ceil((312-260)/38) = 2 → the same two; medium hides ceil((264-260)/60) = 1 → the Dino
        // alone, Voice, Incognito and Lens stay. Ours show the same sets, the scanner in Lens's slot.
        val floor = 260
        assertEquals(listOf("Voice", "Incognito"), chromeShows(Variant.SMALL, floor))
        assertEquals(listOf("Voice", "Incognito"), chromeShows(Variant.XSMALL, floor))
        assertEquals(listOf("Voice", "Incognito", "Lens"), chromeShows(Variant.MEDIUM, floor))
        assertEquals(listOf(QuickActionsWidgetProvider.VOICE, QuickActionsWidgetProvider.PRIVATE), Variant.SMALL.shown(floor))
        assertEquals(listOf(QuickActionsWidgetProvider.VOICE, QuickActionsWidgetProvider.PRIVATE), Variant.XSMALL.shown(floor))
        assertEquals(QuickActionsWidgetProvider.BUTTONS, Variant.MEDIUM.shown(floor))
        // And at Chrome's other floors (300 dp below 240 dp of shortest side, 220 dp from 240 dp).
        for (width in listOf(300, 220)) {
            for (variant in Variant.values()) {
                val chrome = chromeShows(variant, width).filter { it != "Dino" }.map { chromeToOurs(it) }
                assertEquals("${variant.name} at $width dp", chrome, variant.shown(width))
            }
        }
    }

    /** Chrome's own row at `widthDp`: four buttons, its reference width, its drop order (Delegate.java:101-110, 145-174). */
    private fun chromeShows(variant: Variant, widthDp: Int): List<String> {
        val hide = max(0.0, ceil((variant.chromeReferenceWidthDp - widthDp).toDouble() / variant.buttonWidthDp)).toInt()
        val dropped = listOf("Dino", "Lens", "Incognito", "Voice").take(hide.coerceAtMost(4))
        return listOf("Voice", "Incognito", "Lens", "Dino").filter { it !in dropped }
    }

    private fun chromeToOurs(button: String): SearchWidgetProvider.Face = when (button) {
        "Voice" -> QuickActionsWidgetProvider.VOICE
        "Incognito" -> QuickActionsWidgetProvider.PRIVATE
        "Lens" -> QuickActionsWidgetProvider.SCAN
        else -> error(button)
    }

    @Test
    fun theFaceHasFourPartsInTheLayoutsOrder() {
        assertEquals(
            listOf(R.id.widget_quick_actions_bar, R.id.widget_quick_actions_voice, R.id.widget_quick_actions_private, R.id.widget_quick_actions_scan),
            QuickActionsWidgetProvider.FACES.map { it.viewId }
        )
        assertEquals(QuickActionsWidgetProvider.FACES.drop(1), QuickActionsWidgetProvider.BUTTONS)
    }

    @Test
    fun eachPartLandsWhereItsGlyphSays() {
        val byView = QuickActionsWidgetProvider.FACES.associate { it.viewId to it.landing }
        assertEquals(Landing.SEARCH, byView[R.id.widget_quick_actions_bar])
        assertEquals(Landing.VOICE, byView[R.id.widget_quick_actions_voice])
        assertEquals(Landing.PRIVATE, byView[R.id.widget_quick_actions_private])
        // Chrome's Lens slot: the QR scanner (the row's stated limit – Lens has no free counterpart).
        assertEquals(Landing.SCAN, byView[R.id.widget_quick_actions_scan])
        for (face in QuickActionsWidgetProvider.FACES) assertEquals(face.landing, Landing.parse(face.landing))
    }

    @Test
    fun theRequestCodesDifferWithinTheFaceAndFromTheSearchWidgets() {
        // The intents share SearchWidgetProvider's component, action and flags and differ by the
        // landing extra alone; Intent.filterEquals ignores extras, so a shared request code – within
        // this face or across the two providers – would fold two parts into one PendingIntent.
        val ours = QuickActionsWidgetProvider.FACES.map { it.requestCode }
        val theirs = SearchWidgetProvider.FACES.map { it.requestCode }
        assertEquals(ours.size, ours.toSet().size)
        assertTrue(ours.all { it > 0 })
        assertTrue("no code shared with the search widget", ours.none { it in theirs })
        // Nor with the drivers' replay codes (WidgetDemo: 11, 12).
        assertTrue(ours.none { it == 11 || it == 12 })
    }

    @Test
    fun theFormsRowIdsAreTheirOwn() {
        assertEquals(
            listOf(R.id.widget_quick_actions_row_xsmall, R.id.widget_quick_actions_row_small, R.id.widget_quick_actions_row_medium),
            Variant.values().map { it.rowId }
        )
        assertEquals(
            listOf(R.layout.widget_quick_actions_xsmall, R.layout.widget_quick_actions_small, R.layout.widget_quick_actions_medium),
            Variant.values().map { it.layout }
        )
    }
}
