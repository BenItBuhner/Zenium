package app.zen.chromium

import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class VoiceLogicTest {
    // --- the permission-state machine -----------------------------------------------------------

    @Test
    fun aGrantIsGrantedWhateverTheRationaleSays() {
        assertEquals(RuntimeGrant.GRANTED, RuntimeGrant.of(granted = true, canAskAgain = true))
        assertEquals(RuntimeGrant.GRANTED, RuntimeGrant.of(granted = true, canAskAgain = false))
    }

    @Test
    fun aRefusalTheSystemWouldAskAboutAgainIsForThisOnce() {
        assertEquals(RuntimeGrant.DENIED, RuntimeGrant.of(granted = false, canAskAgain = true))
    }

    @Test
    fun aRefusalTheSystemWouldNotAskAboutAgainIsForGood() {
        assertEquals(RuntimeGrant.DENIED_PERMANENTLY, RuntimeGrant.of(granted = false, canAskAgain = false))
    }

    @Test
    fun theGrantAnswersVoiceStartByTheChromesNames() {
        assertEquals("listening", VoiceLogic.outcome(RuntimeGrant.GRANTED))
        assertEquals("denied", VoiceLogic.outcome(RuntimeGrant.DENIED))
        assertEquals("denied-permanently", VoiceLogic.outcome(RuntimeGrant.DENIED_PERMANENTLY))
    }

    // --- what the recogniser is asked for ---------------------------------------------------------

    @Test
    fun theIntentAsksForAFreeFormSearchInTheAppsLanguageWithPartialResults() {
        val extras = VoiceLogic.recognitionExtras("pt-BR", "app.zen.chromium")
        assertEquals(RecognizerIntent.LANGUAGE_MODEL_FREE_FORM, extras[RecognizerIntent.EXTRA_LANGUAGE_MODEL])
        assertEquals("pt-BR", extras[RecognizerIntent.EXTRA_LANGUAGE])
        assertEquals(true, extras[RecognizerIntent.EXTRA_PARTIAL_RESULTS])
        assertEquals("app.zen.chromium", extras[RecognizerIntent.EXTRA_CALLING_PACKAGE])
        assertEquals(1, extras[RecognizerIntent.EXTRA_MAX_RESULTS])
    }

    @Test
    fun theIntentNeverAsksForAnOfflineOnlyEngine() {
        // EXTRA_PREFER_OFFLINE means offline only: a device without a downloaded pack for the
        // language would end every session in ERROR_LANGUAGE_UNAVAILABLE or ERROR_NETWORK.
        val extras = VoiceLogic.recognitionExtras("en-US", "app.zen.chromium")
        assertFalse(extras.containsKey(RecognizerIntent.EXTRA_PREFER_OFFLINE))
        assertFalse(extras.containsKey("android.speech.extra.PREFER_OFFLINE"))
        // And nothing else that narrows the engine's choice.
        assertEquals(
            setOf(
                RecognizerIntent.EXTRA_LANGUAGE_MODEL,
                RecognizerIntent.EXTRA_LANGUAGE,
                RecognizerIntent.EXTRA_PARTIAL_RESULTS,
                RecognizerIntent.EXTRA_CALLING_PACKAGE,
                RecognizerIntent.EXTRA_MAX_RESULTS,
            ),
            extras.keys,
        )
    }

    // --- the recogniser's errors ------------------------------------------------------------------

    @Test
    fun errorsReadByTheNamesTheChromeKnows() {
        assertEquals("no-match", VoiceLogic.errorName(SpeechRecognizer.ERROR_NO_MATCH))
        assertEquals("speech-timeout", VoiceLogic.errorName(SpeechRecognizer.ERROR_SPEECH_TIMEOUT))
        assertEquals("network", VoiceLogic.errorName(SpeechRecognizer.ERROR_NETWORK))
        assertEquals("network", VoiceLogic.errorName(SpeechRecognizer.ERROR_NETWORK_TIMEOUT))
        assertEquals("busy", VoiceLogic.errorName(SpeechRecognizer.ERROR_RECOGNIZER_BUSY))
        assertEquals("audio", VoiceLogic.errorName(SpeechRecognizer.ERROR_AUDIO))
        assertEquals("client", VoiceLogic.errorName(SpeechRecognizer.ERROR_CLIENT))
        assertEquals("server", VoiceLogic.errorName(SpeechRecognizer.ERROR_SERVER))
        assertEquals("server", VoiceLogic.errorName(VoiceLogic.ERROR_SERVER_DISCONNECTED))
        assertEquals("server", VoiceLogic.errorName(VoiceLogic.ERROR_TOO_MANY_REQUESTS))
        assertEquals("permissions", VoiceLogic.errorName(SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS))
        assertEquals("language", VoiceLogic.errorName(VoiceLogic.ERROR_LANGUAGE_NOT_SUPPORTED))
        assertEquals("language", VoiceLogic.errorName(VoiceLogic.ERROR_LANGUAGE_UNAVAILABLE))
    }

    @Test
    fun aCodeFromTheFutureIsUnknown() {
        assertEquals("unknown", VoiceLogic.errorName(99))
        assertEquals("unknown", VoiceLogic.errorName(0))
    }

    // --- the level the glyph pulses on ------------------------------------------------------------

    @Test
    fun theLevelSpansSilenceToLoudSpeech() {
        assertEquals(0f, VoiceLogic.level(-2f), 0f)
        assertEquals(1f, VoiceLogic.level(10f), 0f)
        assertEquals(0.5f, VoiceLogic.level(4f), 1e-6f)
    }

    @Test
    fun theLevelClipsOutsideThatRangeAndSurvivesNaN() {
        assertEquals(0f, VoiceLogic.level(-8f), 0f)
        assertEquals(1f, VoiceLogic.level(14f), 0f)
        assertEquals(0f, VoiceLogic.level(Float.NaN), 0f)
    }

    // --- the throttle between the recogniser and the bridge ---------------------------------------

    @Test
    fun theFirstLevelGoesAndTheNextWaitsForTheInterval() {
        val throttle = VoiceLogic.RmsThrottle(minIntervalMs = 50, minDelta = 0.04f)
        assertTrue(throttle.accept(1_000, 0.3f))
        assertFalse(throttle.accept(1_020, 0.6f))
        assertTrue(throttle.accept(1_050, 0.6f))
    }

    @Test
    fun aLevelThatBarelyMovedIsNotWorthTheTrip() {
        val throttle = VoiceLogic.RmsThrottle(minIntervalMs = 50, minDelta = 0.04f)
        assertTrue(throttle.accept(1_000, 0.30f))
        assertFalse(throttle.accept(1_100, 0.32f))
        assertTrue(throttle.accept(1_200, 0.36f))
    }

    @Test
    fun aDropToSilenceAlwaysGoesSoTheHaloSettles() {
        val throttle = VoiceLogic.RmsThrottle(minIntervalMs = 50, minDelta = 0.04f)
        assertTrue(throttle.accept(1_000, 0.8f))
        assertTrue(throttle.accept(1_010, 0f))
        // Silence after silence is nothing new.
        assertFalse(throttle.accept(1_100, 0f))
    }

    @Test
    fun aResetForgetsTheLastSession() {
        val throttle = VoiceLogic.RmsThrottle(minIntervalMs = 50, minDelta = 0.04f)
        assertTrue(throttle.accept(1_000, 0.5f))
        throttle.reset()
        assertTrue(throttle.accept(1_001, 0.5f))
    }
}
