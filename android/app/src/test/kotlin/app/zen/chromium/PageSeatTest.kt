package app.zen.chromium

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The WebView's translation under the page-edge band, device px at density 1.75: the one-line
 * band is 98 px, the two-line 133 px.
 */
class PageSeatTest {
    private val oneLine = 98f
    private val twoLine = 133f

    @Test
    fun atRestTheSeatCarriesTheWholeOffsetAndTheTranslationIsZero() {
        assertEquals(0f, PageSeat.translation(oneLine, 98, 0f), 0f)
        assertEquals(0f, PageSeat.translation(twoLine, 133, 0f), 0f)
        assertEquals(0f, PageSeat.hangPx(oneLine, 98), 0f)
    }

    @Test
    fun theViewsTopOnScreenIsTheOffsetWhateverTheSeat() {
        // Seated or not, `seat + translation` is the offset: a seat changing under a standing
        // offset (a depart from rest, a pull's takeover) moves nothing on screen.
        for (seat in listOf(0, 40, 98)) assertEquals(oneLine, seat + PageSeat.translation(oneLine, seat, 0f), 0f)
    }

    @Test
    fun aTravelTranslatesTheOffsetLessTheSeat() {
        // 56 → 76 (one line to two): the seat stays at 56 through the travel; the frames hang the
        // view below its frame by what it has travelled, clipped by as much.
        assertEquals(17.5f, PageSeat.translation(115.5f, 98, 0f), 0f)
        assertEquals(17.5f, PageSeat.hangPx(115.5f, 98), 0f)
        assertEquals(35f, PageSeat.translation(twoLine, 98, 0f), 0f)
        // 76 → 56: unseated to 56 at the depart, translated by the 20 still to travel, home at 0.
        assertEquals(35f, PageSeat.translation(twoLine, 98, 0f), 0f)
        assertEquals(0f, PageSeat.translation(oneLine, 98, 0f), 0f)
    }

    @Test
    fun unseatedTheWholeOffsetTranslatesAndHangsAsBeforeTheSeat() {
        // A leave's depart (seat → 0) or a pull's takeover: the translation is the offset, the
        // hang the offset – #734's picture, the clip and the bar's row as they were.
        assertEquals(oneLine, PageSeat.translation(oneLine, 0, 0f), 0f)
        assertEquals(oneLine, PageSeat.hangPx(oneLine, 0), 0f)
        assertEquals(0f, PageSeat.hangPx(0f, 0), 0f)
    }

    @Test
    fun theHidingBarsSlideComposesWithTheSeat() {
        // A top-docked bar 30 px into its hide slides the page up by 30 whether seated or not.
        assertEquals(-30f, PageSeat.translation(oneLine, 98, -30f), 0f)
        assertEquals(oneLine - 30f, PageSeat.translation(oneLine, 0, -30f), 0f)
        // The slide is no hang: the bar's clip is its own (`barClipPx`).
        assertEquals(0f, PageSeat.hangPx(oneLine, 98), 0f)
    }

    @Test
    fun anOffsetBelowTheSeatHangsNothing() {
        // A finger's drag back up under a seat not yet given up (the host unseats at the first
        // frame below the seat; a frame in between reads the seat still): nothing below the frame.
        assertEquals(0f, PageSeat.hangPx(60f, 98), 0f)
        assertEquals(-38f, PageSeat.translation(60f, 98, 0f), 0f)
    }
}
