package app.zen.chromium

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Handler
import android.os.Looper
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.speech.tts.Voice
import android.util.Log
import androidx.core.content.ContextCompat
import org.json.JSONArray
import org.json.JSONObject
import java.util.Locale

/**
 * Read aloud's host half (A11Y-06 / EDGE-11; NOT-06 with the media session): the device's
 * [TextToSpeech] behind the core's `SpeechHost` (`Platform.speech`, `src/core/platform.ts`;
 * `AndroidPlatform.speech` in `src/android/platform.ts`; section 3 of
 * `internal/parity-services/read-aloud-interface.md`). The model – the text, the sentence walker,
 * the playback state, the voice per language, the highlight the page paints – is the core's
 * (the services program's `ReadAloudService`); this class owns nothing but the engine and its
 * life. Zero spend: the engine and the voices are the device's own (Google's, Samsung's, any
 * installed engine), nothing is fetched from a service of ours.
 *
 * `speech.voices` answers the engine's voices as `ReadAloudVoice[]` ([ReadAloudLogic.voices]:
 * installed only, the default first, on-device before network, better before worse).
 * `speech.speak` speaks ONE utterance – the core's one sentence – with the voice (`voiceId` =
 * `Voice.getName()`, else the engine's voice for `lang`) and the rate asked for: `queue: flush`
 * replaces whatever speaks (`QUEUE_FLUSH`), `queue: add` is the core's `prepare`, the next
 * sentence queued behind the current one so it starts without a gap (`QUEUE_ADD`); when the core
 * then `speak`s that prepared sentence with a speed or voice other than the one it was queued
 * with (the chip tapped while the sentence before spoke), the just-begun utterance is flushed and
 * spoken again with the change, so it is heard from the next sentence, not the one after
 * ([ReadAloudLogic.speakPlan]). The engine's
 * [UtteranceProgressListener] comes back as `speech.event`s naming the utterance: `start`, `word`
 * from `onRangeStart` (API 26+, offsets within the utterance's text; an engine that reports no
 * ranges sends none and the core highlights sentences alone), `end` from `onDone`, `error` from
 * `onError` with the code's name. The engine has no pause: the core stops (`speech.stop`) and
 * speaks the sentence again from its start on resume, so `pause` / `resume` are absent here as
 * the interface allows. Every callback of the engine's arrives on a binder thread and is posted
 * to the main thread before it reaches the chrome (`evaluateJavascript` is main-thread only).
 *
 * The engine is bound on first use (`speech.voices` from the picker, or the first `speak`), not
 * at boot: binding a speech service costs a second or two and most sessions never read aloud.
 * Work asked for while it binds waits and runs on `onInit`; an engine that fails to bind answers
 * the voices with an empty list and every `speak` with an `error` event, and the next call binds
 * again. Whether the device has an engine at all ([available], the services answering
 * `TextToSpeech.Engine.INTENT_ACTION_TTS_SERVICE`, which the manifest's `<queries>` makes
 * visible on Android 11+) goes to the chrome at boot as the `readAloud` capability; without one
 * no Listen to this page shows.
 *
 * AUDIO FOCUS (media-session-source note 2.4, the host's half): pages hold focus through the
 * WebView engine (`AudioFocusDelegate`), a speech stream does not. [onSession] hears every
 * session [MediaSessions] shows: while it is a chrome player's and playing (the read-aloud
 * source registered with the core's `registerSource`, `playing: true`) this class holds
 * `AUDIOFOCUS_GAIN` for the speech stream's attributes, and abandons it when the session pauses
 * or goes. Taking focus is what pauses another app's music – and a page's own media in this app,
 * through the engine's listener – as any media player's playback would; losing it (another app
 * plays, a call, an assistant; a page of ours starts playing) sends `media.action { tabId,
 * action: "pause" }`, the same path as the notification's Pause, which the core routes to the
 * source (`onAction("pause")`); a request to duck pauses too (speech under ducking is not
 * usable), and a gain after a transient loss resumes nothing (Chrome's read aloud stays paused).
 * The stream is `USAGE_MEDIA` / `CONTENT_TYPE_SPEECH`, not `USAGE_ASSISTANCE_ACCESSIBILITY`: the
 * player is a media player – it sits in the media notification and on the lock screen, the
 * volume keys should move the media volume while it speaks, other players should pause for it
 * as they do for each other – where the accessibility usage is TalkBack's (its own volume slider
 * once a service is on, and a duck-not-pause policy toward music that is wrong for reading).
 *
 * Testing seam: the emulator's Google APIs image carries Google's engine with its offline
 * English voice, so the demo driver (`ReadAloudDemo` under androidTest) runs the real engine;
 * [availabilityOverride] lets a driver on an image without one prove the chrome's "no engine"
 * paths, and [focusForTest] lets it take the focus away as another app would.
 */
class ReadAloud(private val host: Host) {
    private val activity get() = host.activity
    private val context: Context = host.activity.applicationContext
    private val main = Handler(Looper.getMainLooper())
    private val audio: AudioManager? = context.getSystemService(AudioManager::class.java)

    private var tts: TextToSpeech? = null
    private var state = EngineState.NONE
    /** Counts the engines bound, so an `onInit` from one already shut down is ignored. */
    private var engineNumber = 0
    /** Work asked for while the engine binds; run on `onInit`, in order. */
    private val pending = ArrayList<(ready: Boolean) -> Unit>()
    /** The engine's voices by `Voice.getName()`, read on init and again when its data changes. */
    private var voicesByName: Map<String, Voice> = emptyMap()
    private var defaultVoiceName: String? = null
    /** The utterance the engine speaks or is about to (the last flushed in, or the queued one it moved on to). */
    private var current: String? = null
    /** The utterances queued behind [current] (`prepare`), in the engine's order, until it moves on to them. */
    private val queued = ArrayDeque<String>()
    /** What [current] and each of [queued] were handed to the engine with, for [ReadAloudLogic.speakPlan]'s restart rule. */
    private val enqueued = HashMap<String, ReadAloudLogic.Options>()
    /** Counts the `stop`s, so a `speak` that waited on the engine's binding across one is dropped. */
    private var stops = 0
    private var destroyed = false

    // --- audio focus ---
    private val attributes = AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_MEDIA)
        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
        .build()
    private var focusRequest: AudioFocusRequest? = null
    /** The chrome session the focus is held for (its tab gets the pause on a loss). */
    private var focusTab: String? = null

    private val focusListener = AudioManager.OnAudioFocusChangeListener { change ->
        val action = ReadAloudLogic.focusChangeAction(change)
        val tabId = focusTab
        Log.d(TAG, "audio focus change $change for tab $tabId: ${action ?: "nothing to do"}")
        if (action == null || tabId == null) return@OnAudioFocusChangeListener
        if (change == AudioManager.AUDIOFOCUS_LOSS) {
            // Gone for good: the request is over; the pause below has the session let go of it too.
            focusRequest = null
            focusTab = null
        }
        host.hostEvent("media.action", json("tabId" to tabId, "action" to action))
    }

    /** The engine's data changed (a language pack installed): the list is read again and the chrome told. */
    private val dataReceiver = object : BroadcastReceiver() {
        override fun onReceive(c: Context, intent: Intent) {
            if (state != EngineState.READY) return
            readVoices()
            host.hostEvent("speech.voicesChanged", null)
        }
    }

    init {
        ContextCompat.registerReceiver(
            context,
            dataReceiver,
            IntentFilter(TextToSpeech.Engine.ACTION_TTS_DATA_INSTALLED),
            ContextCompat.RECEIVER_EXPORTED
        )
    }

    /** The device has a speech engine `Listen to this page` can use (the `readAloud` capability). */
    val available: Boolean
        get() = availabilityOverride ?: runCatching {
            context.packageManager.queryIntentServices(Intent(TextToSpeech.Engine.INTENT_ACTION_TTS_SERVICE), 0).isNotEmpty()
        }.getOrDefault(false)

    /** The engine's package names, for the demo's findings (`TextToSpeech.getEngines` needs a bound instance; this does not). */
    fun engines(): List<String> = runCatching {
        context.packageManager.queryIntentServices(Intent(TextToSpeech.Engine.INTENT_ACTION_TTS_SERVICE), 0)
            .mapNotNull { it.serviceInfo?.packageName }
    }.getOrDefault(emptyList())

    // --- the core's SpeechHost ---------------------------------------------------------------------

    /** `speech.voices`: the engine's voices as `ReadAloudVoice[]`; an empty list without an engine or when it fails to bind. */
    fun voices(reply: (Any?) -> Unit) {
        if (!available) {
            reply(JSONArray())
            return
        }
        whenReady { ready -> reply(if (ready) voiceList() else JSONArray()) }
    }

    /**
     * `speech.speak { utteranceId, text, voiceId, lang, rate, queue }`: one utterance through the
     * engine. Without an engine the utterance fails at once (`error`, `no-engine`), so the core
     * shows its error state rather than waiting on a `start` that never comes.
     */
    fun speak(args: JSONObject) {
        val utteranceId = args.str("utteranceId")
        if (utteranceId.isEmpty()) return
        if (!available) {
            event(ReadAloudLogic.errorEvent(utteranceId, "no-engine"))
            return
        }
        val text = args.str("text")
        val voiceId = args.strOrNull("voiceId")
        val lang = args.str("lang")
        val rate = args.num("rate", 1.0)
        val queue = args.str("queue", ReadAloudLogic.QUEUE_FLUSH)
        val asked = stops
        whenReady { ready ->
            if (!ready) {
                event(ReadAloudLogic.errorEvent(utteranceId, "engine"))
                return@whenReady
            }
            // A stop while the engine bound (the player closed before it spoke): the utterance is dropped with the queue.
            if (asked != stops) return@whenReady
            speakNow(utteranceId, text, voiceId, lang, rate, queue)
        }
    }

    /** `speech.stop`: whatever speaks or waits is dropped; the engine says nothing more about it (`onStop`, not `onDone`, and that is not an event). */
    fun stop() {
        stops++
        current = null
        queued.clear()
        enqueued.clear()
        val engine = tts ?: return
        if (state == EngineState.READY) runCatching { engine.stop() }
    }

    /**
     * Every session the host shows on the OS controls ([MediaSessions.update] / its clear), for
     * the focus half: held while a chrome player's session plays, let go otherwise.
     */
    fun onSession(info: MediaSessionInfo?) {
        if (destroyed) return
        val wants = ReadAloudLogic.wantsFocus(info)
        if (wants) requestFocus(info!!.tabId) else abandonFocus()
    }

    fun destroy() {
        destroyed = true
        abandonFocus()
        runCatching { context.unregisterReceiver(dataReceiver) }
        shutdownEngine()
    }

    // --- the engine ----------------------------------------------------------------------------------

    private fun whenReady(work: (ready: Boolean) -> Unit) {
        when (state) {
            EngineState.READY -> work(true)
            EngineState.STARTING -> pending.add(work)
            EngineState.NONE, EngineState.FAILED -> {
                pending.add(work)
                bind()
            }
        }
    }

    /** Bind the device's default engine; [onInit] finishes it on the main thread. */
    private fun bind() {
        shutdownEngine()
        state = EngineState.STARTING
        val number = ++engineNumber
        val created = runCatching {
            TextToSpeech(context) { status -> main.post { onInit(number, status) } }
        }
        val engine = created.getOrElse { e ->
            Log.w(TAG, "no speech engine: ${e.message}")
            main.post { onInit(number, TextToSpeech.ERROR) }
            return
        }
        tts = engine
    }

    private fun onInit(number: Int, status: Int) {
        if (number != engineNumber || destroyed) return
        val engine = tts
        if (status != TextToSpeech.SUCCESS || engine == null) {
            Log.w(TAG, "the speech engine would not start: status $status")
            state = EngineState.FAILED
            shutdownEngine()
            drainPending(ready = false)
            return
        }
        engine.setOnUtteranceProgressListener(Progress(number))
        runCatching { engine.setAudioAttributes(attributes) }
        readVoices()
        state = EngineState.READY
        Log.d(TAG, "speech engine ready: ${runCatching { engine.defaultEngine }.getOrNull()}, ${voicesByName.size} voices, default ${defaultVoiceName ?: "none"}")
        drainPending(ready = true)
        // The list went from unknown to known: a picker open on the wait re-asks.
        host.hostEvent("speech.voicesChanged", null)
    }

    private fun drainPending(ready: Boolean) {
        val work = ArrayList(pending)
        pending.clear()
        for (w in work) w(ready)
    }

    private fun shutdownEngine() {
        val engine = tts ?: return
        tts = null
        voicesByName = emptyMap()
        defaultVoiceName = null
        current = null
        queued.clear()
        enqueued.clear()
        runCatching { engine.stop() }
        runCatching { engine.shutdown() }
        if (state == EngineState.READY) state = EngineState.NONE
    }

    /** The engine's voices and its default, as it has them now (some engines throw on `getVoices` before their data is ready: none, then). */
    private fun readVoices() {
        val engine = tts ?: return
        val voices = runCatching { engine.voices }.getOrNull() ?: emptySet()
        voicesByName = voices.filterNotNull().associateBy { it.name }
        defaultVoiceName = runCatching { engine.defaultVoice }.getOrNull()?.name
    }

    private fun voiceList(): JSONArray = ReadAloudLogic.voices(
        voicesByName.values.map { v ->
            ReadAloudLogic.EngineVoice(v.name, v.locale, v.quality, v.isNetworkConnectionRequired, v.features ?: emptySet())
        },
        defaultVoiceName
    )

    private fun speakNow(utteranceId: String, text: String, voiceId: String?, lang: String, rate: Double, queue: String) {
        val engine = tts ?: return
        val options = ReadAloudLogic.Options(voiceId?.takeIf { it in voicesByName }, lang, ReadAloudLogic.speechRate(rate))
        val had = enqueued[utteranceId]
        val plan = ReadAloudLogic.speakPlan(utteranceId, queue, current, queued, options, enqueued)
        if (plan == ReadAloudLogic.SpeakPlan.IGNORE) {
            Log.i(TAG, "speak $utteranceId: ${if (utteranceId == current) "the engine is on it" else "already queued"}; nothing to do")
            return
        }
        // The engine's log line the demo driver reads (`ReadAloudDemo`): which utterance, how it
        // was queued, at what rate; a restart of the current utterance names the change it heard.
        val why = if (utteranceId == current && had != null) " (${describe(had)} -> ${describe(options)}: the current utterance restarted with the change)" else ""
        Log.i(TAG, "speak $utteranceId: $plan at ${describe(options)}$why \"${text.take(40)}${if (text.length > 40) "…" else ""}\"")
        runCatching { engine.setSpeechRate(options.rate) }
        applyVoice(engine, voiceId, lang)
        val clipped = ReadAloudLogic.clip(text, runCatching { TextToSpeech.getMaxSpeechInputLength() }.getOrDefault(4000))
        val mode = if (plan == ReadAloudLogic.SpeakPlan.FLUSH) TextToSpeech.QUEUE_FLUSH else TextToSpeech.QUEUE_ADD
        val result = runCatching { engine.speak(clipped, mode, null, utteranceId) }.getOrDefault(TextToSpeech.ERROR)
        if (result != TextToSpeech.SUCCESS) {
            Log.w(TAG, "speak refused ($result) for $utteranceId")
            event(ReadAloudLogic.errorEvent(utteranceId, ReadAloudLogic.errorName(result)))
            return
        }
        if (plan == ReadAloudLogic.SpeakPlan.FLUSH) {
            current = utteranceId
            queued.clear()
            enqueued.clear()
        } else if (current == null) {
            current = utteranceId
        } else {
            queued.addLast(utteranceId)
        }
        enqueued[utteranceId] = options
    }

    private fun describe(options: ReadAloudLogic.Options): String =
        "${options.rate}x, ${options.voiceId?.let { "voice $it" } ?: "the ${options.lang.ifEmpty { "default" }} voice"}"

    /**
     * The voice the core chose (`voiceId`, a `Voice.getName()` from the list), else the engine's
     * own voice for the text's language: `setLanguage` picks the engine's default for the locale
     * and reports missing data or an unsupported language, which is left to the engine to fall
     * back from (it speaks with its default; a failure comes back as the utterance's `error`).
     */
    private fun applyVoice(engine: TextToSpeech, voiceId: String?, lang: String) {
        val voice = voiceId?.let { voicesByName[it] }
        if (voice != null) {
            val set = runCatching { engine.setVoice(voice) }.getOrDefault(TextToSpeech.ERROR)
            if (set == TextToSpeech.SUCCESS) return
            Log.w(TAG, "voice $voiceId refused ($set); the language's default instead")
        }
        if (lang.isEmpty()) return
        val locale = runCatching { Locale.forLanguageTag(lang) }.getOrNull() ?: return
        val result = runCatching { engine.setLanguage(locale) }.getOrDefault(TextToSpeech.LANG_NOT_SUPPORTED)
        if (result == TextToSpeech.LANG_MISSING_DATA || result == TextToSpeech.LANG_NOT_SUPPORTED) {
            Log.w(TAG, "no voice for $lang ($result); the engine's default speaks")
        }
    }

    private fun event(payload: JSONObject) = host.hostEvent("speech.event", payload)

    /**
     * The engine's progress for the engine numbered [number], each callback moved to the main
     * thread and checked against the live engine and the live utterance: the engine keeps
     * reporting for a moment after `stop`, and a flushed utterance's `onStop` is no `end`.
     */
    private inner class Progress(private val number: Int) : UtteranceProgressListener() {
        private fun live(utteranceId: String?, work: (String) -> Unit) {
            if (utteranceId == null) return
            main.post {
                if (number != engineNumber || destroyed) return@post
                if (utteranceId != current && utteranceId !in queued) return@post
                work(utteranceId)
            }
        }

        override fun onStart(utteranceId: String?) = live(utteranceId) { id ->
            if (id != current) {
                // The engine moved on to a prepared sentence by itself (anything queued before it is gone with it).
                current?.let(enqueued::remove)
                while (queued.isNotEmpty() && queued.first() != id) enqueued.remove(queued.removeFirst())
                if (queued.isNotEmpty()) queued.removeFirst()
                current = id
            }
            event(ReadAloudLogic.startEvent(id))
        }

        override fun onRangeStart(utteranceId: String?, start: Int, end: Int, frame: Int) = live(utteranceId) { id ->
            ReadAloudLogic.wordEvent(id, start, end)?.let(::event)
        }

        override fun onDone(utteranceId: String?) = live(utteranceId) { id ->
            advance(id)
            event(ReadAloudLogic.endEvent(id))
        }

        @Deprecated("Deprecated in Java")
        override fun onError(utteranceId: String?) = onError(utteranceId, TextToSpeech.ERROR)

        override fun onError(utteranceId: String?, errorCode: Int) = live(utteranceId) { id ->
            advance(id)
            event(ReadAloudLogic.errorEvent(id, ReadAloudLogic.errorName(errorCode)))
        }

        override fun onStop(utteranceId: String?, interrupted: Boolean) {
            // A `stop` or a flush: the core asked for it and knows; nothing to report.
        }

        /** The utterance is over: the first queued one (if any) is what the engine speaks next. */
        private fun advance(id: String) {
            if (id == current) {
                current = queued.removeFirstOrNull()
            } else {
                queued.remove(id)
            }
            enqueued.remove(id)
        }
    }

    // --- audio focus ---------------------------------------------------------------------------------

    private fun requestFocus(tabId: String) {
        val manager = audio ?: return
        if (focusRequest != null) {
            focusTab = tabId
            return
        }
        val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
            .setAudioAttributes(attributes)
            // The system would duck the stream for us; speech ducked is speech unheard, so the loss reaches the listener and pauses instead.
            .setWillPauseWhenDucked(true)
            .setOnAudioFocusChangeListener(focusListener, main)
            .build()
        val result = runCatching { manager.requestAudioFocus(request) }.getOrDefault(AudioManager.AUDIOFOCUS_REQUEST_FAILED)
        Log.d(TAG, "audio focus requested for tab $tabId: ${if (result == AudioManager.AUDIOFOCUS_REQUEST_GRANTED) "granted" else "refused ($result)"}")
        if (result != AudioManager.AUDIOFOCUS_REQUEST_GRANTED) {
            // Something holds the audio for itself (a call): the player pauses, and Play asks again.
            host.hostEvent("media.action", json("tabId" to tabId, "action" to "pause"))
            return
        }
        focusRequest = request
        focusTab = tabId
    }

    private fun abandonFocus() {
        val request = focusRequest ?: return
        focusRequest = null
        focusTab = null
        audio?.let { runCatching { it.abandonAudioFocusRequest(request) } }
        Log.d(TAG, "audio focus abandoned")
    }

    /** Whether the host holds focus for the speech stream right now (the demo's check). */
    val holdsFocus: Boolean get() = focusRequest != null

    private enum class EngineState { NONE, STARTING, READY, FAILED }

    companion object {
        private const val TAG = "ZenReadAloud"

        /** Test seam: what [available] answers, in place of the package manager's word. */
        @Volatile
        var availabilityOverride: Boolean? = null

        /**
         * Test seam: another app taking the audio. A driver requests focus with its own listener
         * through the system's [AudioManager] (two requests from one process contend like two
         * apps'), so the host's listener hears the loss the way it would from music starting.
         */
        fun focusForTest(context: Context, listener: AudioManager.OnAudioFocusChangeListener): AudioFocusRequest? {
            val manager = context.getSystemService(AudioManager::class.java) ?: return null
            val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                .setAudioAttributes(
                    AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_MUSIC).build()
                )
                .setOnAudioFocusChangeListener(listener, Handler(Looper.getMainLooper()))
                .build()
            return if (manager.requestAudioFocus(request) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED) request else null
        }
    }
}
