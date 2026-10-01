package app.zen.chromium

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The pixel_6 recipe's numbers from #735's readers' run: the page laid out at (10, 96)–(711, 1421)
 * over a chrome at the origin, the bar below the frame at 1421–1516, a 56 CSS px band holding
 * the page 98 device px down (its bottom clipped by as much: visible to 1325 − 98 = 1227).
 */
class StripTouchRuleTest {
    private val height = 1325
    private val band = 98f

    /** A touch at screen `screenY` as the page view receives it with its translation `shift`. */
    private fun local(screenY: Float, shift: Float) = screenY - 96 - shift

    @Test
    fun aTouchOnTheBarUnderAStandingBandIsTheChromes() {
        // The blocker: the Menu at screen 1470 lands in the page's clipped strip (local 1276 ≥ 1227)
        // with no card in force – the band's hold alone must count.
        assertTrue(StripTouchRule.chromesTouch(hasChrome = true, coverActive = false, pulledDown = true, y = local(1470f, band), visibleTop = 0, visibleBottom = height - band.toInt()))
        // The same strip during a pull-to-refresh's displacement is the bar's row too.
        assertTrue(StripTouchRule.chromesTouch(hasChrome = true, coverActive = false, pulledDown = true, y = local(1440f, 140f), visibleTop = 0, visibleBottom = height - 140))
    }

    @Test
    fun theHeldPagesVisiblePartKeepsItsTouches() {
        // A tap in the article under the band: inside [0, 1227) – the page's.
        assertFalse(StripTouchRule.chromesTouch(hasChrome = true, coverActive = false, pulledDown = true, y = local(800f, band), visibleTop = 0, visibleBottom = height - band.toInt()))
        // The last visible row before the clip is still the page's; the first clipped one is not.
        assertFalse(StripTouchRule.chromesTouch(hasChrome = true, coverActive = false, pulledDown = true, y = 1226f, visibleTop = 0, visibleBottom = 1227))
        assertTrue(StripTouchRule.chromesTouch(hasChrome = true, coverActive = false, pulledDown = true, y = 1227f, visibleTop = 0, visibleBottom = 1227))
    }

    @Test
    fun aPageAtRestWithNoCardKeepsEveryTouch() {
        // No strip in force: the geometry alone never hands a touch over (the strip a hiding
        // bottom bar has not yet left stays the page's, as before this rule).
        assertFalse(StripTouchRule.chromesTouch(hasChrome = true, coverActive = false, pulledDown = false, y = 1300f, visibleTop = 0, visibleBottom = 1227))
        assertFalse(StripTouchRule.chromesTouch(hasChrome = true, coverActive = false, pulledDown = false, y = 1300f, visibleTop = 0, visibleBottom = height))
    }

    @Test
    fun aMessageCardsStripsAreTheChromesAsBefore() {
        // A toast's strip at the bottom (112 px) and a banner's at the top (150 px), the page at rest.
        assertTrue(StripTouchRule.chromesTouch(hasChrome = true, coverActive = true, pulledDown = false, y = 1250f, visibleTop = 0, visibleBottom = height - 112))
        assertTrue(StripTouchRule.chromesTouch(hasChrome = true, coverActive = true, pulledDown = false, y = 40f, visibleTop = 150, visibleBottom = height))
        assertFalse(StripTouchRule.chromesTouch(hasChrome = true, coverActive = true, pulledDown = false, y = 600f, visibleTop = 150, visibleBottom = height - 112))
    }

    @Test
    fun aHostWithNothingUnderThePageHandsNothingOver() {
        // A custom tab: no chrome WebView under its page, so the page keeps the strip's touches
        // whether a band holds it or a card stands.
        assertFalse(StripTouchRule.chromesTouch(hasChrome = false, coverActive = false, pulledDown = true, y = 1300f, visibleTop = 0, visibleBottom = 1227))
        assertFalse(StripTouchRule.chromesTouch(hasChrome = false, coverActive = true, pulledDown = false, y = 1300f, visibleTop = 0, visibleBottom = 1227))
    }

    @Test
    fun theHandedTouchCarriesThePagesTranslation() {
        // At rest the offset is the two places' difference, as before.
        assertEquals(Pair(10f, 96f), StripTouchRule.offsetToChrome(viewLeft = 10, viewTop = 96, translationX = 0f, translationY = 0f, chromeLeft = 0, chromeTop = 0))
        // Under the band the chrome must see the Menu's touch at 1470, where the bar is: the page's
        // local 1276 plus 96 plus the 98 the parent took off – not at 1372, a band's height above it.
        val (dx, dy) = StripTouchRule.offsetToChrome(viewLeft = 10, viewTop = 96, translationX = 0f, translationY = band, chromeLeft = 0, chromeTop = 0)
        assertEquals(10f, dx)
        assertEquals(1470f, local(1470f, band) + dy)
        // A chrome laid out below a status bar of its own, and a top-docked bar's shift, both count.
        assertEquals(Pair(0f, 96f + 24f - 48f), StripTouchRule.offsetToChrome(viewLeft = 0, viewTop = 96, translationX = 0f, translationY = 24f, chromeLeft = 0, chromeTop = 48))
    }
}
