package app.zen.chromium

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The game widget's one face (WID-04): its landing, the word the reader knows, and a request code
 * of its own among the three widgets' – the intents differ by their extra alone and
 * `Intent.filterEquals` ignores extras, so a code shared with another face would fold the two
 * into one `PendingIntent` carrying whichever landing was written last.
 */
class GameWidgetTest {
    private val face = GameWidgetProvider.FACE

    @Test
    fun theFaceIsTheCardAndLandsOnTheGame() {
        assertEquals(R.id.widget_game_face, face.viewId)
        assertEquals(Landing.GAME, face.landing)
        assertEquals(GameWidgetProvider.REQUEST_CODE, face.requestCode)
    }

    @Test
    fun theLandingIsAWordTheReaderKnows() {
        assertEquals(face.landing, Landing.parse(face.landing))
        assertEquals(Landing.GAME, Landing.forwarded(SearchWidgetProvider.INTENT_ACTION, face.landing))
    }

    @Test
    fun theRequestCodeIsItsOwnAmongTheThreeWidgets() {
        val others = SearchWidgetProvider.FACES + QuickActionsWidgetProvider.FACES
        assertTrue(face.requestCode > 0)
        assertTrue("no other face shares code ${face.requestCode}", others.none { it.requestCode == face.requestCode })
        // Every face across the three providers keeps a code of its own.
        val all = others + face
        assertEquals(all.size, all.map { it.requestCode }.toSet().size)
    }
}
