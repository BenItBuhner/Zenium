package app.zen.chromium

import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer

/**
 * What is pure about voice search on the host side (OMN-19), kept apart from [Voice] so it runs
 * on the JVM: how a refusal of the microphone reads, what the recogniser is asked for, the
 * recogniser's error codes by the names the chrome knows (`VoiceError` in `src/shared/voice.ts`),
 * the sound level the mic glyph pulses on, and how often that level is worth a trip over the
 * bridge.
 */
object VoiceLogic {
    /**
     * The extras of the `ACTION_RECOGNIZE_SPEECH` intent a session starts with ([Voice.recognitionIntent]
     * puts them on the intent): a free-form model in the app's language, partial results for the
     * sheet's body copy, the calling package, one result. No `EXTRA_PREFER_OFFLINE`: the extra
     * means offline ONLY, not offline first, so on a device whose engine has no downloaded pack
     * for the language every session would end in `ERROR_LANGUAGE_UNAVAILABLE` or `ERROR_NETWORK`
     * with a misleading toast; the engine chooses instead, as it does for Chrome's omnibox.
     * Preferring the on-device engine where API 33+'s `checkRecognitionSupport` reports the
     * language installed is a follow-up, not this.
     */
    fun recognitionExtras(languageTag: String, callingPackage: String): Map<String, Any> = linkedMapOf(
        RecognizerIntent.EXTRA_LANGUAGE_MODEL to RecognizerIntent.LANGUAGE_MODEL_FREE_FORM,
        RecognizerIntent.EXTRA_LANGUAGE to languageTag,
        RecognizerIntent.EXTRA_PARTIAL_RESULTS to true,
        RecognizerIntent.EXTRA_CALLING_PACKAGE to callingPackage,
        RecognizerIntent.EXTRA_MAX_RESULTS to 1,
    )

    /**
     * What `voice.start` answers for the microphone's grant (`VoiceStartOutcome` in
     * `src/shared/voice.ts`): a granted microphone means the recogniser starts and the answer is
     * `listening`; a refusal for this once and one for good read differently, since only the
     * second gets the toast's Open settings action.
     */
    fun outcome(grant: RuntimeGrant): String = when (grant) {
        RuntimeGrant.GRANTED -> "listening"
        RuntimeGrant.DENIED -> "denied"
        RuntimeGrant.DENIED_PERMANENTLY -> "denied-permanently"
    }

    /** `SpeechRecognizer.ERROR_*` by the name `voice.event` carries; codes newer than this list read as `unknown`. */
    fun errorName(code: Int): String = when (code) {
        SpeechRecognizer.ERROR_NO_MATCH -> "no-match"
        SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> "speech-timeout"
        SpeechRecognizer.ERROR_NETWORK, SpeechRecognizer.ERROR_NETWORK_TIMEOUT -> "network"
        SpeechRecognizer.ERROR_RECOGNIZER_BUSY -> "busy"
        SpeechRecognizer.ERROR_AUDIO -> "audio"
        SpeechRecognizer.ERROR_CLIENT -> "client"
        SpeechRecognizer.ERROR_SERVER, ERROR_SERVER_DISCONNECTED, ERROR_TOO_MANY_REQUESTS -> "server"
        SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "permissions"
        ERROR_LANGUAGE_NOT_SUPPORTED, ERROR_LANGUAGE_UNAVAILABLE -> "language"
        else -> "unknown"
    }

    /**
     * The level behind `onRmsChanged`'s dB figure, 0 (silence) to 1: the recogniser reports about
     * -2 dB for silence and around 10 dB for speech close to the microphone, so the pulse spans
     * that range and clips beyond it.
     */
    fun level(rmsDb: Float): Float {
        if (rmsDb.isNaN()) return 0f
        return ((rmsDb - RMS_SILENCE_DB) / (RMS_LOUD_DB - RMS_SILENCE_DB)).coerceIn(0f, 1f)
    }

    /**
     * `onRmsChanged` arrives many times a second; every report is a script evaluated in the chrome,
     * so the level crosses the bridge at most every [minIntervalMs] and only when it moved by more
     * than [minDelta] – except a drop back to silence, which always goes so the halo settles.
     */
    class RmsThrottle(private val minIntervalMs: Long = 50, private val minDelta: Float = 0.04f) {
        private var lastAt = Long.MIN_VALUE
        private var lastLevel = -1f

        /** True when `level` at `nowMs` is worth sending; the throttle then remembers it as sent. */
        fun accept(nowMs: Long, level: Float): Boolean {
            val settling = level == 0f && lastLevel != 0f
            if (!settling) {
                if (lastAt != Long.MIN_VALUE && nowMs - lastAt < minIntervalMs) return false
                if (lastLevel >= 0f && kotlin.math.abs(level - lastLevel) < minDelta) return false
            }
            lastAt = nowMs
            lastLevel = level
            return true
        }

        fun reset() {
            lastAt = Long.MIN_VALUE
            lastLevel = -1f
        }
    }

    /**
     * `SpeechRecognizer.ERROR_*` codes added in API 31, by value: a recogniser on an older release
     * never sends them, and spelling them out keeps lint's InlinedApi quiet about minSdk 26.
     */
    const val ERROR_LANGUAGE_NOT_SUPPORTED = 12
    const val ERROR_LANGUAGE_UNAVAILABLE = 13
    const val ERROR_SERVER_DISCONNECTED = 14
    const val ERROR_TOO_MANY_REQUESTS = 15

    private const val RMS_SILENCE_DB = -2f
    private const val RMS_LOUD_DB = 10f
}
