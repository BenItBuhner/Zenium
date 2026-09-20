package app.zen.chromium

import android.media.AudioManager
import android.speech.tts.TextToSpeech
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Locale

/**
 * Read aloud's host logic (A11Y-06 / EDGE-11): the engine's voices as the pickers' list, the
 * rate, the one-utterance queue's rule, the progress callbacks as `speech.event`s and the
 * audio-focus decisions of the media-session source note's 2.4.
 */
class ReadAloudLogicTest {
    private fun voice(
        name: String,
        tag: String,
        quality: Int = 300,
        network: Boolean = false,
        features: Set<String> = emptySet()
    ) = ReadAloudLogic.EngineVoice(name, Locale.forLanguageTag(tag), quality, network, features)

    private fun rows(array: JSONArray): List<JSONObject> = (0 until array.length()).map { array.getJSONObject(it) }

    // --- the voice list -----------------------------------------------------------------------------

    @Test
    fun theDefaultVoiceComesFirstThenOnDeviceBeforeNetworkThenBetterBeforeWorse() {
        val out = rows(
            ReadAloudLogic.voices(
                listOf(
                    voice("en-gb-x-gbb-network", "en-GB", quality = 500, network = true),
                    voice("en-gb-x-gbc-local", "en-GB", quality = 400),
                    voice("en-gb-x-gbb-local", "en-GB", quality = 300),
                    voice("de-de-x-deb-local", "de-DE", quality = 400),
                    voice("en-GB-language", "en-GB", quality = 300)
                ),
                defaultName = "en-GB-language",
                display = Locale.ENGLISH
            )
        )
        assertEquals(
            listOf("en-GB-language", "de-de-x-deb-local", "en-gb-x-gbc-local", "en-gb-x-gbb-local", "en-gb-x-gbb-network"),
            out.map { it.getString("id") }
        )
        assertTrue(out[0].getBoolean("default"))
        assertFalse(out[1].has("default"))
    }

    @Test
    fun aVoiceWhoseDataIsNotInstalledIsLeftOutAndSoIsANamelessOne() {
        val out = rows(
            ReadAloudLogic.voices(
                listOf(
                    voice("fr-fr-x-frb-local", "fr-FR", features = setOf(ReadAloudLogic.FEATURE_NOT_INSTALLED)),
                    voice("", "fr-FR"),
                    voice("fr-fr-x-frc-local", "fr-FR")
                ),
                defaultName = null,
                display = Locale.ENGLISH
            )
        )
        assertEquals(listOf("fr-fr-x-frc-local"), out.map { it.getString("id") })
    }

    @Test
    fun aRowCarriesTheInterfacesFields() {
        val row = rows(
            ReadAloudLogic.voices(listOf(voice("en-us-x-sfg-network", "en-US", quality = 500, network = true)), null, Locale.ENGLISH)
        ).single()
        assertEquals("en-us-x-sfg-network", row.getString("id"))
        assertEquals("English (United States)", row.getString("name"))
        assertEquals("en-US", row.getString("lang"))
        assertFalse(row.getBoolean("local"))
        assertEquals("high", row.getString("quality"))
        assertFalse(row.has("default"))
    }

    @Test
    fun voicesSharingALocaleAreNumberedInRankOrderAndALoneOneIsNot() {
        val out = rows(
            ReadAloudLogic.voices(
                listOf(
                    voice("en-gb-x-gbb-network", "en-GB", quality = 500, network = true),
                    voice("en-gb-x-gbc-local", "en-GB", quality = 400),
                    voice("de-de-x-deb-local", "de-DE")
                ),
                defaultName = null,
                display = Locale.ENGLISH
            )
        )
        assertEquals(listOf("English (United Kingdom) 1", "German (Germany)", "English (United Kingdom) 2"), out.map { it.getString("name") })
        assertEquals(listOf("en-gb-x-gbc-local", "de-de-x-deb-local", "en-gb-x-gbb-network"), out.map { it.getString("id") })
    }

    @Test
    fun theLocaleIsSpeltInTheDisplayLanguage() {
        val row = rows(ReadAloudLogic.voices(listOf(voice("en-gb-x-gbb-local", "en-GB")), null, Locale.GERMAN)).single()
        assertEquals("Englisch (Vereinigtes Königreich)", row.getString("name"))
    }

    @Test
    fun theEnginesFiveGradesFoldToThree() {
        assertEquals("low", ReadAloudLogic.qualityName(100))
        assertEquals("low", ReadAloudLogic.qualityName(200))
        assertEquals("normal", ReadAloudLogic.qualityName(300))
        assertEquals("high", ReadAloudLogic.qualityName(400))
        assertEquals("high", ReadAloudLogic.qualityName(500))
    }

    // --- the rate and the text ------------------------------------------------------------------------

    @Test
    fun theRateIsClampedToTheLadderAndANonNumberIsOne() {
        assertEquals(1f, ReadAloudLogic.speechRate(1.0))
        assertEquals(1.25f, ReadAloudLogic.speechRate(1.25))
        assertEquals(0.5f, ReadAloudLogic.speechRate(0.1))
        assertEquals(4f, ReadAloudLogic.speechRate(9.0))
        assertEquals(1f, ReadAloudLogic.speechRate(Double.NaN))
        assertEquals(1f, ReadAloudLogic.speechRate(Double.POSITIVE_INFINITY))
    }

    @Test
    fun anUtteranceLongerThanTheEngineTakesIsCutThere() {
        assertEquals("abc", ReadAloudLogic.clip("abc", 4000))
        assertEquals("abcd", ReadAloudLogic.clip("abcdef", 4))
        assertEquals("abcdef", ReadAloudLogic.clip("abcdef", 0))
    }

    // --- the one-utterance queue ------------------------------------------------------------------------

    @Test
    fun aSpeakReplacesWhateverSpeaksUnlessItIsTheCurrentUtterance() {
        assertEquals(ReadAloudLogic.SpeakPlan.FLUSH, ReadAloudLogic.speakPlan("s2", ReadAloudLogic.QUEUE_FLUSH, "s1", emptyList()))
        assertEquals(ReadAloudLogic.SpeakPlan.FLUSH, ReadAloudLogic.speakPlan("s1", ReadAloudLogic.QUEUE_FLUSH, null, emptyList()))
        assertEquals(ReadAloudLogic.SpeakPlan.IGNORE, ReadAloudLogic.speakPlan("s1", ReadAloudLogic.QUEUE_FLUSH, "s1", emptyList()))
        // A prepared sentence the engine moved on to is the current one by then: asked for again, nothing restarts.
        assertEquals(ReadAloudLogic.SpeakPlan.IGNORE, ReadAloudLogic.speakPlan("s2", ReadAloudLogic.QUEUE_FLUSH, "s2", emptyList()))
        // Asked for while the first still speaks (the user skipped): it replaces the first.
        assertEquals(ReadAloudLogic.SpeakPlan.FLUSH, ReadAloudLogic.speakPlan("s2", ReadAloudLogic.QUEUE_FLUSH, "s1", listOf("s2")))
    }

    @Test
    fun aPrepareQueuesBehindTheCurrentOneOnceOnly() {
        assertEquals(ReadAloudLogic.SpeakPlan.ADD, ReadAloudLogic.speakPlan("s2", ReadAloudLogic.QUEUE_ADD, "s1", emptyList()))
        assertEquals(ReadAloudLogic.SpeakPlan.ADD, ReadAloudLogic.speakPlan("s3", ReadAloudLogic.QUEUE_ADD, "s1", listOf("s2")))
        assertEquals(ReadAloudLogic.SpeakPlan.IGNORE, ReadAloudLogic.speakPlan("s2", ReadAloudLogic.QUEUE_ADD, "s1", listOf("s2")))
        assertEquals(ReadAloudLogic.SpeakPlan.IGNORE, ReadAloudLogic.speakPlan("s1", ReadAloudLogic.QUEUE_ADD, "s1", emptyList()))
        // Nothing speaks: a prepare on an idle engine is spoken (QUEUE_ADD on an empty queue speaks at once).
        assertEquals(ReadAloudLogic.SpeakPlan.ADD, ReadAloudLogic.speakPlan("s1", ReadAloudLogic.QUEUE_ADD, null, emptyList()))
    }

    // --- the events -------------------------------------------------------------------------------------

    @Test
    fun theProgressCallbacksBecomeTheSpeechEventsTheCoreListensFor() {
        val start = ReadAloudLogic.startEvent("s1")
        assertEquals("s1", start.getString("utteranceId"))
        assertEquals("start", start.getString("type"))

        val word = ReadAloudLogic.wordEvent("s1", 4, 9)!!
        assertEquals("word", word.getString("type"))
        assertEquals(4, word.getInt("charIndex"))
        assertEquals(5, word.getInt("length"))

        assertEquals("end", ReadAloudLogic.endEvent("s1").getString("type"))

        val error = ReadAloudLogic.errorEvent("s1", "synthesis")
        assertEquals("error", error.getString("type"))
        assertEquals("synthesis", error.getString("message"))
    }

    @Test
    fun anEmptyOrBackwardsRangeIsNoWord() {
        assertNull(ReadAloudLogic.wordEvent("s1", 4, 4))
        assertNull(ReadAloudLogic.wordEvent("s1", 9, 4))
        assertNull(ReadAloudLogic.wordEvent("s1", -1, 4))
    }

    @Test
    fun theEnginesErrorCodesReadByName() {
        assertEquals("synthesis", ReadAloudLogic.errorName(TextToSpeech.ERROR_SYNTHESIS))
        assertEquals("service", ReadAloudLogic.errorName(TextToSpeech.ERROR_SERVICE))
        assertEquals("output", ReadAloudLogic.errorName(TextToSpeech.ERROR_OUTPUT))
        assertEquals("network", ReadAloudLogic.errorName(TextToSpeech.ERROR_NETWORK))
        assertEquals("network-timeout", ReadAloudLogic.errorName(TextToSpeech.ERROR_NETWORK_TIMEOUT))
        assertEquals("invalid-request", ReadAloudLogic.errorName(TextToSpeech.ERROR_INVALID_REQUEST))
        assertEquals("not-installed", ReadAloudLogic.errorName(TextToSpeech.ERROR_NOT_INSTALLED_YET))
        assertEquals("error", ReadAloudLogic.errorName(TextToSpeech.ERROR))
        assertEquals("unknown", ReadAloudLogic.errorName(-42))
    }

    // --- audio focus (the source note's 2.4) --------------------------------------------------------------

    private fun session(chrome: Boolean, playing: Boolean) = MediaSessionInfo(
        tabId = "t1", title = "Why coffee tastes different at altitude", artist = "example.org", album = "",
        artwork = null, playing = playing, video = false, width = 0, height = 0, duration = 0.0, position = 0.0,
        playbackRate = 1.0, hasPosition = false, positionAt = 0L, actions = setOf("play", "pause"), fullscreen = false,
        private = false, source = if (chrome) MediaSessionInfo.SOURCE_CHROME else MediaSessionInfo.SOURCE_PAGE,
        sourceId = if (chrome) "read-aloud" else null
    )

    @Test
    fun focusIsHeldWhileAChromePlayersSessionPlaysAndForNothingElse() {
        assertTrue(ReadAloudLogic.wantsFocus(session(chrome = true, playing = true)))
        assertFalse(ReadAloudLogic.wantsFocus(session(chrome = true, playing = false)))
        // A page's session: the WebView engine holds the pages' focus; a second request would take it from the page.
        assertFalse(ReadAloudLogic.wantsFocus(session(chrome = false, playing = true)))
        assertFalse(ReadAloudLogic.wantsFocus(null))
    }

    @Test
    fun everyLossPausesAndAGainResumesNothing() {
        assertEquals("pause", ReadAloudLogic.focusChangeAction(AudioManager.AUDIOFOCUS_LOSS))
        assertEquals("pause", ReadAloudLogic.focusChangeAction(AudioManager.AUDIOFOCUS_LOSS_TRANSIENT))
        assertEquals("pause", ReadAloudLogic.focusChangeAction(AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK))
        assertNull(ReadAloudLogic.focusChangeAction(AudioManager.AUDIOFOCUS_GAIN))
        assertNull(ReadAloudLogic.focusChangeAction(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT))
    }
}
