package app.zen.chromium

import android.media.AudioManager
import android.speech.tts.TextToSpeech
import org.json.JSONArray
import org.json.JSONObject
import java.util.Locale

/**
 * What is pure about read aloud's host half (A11Y-06 / EDGE-11; the core's `SpeechHost`,
 * `src/core/platform.ts`, section 3 of `internal/parity-services/read-aloud-interface.md`), kept
 * apart from [ReadAloud] so it runs on the JVM: how the engine's voices become the list the
 * pickers show (`ReadAloudVoice[]`, `src/shared/readAloud.ts`), the rate the engine is set to,
 * which `speak` calls the engine must hear and which it must not (the one-utterance queue), the
 * progress listener's callbacks as `speech.event`s, and the audio-focus decisions the
 * media-session source note leaves to the host (its 2.4).
 */
object ReadAloudLogic {
    /**
     * One of the engine's voices as [ReadAloud] reads it off `TextToSpeech.getVoices()`: plain
     * data, so the ranking runs on the JVM. [quality] is `Voice.getQuality()` (100 very low … 300
     * normal … 500 very high); [features] is `Voice.getFeatures()`, where `notInstalled`
     * ([FEATURE_NOT_INSTALLED]) marks a voice whose data is not on the device.
     */
    data class EngineVoice(
        val name: String,
        val locale: Locale,
        val quality: Int,
        val networkRequired: Boolean,
        val features: Set<String> = emptySet()
    )

    /** `TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED`: the voice's data would have to be downloaded first. */
    const val FEATURE_NOT_INSTALLED = "notInstalled"

    /**
     * How often, and how many times, [ReadAloud] reads the engine's list again after a bind that
     * found no installed voice: the engine may be downloading its data (Google's fetches the device
     * locale's voice pack on its first bind, a few seconds on the emulator, longer on a slow
     * network) and does not say when it lands. Thirty seconds of once a second, then the next
     * `speech.voices` ask re-reads on its own.
     */
    const val VOICE_DATA_RECHECK_MS = 1_000L
    const val VOICE_DATA_RECHECKS = 30

    /** The model's ladder runs 0.5 to 4 (Chrome's); the chip's 0.5 to 2 is inside it. */
    const val MIN_RATE = 0.5
    const val MAX_RATE = 4.0

    /**
     * The list `speech.voices` answers with: every installed voice (one whose data is not on
     * the device is left out: it would fail or start a download), ranked the way a picker wants
     * them – the engine's default voice first, then the ones synthesised on the device before
     * the ones needing a network, better quality before worse, then by language and name so the
     * order is stable across calls. `id` is `Voice.getName()` (stable across sessions, the
     * model's per-language memory keys on it), `lang` the locale's BCP-47 tag, `local` the
     * inverse of the network requirement, `quality` the engine's five grades folded to the
     * interface's three, and `default` set on the engine's own default voice alone.
     *
     * The engines name their voices for machines (`en-gb-x-gbb-local`), so the row's name is the
     * locale as [display] spells it ("English (United Kingdom)"), numbered in rank order where the
     * locale has more than one voice; the row's description (where it runs, its quality) is the
     * picker's, from `local` and `quality`.
     */
    fun voices(engine: Collection<EngineVoice>, defaultName: String?, display: Locale = Locale.getDefault()): JSONArray {
        val ranked = engine
            .filter { it.name.isNotEmpty() && FEATURE_NOT_INSTALLED !in it.features }
            .sortedWith(
                compareBy<EngineVoice> { if (it.name == defaultName) 0 else 1 }
                    .thenBy { if (it.networkRequired) 1 else 0 }
                    .thenByDescending { it.quality }
                    .thenBy { it.locale.toLanguageTag() }
                    .thenBy { it.name }
            )
        val perLocale = ranked.groupingBy { it.locale.toLanguageTag() }.eachCount()
        val seen = HashMap<String, Int>()
        val out = JSONArray()
        for (voice in ranked) {
            val tag = voice.locale.toLanguageTag()
            val n = (seen[tag] ?: 0) + 1
            seen[tag] = n
            val localeName = voice.locale.getDisplayName(display).takeIf { it.isNotEmpty() } ?: tag
            val name = if ((perLocale[tag] ?: 1) > 1) "$localeName $n" else localeName
            val row = json(
                "id" to voice.name,
                "name" to name,
                "lang" to tag,
                "local" to !voice.networkRequired,
                "quality" to qualityName(voice.quality)
            )
            if (voice.name == defaultName) row.put("default", true)
            out.put(row)
        }
        return out
    }

    /** The engine's five grades as the interface's three: 400 and up high, 200 and under low. */
    fun qualityName(quality: Int): String = when {
        quality >= 400 -> "high"
        quality <= 200 -> "low"
        else -> "normal"
    }

    /** The rate the engine is set to for the model's: clamped to the ladder, 1 for anything that is not a number. */
    fun speechRate(rate: Double): Float =
        if (rate.isNaN() || rate.isInfinite()) 1f else rate.coerceIn(MIN_RATE, MAX_RATE).toFloat()

    /**
     * The pitch the engine is set to for `chrome.tts`'s (0–2, 1 the voice's own; read aloud
     * sends none): `setPitch` refuses anything at or under 0, so the floor is just above it; 1
     * for anything that is not a number.
     */
    fun speechPitch(pitch: Double): Float =
        if (pitch.isNaN() || pitch.isInfinite()) 1f else pitch.coerceIn(MIN_PITCH, MAX_PITCH).toFloat()

    /** The utterance's volume for `KEY_PARAM_VOLUME` (0–1, 1 full; read aloud sends none): 1 for anything that is not a number. */
    fun speechVolume(volume: Double): Float =
        if (volume.isNaN() || volume.isInfinite()) 1f else volume.coerceIn(0.0, 1.0).toFloat()

    const val MIN_PITCH = 0.1
    const val MAX_PITCH = 2.0

    /** An utterance longer than the engine takes (`getMaxSpeechInputLength`) is cut there rather than refused. */
    fun clip(text: String, max: Int): String = if (max > 0 && text.length > max) text.substring(0, max) else text

    /** What a `speech.speak` does to the engine's queue. */
    enum class SpeakPlan {
        /** The utterance is the one speaking or the one queued behind it: nothing to do. */
        IGNORE,
        /** Replace whatever speaks: `QUEUE_FLUSH`. */
        FLUSH,
        /** Queue behind the current one: `QUEUE_ADD` (the core's `prepare`). */
        ADD
    }

    /**
     * What an utterance is handed to the engine with – the voice (`voiceId`, else the language's
     * default), the language, the engine's rate ([speechRate]) and, for `chrome.tts`, its pitch
     * ([speechPitch]) and volume ([speechVolume]) – remembered per utterance, so a `speak` for
     * one the engine already has can tell whether the core changed its mind.
     */
    data class Options(val voiceId: String?, val lang: String, val rate: Float, val pitch: Float = 1f, val volume: Float = 1f)

    /**
     * The one-utterance queue's rule. The core speaks one sentence per utterance: `speak`
     * replaces whatever is speaking, `prepare` queues the next sentence behind it so it starts
     * without a gap. An utterance the engine already has – the one speaking ([current]) or one
     * waiting behind it ([queued]) – is not spoken again: a `speak` for the current one would
     * restart the sentence (a prepared sentence the engine has just moved on to is the current
     * one by then, and the core, hearing `end` then `start`, asks for it with `speak`), and a
     * `prepare` for a sentence already waiting would queue it twice.
     *
     * The one exception is a `speak` for the current utterance with OPTIONS the engine does not
     * have for it ([enqueued] holds what each was handed over with): a speed or a voice changed
     * while the sentence before spoke. The prepared sentence was queued with the old ones, so
     * leaving it be would speak the whole next sentence at the old speed and the change would
     * only be heard from the one after (N+2); the core promises the next sentence (N+1), Chrome
     * applies a new speed at once. So the utterance is FLUSHed: restarted from its start – it has
     * just begun – at the new speed, with the new voice.
     */
    fun speakPlan(
        utteranceId: String,
        queue: String,
        current: String?,
        queued: Collection<String>,
        options: Options? = null,
        enqueued: Map<String, Options> = emptyMap()
    ): SpeakPlan = when {
        utteranceId == current -> {
            val had = enqueued[utteranceId]
            if (queue == QUEUE_FLUSH && options != null && had != null && had != options) SpeakPlan.FLUSH else SpeakPlan.IGNORE
        }
        queue == QUEUE_ADD -> if (utteranceId in queued) SpeakPlan.IGNORE else SpeakPlan.ADD
        else -> SpeakPlan.FLUSH
    }

    /** `speech.speak`'s `queue` values (`src/android/platform.ts`). */
    const val QUEUE_FLUSH = "flush"
    const val QUEUE_ADD = "add"

    // --- the events (`speech.event`, `SpeechHost.onEvent`) -------------------------------------

    fun startEvent(utteranceId: String): JSONObject = json("utteranceId" to utteranceId, "type" to "start")

    /**
     * `onRangeStart(utteranceId, start, end, frame)` as the `word` event: offsets within the
     * utterance's text, `charIndex` and `length`. An empty range (some engines mark a pause
     * that way) is nothing to highlight: null, and no event goes.
     */
    fun wordEvent(utteranceId: String, start: Int, end: Int): JSONObject? {
        if (start < 0 || end <= start) return null
        return json("utteranceId" to utteranceId, "type" to "word", "charIndex" to start, "length" to end - start)
    }

    fun endEvent(utteranceId: String): JSONObject = json("utteranceId" to utteranceId, "type" to "end")

    fun errorEvent(utteranceId: String, message: String): JSONObject =
        json("utteranceId" to utteranceId, "type" to "error", "message" to message)

    /**
     * An utterance the engine dropped before its end – replaced by another speaker's `speak`
     * (`QUEUE_FLUSH`), or cut by a `stop` – as `SpeechHostEvent` spells it: an `error` whose
     * message is `interrupted` (`SPEECH_INTERRUPTED`, `src/core/platform.ts`; the desktop's
     * speech host reports the same). Read aloud and `chrome.tts` share the engine, so each
     * hears of what the other took from it; the one who asked for the stop or the flush knows
     * and drops the report about its own utterance.
     */
    fun interruptedEvent(utteranceId: String): JSONObject = errorEvent(utteranceId, INTERRUPTED)

    const val INTERRUPTED = "interrupted"

    /**
     * Which utterances a `speak` with [plan] takes from the engine: on a FLUSH, the current one
     * and everything queued behind it, except the utterance being (re)spoken itself (a restart
     * with new options is not an interruption); nothing on an ADD or an IGNORE.
     */
    fun dropped(plan: SpeakPlan, utteranceId: String, current: String?, queued: Collection<String>): List<String> =
        if (plan != SpeakPlan.FLUSH) emptyList()
        else (listOfNotNull(current) + queued).filter { it != utteranceId }

    /** `TextToSpeech.ERROR_*` by the name `speech.event` carries; codes newer than this list read as `unknown`. */
    fun errorName(code: Int): String = when (code) {
        TextToSpeech.ERROR_SYNTHESIS -> "synthesis"
        TextToSpeech.ERROR_SERVICE -> "service"
        TextToSpeech.ERROR_OUTPUT -> "output"
        TextToSpeech.ERROR_NETWORK -> "network"
        TextToSpeech.ERROR_NETWORK_TIMEOUT -> "network-timeout"
        TextToSpeech.ERROR_INVALID_REQUEST -> "invalid-request"
        TextToSpeech.ERROR_NOT_INSTALLED_YET -> "not-installed"
        TextToSpeech.ERROR -> "error"
        else -> "unknown"
    }

    // --- audio focus (media-session-source note 2.4) ---------------------------------------------

    /**
     * Whether the host holds audio focus for the speech stream: while the session the core shows
     * on the OS controls is a chrome player's (`source: "chrome"`: the read-aloud player) and
     * playing. A page's session never asks for focus from here (the WebView engine holds the
     * pages' own), and a paused or absent one lets it go.
     */
    fun wantsFocus(info: MediaSessionInfo?): Boolean = info != null && info.chrome && info.playing

    /**
     * What a focus change means for the player: every loss – for good, for the moment, or a
     * request to duck (speech under ducking is not usable; Chrome's read aloud pauses) – pauses
     * it, through the same `media.action` the notification's Pause takes. A gain (the transient
     * loss over) does nothing: no auto-resume, the user presses Play (Chrome's behaviour).
     */
    fun focusChangeAction(change: Int): String? = when (change) {
        AudioManager.AUDIOFOCUS_LOSS,
        AudioManager.AUDIOFOCUS_LOSS_TRANSIENT,
        AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK -> "pause"
        else -> null
    }
}
