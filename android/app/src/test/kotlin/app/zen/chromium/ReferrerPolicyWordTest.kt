package app.zen.chromium

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The page's own referrer policy, told to the view ahead of the navigation it holds
 * (`ReferrerPolicyWord`): the anchor's word for the one navigation that follows it, the
 * document's meta for one without an anchor, nothing of another document's.
 */
class ReferrerPolicyWordTest {
    private val word = ReferrerPolicyWord(windowMs = 2_000L)
    private val site = "https://a.example"

    @Test
    fun theNextWordIsSpentByTheOneNavigationThatFollowsIt() {
        word.nextNavigation("no-referrer", now = 10_000L)
        assertEquals("no-referrer", word.forNavigation(site, now = 10_040L))
        // Spent: the next navigation through the hook is not the anchor's.
        assertEquals("", word.forNavigation(site, now = 10_050L))
    }

    @Test
    fun theNextWordBeatsTheDocumentsAndTheDocumentsStandsInAfterIt() {
        word.document("same-origin", site)
        word.nextNavigation("unsafe-url", now = 0L)
        assertEquals("unsafe-url", word.forNavigation(site, now = 10L))
        // `location.assign` a moment later: the document's meta governs it.
        assertEquals("same-origin", word.forNavigation(site, now = 500L))
        assertEquals("same-origin", word.documentPolicyFor(site))
    }

    @Test
    fun anAnchorWithoutAPolicyOfItsOwnSendsTheDocumentsAsItsWord() {
        // The script resolves the anchor against the document itself, so an empty next word is
        // the default even under a meta: the script would have sent the meta's token instead.
        word.document("no-referrer", site)
        word.nextNavigation("", now = 0L)
        assertEquals("", word.forNavigation(site, now = 10L))
    }

    @Test
    fun aNextWordOlderThanTheWindowIsNotRead() {
        word.nextNavigation("no-referrer", now = 0L)
        // A click whose navigation never came (a page that prevented it and did nothing): the
        // navigation two seconds on is not the click's.
        assertEquals("", word.forNavigation(site, now = 2_000L))
        // Nor is one dated before the click (a clock that went back).
        word.nextNavigation("no-referrer", now = 5_000L)
        assertEquals("", word.forNavigation(site, now = 4_990L))
    }

    @Test
    fun theDocumentWordIsReadOnlyForItsOwnOrigin() {
        word.document("no-referrer", site)
        assertEquals("no-referrer", word.forNavigation(site, now = 0L))
        assertEquals("", word.forNavigation("https://b.example", now = 0L))
        assertEquals("", word.forNavigation(null, now = 0L))
        // The port is part of the origin, as `location.origin` spells it.
        assertEquals("", word.forNavigation("https://a.example:8443", now = 0L))
    }

    @Test
    fun theLastDocumentWordWins() {
        word.document("no-referrer", site)
        word.document("origin", site)
        assertEquals("origin", word.forNavigation(site, now = 0L))
        // The meta removed or emptied: the script sends the default, and that is what stands.
        word.document("", site)
        assertEquals("", word.forNavigation(site, now = 0L))
    }

    @Test
    fun aDocumentStartingDropsTheNextWordAndAnotherOriginsDocumentWord() {
        word.nextNavigation("no-referrer", now = 0L)
        word.document("same-origin", site)
        // The same origin's document starts: its own word is on its way (or arrived already);
        // the old document's stands until it does, the click's is the old page's and goes.
        word.documentStarted(site)
        assertEquals("same-origin", word.forNavigation(site, now = 10L))
        // Another origin's document starts: nothing of the old page's is read.
        word.document("same-origin", site)
        word.documentStarted("https://b.example")
        assertEquals("", word.forNavigation(site, now = 20L))
        assertEquals("", word.forNavigation("https://b.example", now = 20L))
    }

    @Test
    fun aDocumentWordThatArrivedBeforeItsDocumentStartedSurvivesTheStart() {
        // The view cannot order the new document's message against its onPageStarted; a word
        // tagged with the starting document's own origin is that document's and stays.
        word.document("no-referrer", "https://b.example")
        word.documentStarted("https://b.example")
        assertEquals("no-referrer", word.forNavigation("https://b.example", now = 0L))
    }
}
