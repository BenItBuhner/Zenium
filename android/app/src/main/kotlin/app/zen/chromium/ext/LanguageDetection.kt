package app.zen.chromium.ext

import android.content.Context
import android.os.Build
import android.view.textclassifier.TextClassificationManager
import android.view.textclassifier.TextLanguage
import org.json.JSONArray
import org.json.JSONObject
import kotlin.math.roundToInt

/**
 * `chrome.i18n.detectLanguage` on the phone (`ext.i18n.detectLanguage { text }`): the platform's
 * TextClassifier guesses the text's language, answered in Chrome's shape –
 * `{ isReliable, languages: [{ language, percentage }] }`. Chrome's detector reports each language's
 * share of the text and calls its guess reliable past a probability threshold; the classifier's
 * confidences (a distribution over its hypotheses) stand in for the shares, and the leading one
 * has to reach the same threshold. Text the classifier cannot place answers Chrome's empty
 * `languages` with `isReliable: false`, which is what callers already handle for a short or
 * mixed selection (Google Translate's bubble walks up to the parent node and tries again).
 */
object LanguageDetection {
    /** A language the classifier proposes, with its confidence (0..1). */
    class Hypothesis(val languageTag: String, val confidence: Float)

    /** Chrome's `isReliable` needs the leading guess at 0.7 (its detector's reliability threshold). */
    const val RELIABLE = 0.7f

    /** Chrome's `detectLanguage` names at most three languages. */
    const val MAX_LANGUAGES = 3

    /** Detection reads the leading part of a long text; the rest would travel for nothing. */
    const val SAMPLE_CHARS = 4096

    /** Nothing detected: Chrome's answer for an empty or unplaceable text. */
    val NONE: JSONObject get() = toChrome(emptyList())

    /**
     * Chrome's shape from the classifier's hypotheses: the placed languages by falling confidence
     * (`und` and zero-confidence ones dropped), each as its bare language subtag (`en` for
     * `en-US`) with the confidence as a percentage.
     */
    fun toChrome(hypotheses: List<Hypothesis>): JSONObject {
        val ranked = hypotheses
            .map { Hypothesis(languageOf(it.languageTag), it.confidence) }
            .filter { it.languageTag != "und" && it.confidence > 0f }
            .sortedByDescending { it.confidence }
            .take(MAX_LANGUAGES)
        val languages = JSONArray()
        for (h in ranked) {
            languages.put(
                JSONObject()
                    .put("language", h.languageTag)
                    .put("percentage", (h.confidence * 100f).roundToInt().coerceIn(0, 100))
            )
        }
        val leading = ranked.firstOrNull()?.confidence ?: 0f
        return JSONObject().put("isReliable", leading >= RELIABLE).put("languages", languages)
    }

    /** The bare lower-case language subtag of a BCP 47 tag (`en-US`, `zh_Hant`); `und` for none. */
    fun languageOf(tag: String): String {
        val primary = tag.trim().split('-', '_').firstOrNull() ?: ""
        return if (primary.length in 2..3 && primary.all { it.isLetter() }) primary.lowercase() else "und"
    }

    /**
     * The leading [SAMPLE_CHARS] of the text, trimmed: the sample the classifier reads. Empty for a
     * blank text.
     */
    fun sampleOf(text: String): String {
        val trimmed = text.trim()
        return if (trimmed.length > SAMPLE_CHARS) trimmed.substring(0, SAMPLE_CHARS) else trimmed
    }

    /**
     * The platform's guess for the text, in Chrome's shape. Blocks on the system's
     * text-classification service: not for the main thread. Before Android 10 (no
     * `TextClassifier.detectLanguage`), or without a classifier, nothing is detected.
     */
    fun detect(context: Context, text: String): JSONObject {
        val sample = sampleOf(text)
        if (sample.isEmpty() || Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return NONE
        val manager = context.getSystemService(TextClassificationManager::class.java) ?: return NONE
        val language = manager.textClassifier.detectLanguage(TextLanguage.Request.Builder(sample).build())
        val hypotheses = ArrayList<Hypothesis>(language.localeHypothesisCount)
        for (i in 0 until language.localeHypothesisCount) {
            val locale = language.getLocale(i)
            hypotheses.add(Hypothesis(locale.toLanguageTag(), language.getConfidenceScore(locale)))
        }
        return toChrome(hypotheses)
    }
}
