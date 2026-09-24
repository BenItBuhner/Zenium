package app.zen.chromium

import android.app.PendingIntent
import android.content.Intent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class SearchWidgetTest {
    private val faces = SearchWidgetProvider.FACES

    @Test
    fun theFaceHasThreePartsInTheLayoutsOrder() {
        assertEquals(
            listOf(R.id.widget_search_face, R.id.widget_search_mic, R.id.widget_search_private),
            faces.map { it.viewId }
        )
    }

    @Test
    fun eachPartLandsWhereItsGlyphSays() {
        val byView = faces.associate { it.viewId to it.landing }
        assertEquals(Landing.SEARCH, byView[R.id.widget_search_face])
        assertEquals(Landing.VOICE, byView[R.id.widget_search_mic])
        assertEquals(Landing.PRIVATE, byView[R.id.widget_search_private])
    }

    @Test
    fun everyLandingIsAWordTheReaderKnows() {
        for (face in faces) assertEquals(face.landing, Landing.parse(face.landing))
    }

    @Test
    fun theRequestCodesDifferSoTheThreePendingIntentsStayThree() {
        // Intent.filterEquals ignores extras: with one request code the launcher would hold a
        // single PendingIntent for the three parts, carrying whichever landing was written last.
        assertEquals(faces.size, faces.map { it.requestCode }.toSet().size)
        assertTrue(faces.all { it.requestCode > 0 })
    }

    @Test
    fun theLaunchersTokensAreImmutableAndUpdatedInPlace() {
        val flags = SearchWidgetProvider.PENDING_INTENT_FLAGS
        // Android 12 refuses a token that says neither; the launcher must not rewrite the landing.
        assertNotEquals(0, flags and PendingIntent.FLAG_IMMUTABLE)
        assertEquals(0, flags and PendingIntent.FLAG_MUTABLE)
        // A rebuilt face refreshes the launcher's token under its request code; it neither
        // cancels the launcher's copy (a tap between the two would fire nothing) nor asks for
        // an existing one only, and a widget's tap is never one-shot.
        assertNotEquals(0, flags and PendingIntent.FLAG_UPDATE_CURRENT)
        assertEquals(0, flags and PendingIntent.FLAG_CANCEL_CURRENT)
        assertEquals(0, flags and PendingIntent.FLAG_NO_CREATE)
        assertEquals(0, flags and PendingIntent.FLAG_ONE_SHOT)
    }

    @Test
    fun theFacesIntentIsALauncherIntentInATaskOfItsOwn() {
        // ACTION_MAIN with a component: the browser's own launch, as the launcher icon's, so a
        // singleTask MainActivity hears it in onNewIntent when running and in onCreate when not.
        assertEquals(Intent.ACTION_MAIN, SearchWidgetProvider.INTENT_ACTION)
        // From a launcher's process there is no task to join without NEW_TASK.
        assertNotEquals(0, SearchWidgetProvider.INTENT_FLAGS and Intent.FLAG_ACTIVITY_NEW_TASK)
        // Not CLEAR_TASK: a running window keeps its tabs and lands warm (the manifest shortcuts
        // arrive with it stamped by the system and ride the trampoline for that reason).
        assertEquals(0, SearchWidgetProvider.INTENT_FLAGS and Intent.FLAG_ACTIVITY_CLEAR_TASK)
    }
}
