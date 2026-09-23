package app.zen.chromium

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
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
}
