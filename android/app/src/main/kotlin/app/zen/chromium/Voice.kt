package app.zen.chromium

import android.Manifest
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.os.SystemClock
import android.provider.Settings
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.util.Log
import java.util.Locale

/**
 * Voice search's host half (OMN-19): the device's [SpeechRecognizer] behind the chrome's mic
 * buttons. `voice.start` asks for the microphone (the runtime prompt through
 * [Permissions.requestForApp]) and starts the recogniser in the user's language with partial
 * results, preferring the offline engine; what the recogniser then reports goes to the chrome as
 * `voice.event`s (`VoiceEvent` in `src/shared/voice.ts`): `ready`, `begin`, the sound level from
 * `onRmsChanged` as `rms` (throttled, [VoiceLogic.RmsThrottle]), `partial` transcripts, `end` of
 * speech, then one `result` or one `error` – after which the recogniser is gone. The chrome owns
 * the listening sheet and the submit; this class owns nothing but the recogniser and its life.
 *
 * Whether the device has a recogniser at all ([available], `SpeechRecognizer.isRecognitionAvailable`,
 * which needs the manifest's `<queries>` for `android.speech.RecognitionService` on Android 11+)
 * goes to the chrome at boot as the `voiceSearch` capability; without it no mic button shows.
 *
 * Testing seam: the emulator has no microphone and the demo image no recogniser service, so the
 * demo driver (`VoiceDemo` under androidTest) installs a stand-in through [recognizerFactory]
 * before the activity starts and forces [availabilityOverride]; its `result`, `partial` and
 * `error` calls reach the chrome through the same listener the platform's recogniser would use,
 * which is how the result path is proven end to end on a device that cannot hear.
 */
class Voice(private val host: Host) {
    /** What [Voice] drives: the platform's [SpeechRecognizer], or the driver's stand-in for it. */
    interface Recognizer {
        /** Start listening; every report goes to `listener` on the main thread, as the platform's do. */
        fun start(intent: Intent, listener: RecognitionListener)
        /** Stop without a result; nothing more reaches the listener. */
        fun cancel()
        fun destroy()
    }

    private val activity get() = host.activity
    private var recognizer: Recognizer? = null
    /** Counts the sessions, so a report from a recogniser already let go is ignored. */
    private var session = 0
    private val throttle = VoiceLogic.RmsThrottle()

    /** The device has a speech recogniser the chrome's mic buttons can start. */
    val available: Boolean
        get() = availabilityOverride ?: runCatching { SpeechRecognizer.isRecognitionAvailable(activity) }.getOrDefault(false)

    /**
     * `voice.start`: the microphone first (granted before, or the system prompt now), then the
     * recogniser. `reply` gets a `VoiceStartOutcome`: `listening` once the recogniser is started,
     * the grant's name for a refusal, `unavailable` where there is no recogniser or it would not
     * start. A `voice.cancel` while the prompt is up (the sheet backed away) is honoured by not
     * starting; the reply then still says what the prompt answered, which the chrome ignores for
     * a sheet it has already taken down.
     */
    fun start(reply: (Any?) -> Unit) {
        if (!available) {
            reply("unavailable")
            return
        }
        val id = ++session
        stopRecognizer()
        host.permissions.requestForApp(Manifest.permission.RECORD_AUDIO) { grant ->
            if (grant != RuntimeGrant.GRANTED) {
                reply(VoiceLogic.outcome(grant))
                return@requestForApp
            }
            if (id != session) {
                reply(VoiceLogic.outcome(grant))
                return@requestForApp
            }
            reply(if (listen(id)) "listening" else "unavailable")
        }
    }

    /** `voice.cancel`: Cancel, the sheet dismissed – the recogniser stops and says nothing more. */
    fun cancel() {
        session++
        stopRecognizer()
    }

    /**
     * The app left the screen while listening: the recogniser stops, and the chrome hears
     * `aborted` so the sheet goes without a toast (the user did not do anything wrong).
     */
    fun abort() {
        if (recognizer == null) return
        cancel()
        event(json("kind" to "aborted"))
    }

    /** `voice.openSettings`: the app's details page in Settings, where a refused microphone is turned back on. */
    fun openSettings() {
        val intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${activity.packageName}"))
        try {
            activity.startActivity(intent)
        } catch (e: ActivityNotFoundException) {
            Log.w(TAG, "no application details screen")
        }
    }

    fun destroy() {
        cancel()
    }

    private fun listen(id: Int): Boolean {
        stopRecognizer()
        val recognizer = runCatching {
            recognizerFactory?.invoke(activity) ?: PlatformRecognizer(activity)
        }.getOrElse { e ->
            Log.w(TAG, "no recogniser: ${e.message}")
            return false
        }
        this.recognizer = recognizer
        throttle.reset()
        val started = runCatching { recognizer.start(recognitionIntent(activity), Listener(id)) }
        if (started.isFailure) {
            Log.w(TAG, "the recogniser would not start: ${started.exceptionOrNull()?.message}")
            stopRecognizer()
            return false
        }
        return true
    }

    private fun stopRecognizer() {
        val gone = recognizer ?: return
        recognizer = null
        runCatching { gone.cancel() }
        runCatching { gone.destroy() }
    }

    private fun event(payload: Any?) = host.hostEvent("voice.event", payload)

    /**
     * The recogniser's reports for session `id`, each checked against the live session: the
     * platform keeps reporting for a moment after `cancel`, and some engines send an error right
     * after the result. After the result or the error the recogniser is let go.
     */
    private inner class Listener(private val id: Int) : RecognitionListener {
        private fun live(): Boolean = id == session && recognizer != null

        override fun onReadyForSpeech(params: Bundle?) {
            if (live()) event(json("kind" to "ready"))
        }

        override fun onBeginningOfSpeech() {
            if (live()) event(json("kind" to "begin"))
        }

        override fun onRmsChanged(rmsdB: Float) {
            if (!live()) return
            val level = VoiceLogic.level(rmsdB)
            if (throttle.accept(SystemClock.uptimeMillis(), level)) event(json("kind" to "rms", "level" to level.toDouble()))
        }

        override fun onBufferReceived(buffer: ByteArray?) {}

        override fun onEndOfSpeech() {
            if (live()) event(json("kind" to "end"))
        }

        override fun onError(error: Int) {
            if (!live()) return
            stopRecognizer()
            event(json("kind" to "error", "error" to VoiceLogic.errorName(error)))
        }

        override fun onResults(results: Bundle?) {
            if (!live()) return
            stopRecognizer()
            event(json("kind" to "result", "text" to firstResult(results)))
        }

        override fun onPartialResults(partialResults: Bundle?) {
            if (!live()) return
            val text = firstResult(partialResults)
            if (text.isNotEmpty()) event(json("kind" to "partial", "text" to text))
        }

        override fun onEvent(eventType: Int, params: Bundle?) {}
    }

    /** The platform's recogniser as a [Recognizer]; created on the main thread, as the platform requires. */
    private class PlatformRecognizer(context: Context) : Recognizer {
        private val speech: SpeechRecognizer = SpeechRecognizer.createSpeechRecognizer(context)
            ?: throw IllegalStateException("SpeechRecognizer.createSpeechRecognizer returned null")

        override fun start(intent: Intent, listener: RecognitionListener) {
            speech.setRecognitionListener(listener)
            speech.startListening(intent)
        }

        override fun cancel() = speech.cancel()

        override fun destroy() = speech.destroy()
    }

    companion object {
        private const val TAG = "ZenVoice"

        /** Testing: builds the recogniser instead of the platform's (set before the activity starts). */
        @Volatile
        var recognizerFactory: ((Context) -> Recognizer)? = null

        /** Testing: what [available] answers instead of asking the platform. */
        @Volatile
        var availabilityOverride: Boolean? = null

        /**
         * `ACTION_RECOGNIZE_SPEECH` for a free-form search in the app's language: partial results
         * for the sheet's body copy, the offline engine preferred where the device has one (the
         * platform falls back to the online one where it has not), one result.
         */
        fun recognitionIntent(context: Context): Intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            putExtra(RecognizerIntent.EXTRA_LANGUAGE, appLocale(context).toLanguageTag())
            putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
            putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true)
            putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, context.packageName)
            putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
        }

        /** The language the app runs in (a per-app language on Android 13+ counts), else the device's. */
        private fun appLocale(context: Context): Locale =
            context.resources.configuration.locales.get(0) ?: Locale.getDefault()

        /** The best transcript in a results bundle; "" when it has none (the chrome reads that as a no-match). */
        fun firstResult(results: Bundle?): String =
            results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull { it.isNotBlank() } ?: ""
    }
}
