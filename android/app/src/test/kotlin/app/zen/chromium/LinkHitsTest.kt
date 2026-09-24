package app.zen.chromium

import android.webkit.WebView.HitTestResult
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Which long-presses raise the link menu and what address it opens on (PUI-18, PUI-22): the
 * WebView's `tel:` and `mailto:` hits are the menu's too, their bare extra put back under its
 * scheme when the focus node gave no href.
 */
class LinkHitsTest {
    @Test
    fun pageLinksAndTheContactLinksOpenTheMenuPlainTextAndImagesDoNot() {
        for (type in listOf(
            HitTestResult.SRC_ANCHOR_TYPE,
            HitTestResult.SRC_IMAGE_ANCHOR_TYPE,
            HitTestResult.PHONE_TYPE,
            HitTestResult.EMAIL_TYPE
        )) assertTrue("type $type", LinkHits.opensLinkMenu(type))
        for (type in listOf(
            HitTestResult.UNKNOWN_TYPE,
            HitTestResult.IMAGE_TYPE,
            HitTestResult.GEO_TYPE,
            HitTestResult.EDIT_TEXT_TYPE
        )) assertFalse("type $type", LinkHits.opensLinkMenu(type))
    }

    @Test
    fun theFocusedHrefWinsWhateverTheType() {
        assertEquals("tel:+15550100", LinkHits.href(HitTestResult.PHONE_TYPE, "tel:+15550100", "+15550100"))
        assertEquals("mailto:a@b.example?subject=Hi", LinkHits.href(HitTestResult.EMAIL_TYPE, "mailto:a@b.example?subject=Hi", "a@b.example"))
        assertEquals("https://zen.example/a", LinkHits.href(HitTestResult.SRC_ANCHOR_TYPE, "https://zen.example/a", "https://zen.example/a"))
    }

    @Test
    fun aBareExtraGoesBackUnderTheSchemeItsTypeNames() {
        assertEquals("tel:+15550100", LinkHits.href(HitTestResult.PHONE_TYPE, null, "+15550100"))
        assertEquals("tel:+15550100", LinkHits.href(HitTestResult.PHONE_TYPE, "", "+15550100"))
        assertEquals("mailto:hello@zenium.example", LinkHits.href(HitTestResult.EMAIL_TYPE, null, "hello@zenium.example"))
        // An extra that already carries the scheme is not doubled.
        assertEquals("tel:5550100", LinkHits.href(HitTestResult.PHONE_TYPE, null, "tel:5550100"))
        assertEquals("MAILTO:x@y.example", LinkHits.href(HitTestResult.EMAIL_TYPE, null, "MAILTO:x@y.example"))
        // A page link's extra is its href already.
        assertEquals("https://zen.example/", LinkHits.href(HitTestResult.SRC_ANCHOR_TYPE, null, "https://zen.example/"))
    }

    @Test
    fun nothingKnownIsAnEmptyAddress() {
        assertEquals("", LinkHits.href(HitTestResult.PHONE_TYPE, null, null))
        assertEquals("", LinkHits.href(HitTestResult.SRC_ANCHOR_TYPE, "", ""))
    }
}
