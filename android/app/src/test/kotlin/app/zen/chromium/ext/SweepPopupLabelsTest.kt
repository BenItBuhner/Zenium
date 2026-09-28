package app.zen.chromium.ext

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SweepPopupLabelsTest {
    private val blackMenu = Regex("^(Pages|Apps|Settings|Search|Gemini|Maps|Translate|News|YouTube|Gmail|Calendar|Drive|Keep|Home|Saved|Advanced search|Advanced image search|Your data in Search)$")
    // WebView 156's tree of Black Menu's popup at round 24's BEFORE (the popup stage's labels).
    private val seen = listOf("Pages", "Apps", "Settings", "A Google user", "Please enter a search query", "Search", "Gemini", "Maps")

    @Test
    fun `the labels carrying the row's own words are its whole node texts, not a word inside another's`() {
        assertEquals(listOf("Pages", "Apps", "Settings", "Search", "Gemini", "Maps"), SweepPopupLabels.own(seen, blackMenu))
        assertEquals(emptyList<String>(), SweepPopupLabels.own(listOf("Search Google or type a URL", "Loading…"), blackMenu))
    }

    @Test
    fun `three own labels of a shown tree pass, fewer or an unshown tree do not`() {
        assertTrue(SweepPopupLabels.pass(SweepPopupLabels.own(seen, blackMenu), shown = true))
        assertFalse(SweepPopupLabels.pass(listOf("Search", "Maps"), shown = true))
        assertFalse(SweepPopupLabels.pass(SweepPopupLabels.own(seen, blackMenu), shown = false))
    }

    @Test
    fun `the word names the nodes, the own labels and the script's read`() {
        assertEquals(
            "read by accessibility – the document reads empty to a script (its UI is in a closed shadow root) and the sheet shows it: 71 nodes, 6 labels carrying the row's own words (\"Pages / Apps / Settings / Search / Gemini / Maps\"); the script read: {\"items\":0,\"labels\":[],\"app\":false,\"signIn\":false}",
            SweepPopupLabels.word(71, SweepPopupLabels.own(seen, blackMenu), "{\"items\":0,\"labels\":[],\"app\":false,\"signIn\":false}")
        )
    }
}
