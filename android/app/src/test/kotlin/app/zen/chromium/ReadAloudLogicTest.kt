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

    @Test
    fun chromeTtsPitchAndVolumeAreClampedToWhatTheEngineTakesAndANonNumberIsOne() {
        // Chrome's pitch runs 0–2 with 1 the voice's own; `setPitch` refuses 0, so the floor sits just above it.
        assertEquals(1f, ReadAloudLogic.speechPitch(1.0))
        assertEquals(1.5f, ReadAloudLogic.speechPitch(1.5))
        assertEquals(0.1f, ReadAloudLogic.speechPitch(0.0))
        assertEquals(2f, ReadAloudLogic.speechPitch(7.0))
        assertEquals(1f, ReadAloudLogic.speechPitch(Double.NaN))
        // Volume 0–1 as `KEY_PARAM_VOLUME` takes it.
        assertEquals(1f, ReadAloudLogic.speechVolume(1.0))
        assertEquals(0.25f, ReadAloudLogic.speechVolume(0.25))
        assertEquals(0f, ReadAloudLogic.speechVolume(-1.0))
        assertEquals(1f, ReadAloudLogic.speechVolume(3.0))
        assertEquals(1f, ReadAloudLogic.speechVolume(Double.POSITIVE_INFINITY))
        // Read aloud sends neither: the options default to the voice's own.
        assertEquals(ReadAloudLogic.Options(null, "en", 1f, 1f, 1f), ReadAloudLogic.Options(null, "en", 1f))
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

    @Test
    fun aSpeedOrVoiceChangedDuringASentenceRestartsThePreparedNextOneWithIt() {
        val old = ReadAloudLogic.Options("en-gb-x-gba-local", "en-GB", 1f)
        val faster = old.copy(rate = 1.2f)
        val otherVoice = old.copy(voiceId = "en-gb-x-rjs-local")
        // Sentence 2 was prepared at 1x while sentence 1 spoke; the engine moved on to it, and the
        // core's `speak(s2)` at the end of sentence 1 carries the chip's new speed: the utterance
        // the engine has just begun is flushed and spoken again at 1.2x (N+1, not N+2).
        val had = mapOf("s2" to old)
        assertEquals(ReadAloudLogic.SpeakPlan.FLUSH, ReadAloudLogic.speakPlan("s2", ReadAloudLogic.QUEUE_FLUSH, "s2", emptyList(), faster, had))
        assertEquals(ReadAloudLogic.SpeakPlan.FLUSH, ReadAloudLogic.speakPlan("s2", ReadAloudLogic.QUEUE_FLUSH, "s2", emptyList(), otherVoice, had))
        // The same options: the gapless hand-off stands, nothing restarts.
        assertEquals(ReadAloudLogic.SpeakPlan.IGNORE, ReadAloudLogic.speakPlan("s2", ReadAloudLogic.QUEUE_FLUSH, "s2", emptyList(), old.copy(), had))
        // What the utterance was handed over with is not on record (never the case for one the
        // engine has, but the rule stays on the safe side): no restart on a guess.
        assertEquals(ReadAloudLogic.SpeakPlan.IGNORE, ReadAloudLogic.speakPlan("s2", ReadAloudLogic.QUEUE_FLUSH, "s2", emptyList(), faster, emptyMap()))
        assertEquals(ReadAloudLogic.SpeakPlan.IGNORE, ReadAloudLogic.speakPlan("s2", ReadAloudLogic.QUEUE_FLUSH, "s2", emptyList(), null, had))
        // A `prepare` never restarts anything, and another utterance's options are no reason to.
        assertEquals(ReadAloudLogic.SpeakPlan.IGNORE, ReadAloudLogic.speakPlan("s2", ReadAloudLogic.QUEUE_ADD, "s2", emptyList(), faster, had))
        assertEquals(ReadAloudLogic.SpeakPlan.FLUSH, ReadAloudLogic.speakPlan("s3", ReadAloudLogic.QUEUE_FLUSH, "s2", emptyList(), faster, had))
        assertEquals(ReadAloudLogic.SpeakPlan.IGNORE, ReadAloudLogic.speakPlan("s3", ReadAloudLogic.QUEUE_ADD, "s2", listOf("s3"), faster, mapOf("s2" to old, "s3" to old)))
        // `chrome.tts`'s knobs count as options too: a pitch or a volume changed restarts the current utterance with it.
        assertEquals(ReadAloudLogic.SpeakPlan.FLUSH, ReadAloudLogic.speakPlan("s2", ReadAloudLogic.QUEUE_FLUSH, "s2", emptyList(), old.copy(pitch = 1.4f), had))
        assertEquals(ReadAloudLogic.SpeakPlan.FLUSH, ReadAloudLogic.speakPlan("s2", ReadAloudLogic.QUEUE_FLUSH, "s2", emptyList(), old.copy(volume = 0.5f), had))
    }

    @Test
    fun aFlushReportsWhatItTookFromTheEngineAsInterruptedAndARestartIsNoInterruption() {
        // Another speaker's utterance and the one queued behind it go when a `speak` flushes the engine.
        assertEquals(listOf("s1", "s2"), ReadAloudLogic.dropped(ReadAloudLogic.SpeakPlan.FLUSH, "x1", "s1", listOf("s2")))
        assertEquals(listOf("s1"), ReadAloudLogic.dropped(ReadAloudLogic.SpeakPlan.FLUSH, "x1", "s1", emptyList()))
        assertEquals(emptyList<String>(), ReadAloudLogic.dropped(ReadAloudLogic.SpeakPlan.FLUSH, "x1", null, emptyList()))
        // The current utterance spoken again with new options is restarted, not interrupted; what waited behind it does go.
        assertEquals(listOf("s3"), ReadAloudLogic.dropped(ReadAloudLogic.SpeakPlan.FLUSH, "s2", "s2", listOf("s3")))
        // A prepare queues behind, an ignored speak changes nothing: nothing is dropped.
        assertEquals(emptyList<String>(), ReadAloudLogic.dropped(ReadAloudLogic.SpeakPlan.ADD, "s3", "s2", emptyList()))
        assertEquals(emptyList<String>(), ReadAloudLogic.dropped(ReadAloudLogic.SpeakPlan.IGNORE, "s2", "s2", listOf("s3")))
        // The report is the speech host's `error` with the shared `interrupted` message, so the core and `chrome.tts` read it the same way.
        val event = ReadAloudLogic.interruptedEvent("s1")
        assertEquals("s1", event.getString("utteranceId"))
        assertEquals("error", event.getString("type"))
        assertEquals("interrupted", event.getString("message"))
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
