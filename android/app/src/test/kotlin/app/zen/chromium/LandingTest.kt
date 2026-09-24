package app.zen.chromium

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class LandingTest {
    @Test
    fun theFiveStatesParseToTheirCanonicalWord() {
        assertEquals(Landing.SEARCH, Landing.parse("search"))
        assertEquals(Landing.VOICE, Landing.parse("voice"))
        assertEquals(Landing.PRIVATE, Landing.parse("private"))
        assertEquals(Landing.SCAN, Landing.parse("scan"))
        assertEquals(Landing.NEW_TAB, Landing.parse("newTab"))
    }

    @Test
    fun caseAndBlanksAreForgivenButTheCanonicalWordIsWhatComesBack() {
        assertEquals(Landing.SEARCH, Landing.parse("  Search "))
        assertEquals(Landing.VOICE, Landing.parse("VOICE"))
        assertEquals(Landing.NEW_TAB, Landing.parse("newtab"))
    }

    @Test
    fun anythingElseIsNoLanding() {
        assertNull(Landing.parse(null))
        assertNull(Landing.parse(""))
        assertNull(Landing.parse("   "))
        assertNull(Landing.parse("lens"))
        assertNull(Landing.parse("search voice"))
        assertNull(Landing.parse("https://example.com/"))
    }

    @Test
    fun theTrampolineCarriesTheExtraOverAndReadsTheOldShortcutsActionAsPrivate() {
        assertEquals(Landing.SEARCH, Landing.forwarded(null, "search"))
        assertEquals(Landing.SCAN, Landing.forwarded("android.intent.action.MAIN", "scan"))
        // The shortcut from before the extra: its action alone names the private landing.
        assertEquals(Landing.PRIVATE, Landing.forwarded(PrivateBrowsing.ACTION_NEW_TAB, null))
        // An extra on the private action wins over the action's implied landing (one word, one reader).
        assertEquals(Landing.PRIVATE, Landing.forwarded(PrivateBrowsing.ACTION_NEW_TAB, "private"))
        // A plain launcher tap on an icon alias lands nowhere in particular.
        assertNull(Landing.forwarded("android.intent.action.MAIN", null))
        assertNull(Landing.forwarded(null, null))
        assertNull(Landing.forwarded("android.intent.action.VIEW", "lens"))
    }

    // --- the stash: how a cold start's landing rides the boot answer ---------------------------

    @Test
    fun aLandingBeforeTheBootRidesTheBootAnswerOnce() {
        val stash = Landing.Stash()
        // onCreate: the widget's intent, the chrome document still loading.
        assertTrue(stash.offer(Landing.SEARCH))
        // The core's boot call takes it into the answer...
        assertEquals(Landing.SEARCH, stash.take())
        // ...once: the next boot of this document (there is none) would carry nothing.
        assertNull(stash.take())
    }

    @Test
    fun aStartWithNoLandingReadsOneNull() {
        val stash = Landing.Stash()
        assertNull(stash.take())
    }

    @Test
    fun aLandingAfterTheBootIsDeclinedForTheWarmPath() {
        val stash = Landing.Stash()
        assertNull(stash.take())
        // onNewIntent, the core up: not stashed – the caller sends it to the host global at once.
        assertFalse(stash.offer(Landing.VOICE))
        // And it never leaks into a later answer.
        assertNull(stash.take())
    }

    @Test
    fun theLastLandingBeforeTheBootIsTheOneTheBootCarries() {
        val stash = Landing.Stash()
        assertTrue(stash.offer(Landing.SEARCH))
        assertTrue(stash.offer(Landing.SCAN))
        assertEquals(Landing.SCAN, stash.take())
    }

    @Test
    fun aReplacedChromeDocumentTakesTheNextLandingIntoItsOwnBootAnswer() {
        val stash = Landing.Stash()
        assertEquals(null, stash.take())
        assertFalse(stash.offer(Landing.PRIVATE))
        // The chrome reloaded its document (onPageStarted): its core has not booted yet.
        stash.reset()
        assertTrue(stash.offer(Landing.NEW_TAB))
        assertEquals(Landing.NEW_TAB, stash.take())
        assertFalse(stash.offer(Landing.SEARCH))
    }
}
