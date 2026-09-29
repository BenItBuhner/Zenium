package app.zen.chromium

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Copy link to highlight's view-free half: the page's answer read off `evaluateJavascript`, the
 * pages the item is offered for, and the link built from the page's URL and the directive – the
 * directive's own encoding (the page script's) left exactly as it came. The action mode's work
 * itself runs on the emulator (`TextFragmentDemo`).
 */
class TextFragmentLinkTest {
    // --- which pages ---------------------------------------------------------------------------------

    @Test
    fun offeredForWebPagesAlone() {
        assertTrue(TextFragmentLink.offers("https://example.test/article"))
        assertTrue(TextFragmentLink.offers("http://example.test/"))
        assertTrue(TextFragmentLink.offers("HTTPS://EXAMPLE.TEST/"))
        assertFalse(TextFragmentLink.offers("zen://settings/"))
        assertFalse(TextFragmentLink.offers("about:blank"))
        assertFalse(TextFragmentLink.offers("file:///sdcard/Download/page.html"))
        assertFalse(TextFragmentLink.offers("data:text/html,hello"))
        assertFalse(TextFragmentLink.offers("blob:https://example.test/1234"))
        assertFalse(TextFragmentLink.offers(""))
        assertFalse(TextFragmentLink.offers(null))
    }

    // --- the page's answer ---------------------------------------------------------------------------

    @Test
    fun readsThePlainDirectiveOutOfTheJsonAnswer() {
        assertEquals("text=ledger%20did%20not%20care", TextFragmentLink.directiveOf("\"text=ledger%20did%20not%20care\""))
    }

    @Test
    fun readsADirectiveWithContextAndARange() {
        assertEquals(
            "text=Every%20evening-,climbed%20the%20steps,-again",
            TextFragmentLink.directiveOf("\"text=Every%20evening-,climbed%20the%20steps,-again\"")
        )
        assertEquals("text=The%20lighthouse,steps%20again", TextFragmentLink.directiveOf("\"text=The%20lighthouse,steps%20again\""))
    }

    @Test
    fun keepsTheEncodedCommasAmpersandsAndDashesAsTheyCame() {
        // "a-b, c & d" as the page script encodes it: the syntax's own characters escaped.
        assertEquals("text=a%2Db%2C%20c%20%26%20d", TextFragmentLink.directiveOf("\"text=a%2Db%2C%20c%20%26%20d\""))
    }

    @Test
    fun keepsUnicodeTermsPercentEncoded() {
        assertEquals("text=%E4%BA%AC%E9%83%BD%E3%81%AE%E5%A4%8F", TextFragmentLink.directiveOf("\"text=%E4%BA%AC%E9%83%BD%E3%81%AE%E5%A4%8F\""))
    }

    @Test
    fun nothingForNullGarbageOrAnAnswerThatIsNotADirective() {
        assertNull(TextFragmentLink.directiveOf(null))
        assertNull(TextFragmentLink.directiveOf(""))
        assertNull(TextFragmentLink.directiveOf("null"))
        assertNull(TextFragmentLink.directiveOf("undefined"))
        assertNull(TextFragmentLink.directiveOf("42"))
        assertNull(TextFragmentLink.directiveOf("\"\""))
        assertNull(TextFragmentLink.directiveOf("\"ledger\""))
        assertNull(TextFragmentLink.directiveOf("\"text=\""))
        assertNull(TextFragmentLink.directiveOf("{\"directive\":\"text=a\"}"))
        // A raw space, a bare ampersand or a quote is not the page script's encoding: not put in a URL.
        assertNull(TextFragmentLink.directiveOf("\"text=ledger did\""))
        assertNull(TextFragmentLink.directiveOf("\"text=a&text=b\""))
        assertNull(TextFragmentLink.directiveOf("\"text=a#b\""))
        assertNull(TextFragmentLink.directiveOf("\"text=\\u4eac\""))
    }

    // --- the link ------------------------------------------------------------------------------------

    @Test
    fun appendsTheDirectiveAsTheFragmentDirective() {
        assertEquals(
            "https://example.test/article#:~:text=ledger%20did%20not%20care",
            TextFragmentLink.linkTo("https://example.test/article", "text=ledger%20did%20not%20care")
        )
    }

    @Test
    fun keepsThePagesOwnFragmentAheadOfTheDirective() {
        assertEquals(
            "https://example.test/article?q=1#section-2:~:text=ledger",
            TextFragmentLink.linkTo("https://example.test/article?q=1#section-2", "text=ledger")
        )
    }

    @Test
    fun replacesAnEarlierFragmentDirective() {
        assertEquals(
            "https://example.test/article#:~:text=steps",
            TextFragmentLink.linkTo("https://example.test/article#:~:text=ledger", "text=steps")
        )
        assertEquals(
            "https://example.test/article#top:~:text=steps",
            TextFragmentLink.linkTo("https://example.test/article#top:~:text=ledger&text=care", "text=steps")
        )
    }

    @Test
    fun leavesAUrlWithEncodedOrUnicodeCharactersAlone() {
        assertEquals(
            "https://example.test/p%C3%A4th?q=a%26b#:~:text=%E4%BA%AC%E9%83%BD",
            TextFragmentLink.linkTo("https://example.test/p%C3%A4th?q=a%26b", "text=%E4%BA%AC%E9%83%BD")
        )
        assertEquals(
            "https://例え.test/道#:~:text=a%2Db",
            TextFragmentLink.linkTo("https://例え.test/道", "text=a%2Db")
        )
    }

    @Test
    fun noLinkForAPageNotOfferedOrADirectiveNotThePageScripts() {
        assertNull(TextFragmentLink.linkTo("zen://settings/", "text=ledger"))
        assertNull(TextFragmentLink.linkTo("file:///page.html", "text=ledger"))
        assertNull(TextFragmentLink.linkTo(null, "text=ledger"))
        assertNull(TextFragmentLink.linkTo("https://example.test/", null))
        assertNull(TextFragmentLink.linkTo("https://example.test/", "ledger"))
        assertNull(TextFragmentLink.linkTo("https://example.test/", "text=a b"))
    }

    // --- the script -----------------------------------------------------------------------------------

    @Test
    fun theScriptDispatchesTheEventThePageScriptListensFor() {
        assertTrue(TextFragmentLink.GENERATE_SCRIPT.contains("new CustomEvent(\"${TextFragmentLink.EVENT}\""))
        assertEquals("zen-text-fragment-link", TextFragmentLink.EVENT)
        assertTrue(TextFragmentLink.GENERATE_SCRIPT.contains("detail:d"))
        assertTrue(TextFragmentLink.GENERATE_SCRIPT.contains("return typeof d.directive===\"string\"?d.directive:null"))
    }

    @Test
    fun theLabelIsChromesInSentenceCase() {
        assertEquals("Copy link to highlight", TextFragmentLink.TITLE)
    }
}
