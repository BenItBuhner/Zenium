package app.zen.chromium

import org.junit.Assert.assertEquals
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
}
