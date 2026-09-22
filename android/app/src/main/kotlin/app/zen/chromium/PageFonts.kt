package app.zen.chromium

import android.webkit.WebSettings
import org.json.JSONObject
import kotlin.math.roundToInt

/**
 * Page fonts (Settings › Appearance › Customize fonts, CT-25) as every page WebView takes them:
 * the core's `Settings.fonts` document (`shared/fonts.ts`), pushed as `fonts.apply`, mapped onto
 * `WebSettings` – the families text a page leaves to the engine gets and the generic families
 * it names, Chrome's size, the floor no text goes under. Plain data and pure decisions, so the
 * mapping runs under JUnit (`PageFontsTest`); [applyTo] is the one line per field that touches
 * the engine, and WebView restyles the open document as its settings change (no reload).
 *
 * A `null` family is the engine's own: WebView resolves `serif` / `sans-serif` / `monospace`
 * through the system's `fonts.xml` aliases. Zenium's standard family is `serif`, Chrome's
 * typographic default (Android maps Chrome's "Times New Roman" to it), not WebView's `sans-serif`.
 *
 * What takes effect on this engine (the recorded CT-25 limit, `capabilities.genericFontFamilies`
 * off): the standard family – Blink's initial `font-family` is the settings' standard family
 * (`FontBuilder::StandardFontFamily`), so text a page leaves unstyled follows it – and the
 * three sizes, which Blink reads from its `Settings` directly. The `serif` / `sansSerif` /
 * `fixed` slots are set too but change nothing: Blink's Android font selection
 * (`FontSelector::FamilyNameFromSettings`, its `IS_ANDROID` branch) resolves a page's generic
 * keywords through Skia's `fonts.xml` aliases without consulting the generic-family settings,
 * so `WebSettings.serifFontFamily` and its siblings are inert on every Android WebView. The
 * phone's Settings rows are therefore the standard family and the two sizes.
 *
 * The last document applied is kept in `files/zen/pages/fonts.json` for a process that starts
 * without the core (a custom tab, [CustomTabHost]), so a page there reads like the browser's,
 * the way Chrome's Custom Tabs share Chrome's fonts.
 */
data class PageFonts(
    val standard: String?,
    val serif: String?,
    val sansSerif: String?,
    val fixed: String?,
    /** Chrome's "Font size", CSS px (9–72; 16 is medium). */
    val size: Int,
    /** Chrome's "Minimum font size", CSS px (0 is no floor; 6–24). */
    val minimumSize: Int
) {
    /** `WebSettings.defaultFixedFontSize`: Chrome's 13 for 16, the ratio kept as the size moves. */
    val fixedSize: Int get() = fixedSizeFor(size)

    /**
     * `WebSettings.minimumFontSize`, the hard floor Blink applies to every size after zoom: the
     * user's, or 1 – WebView pins the value to 1..72, and 1 px is no floor a page can feel
     * (Chrome's is 0). The logical floor for relative sizes stays [MINIMUM_LOGICAL_SIZE] as in
     * Chrome, whose settings never move it: the hard floor covers whatever the user asked.
     */
    val minimumFontSize: Int get() = if (minimumSize > 0) minimumSize else NO_FLOOR

    /** The WebView's family for each slot: the user's, else the engine's own. */
    val standardFamily: String get() = standard ?: DEFAULT_STANDARD
    val serifFamily: String get() = serif ?: DEFAULT_SERIF
    val sansSerifFamily: String get() = sansSerif ?: DEFAULT_SANS_SERIF
    val fixedFamily: String get() = fixed ?: DEFAULT_FIXED

    fun applyTo(settings: WebSettings) {
        settings.standardFontFamily = standardFamily
        settings.serifFontFamily = serifFamily
        settings.sansSerifFontFamily = sansSerifFamily
        settings.fixedFontFamily = fixedFamily
        settings.defaultFontSize = size
        settings.defaultFixedFontSize = fixedSize
        settings.minimumFontSize = minimumFontSize
        settings.minimumLogicalFontSize = MINIMUM_LOGICAL_SIZE
    }

    fun toJson(): JSONObject = json(
        "standard" to standard,
        "serif" to serif,
        "sansSerif" to sansSerif,
        "fixed" to fixed,
        "size" to size,
        "minimumSize" to minimumSize
    )

    companion object {
        /** The last document applied, for a process that starts without the core (a custom tab). */
        const val FILE = "pages/fonts.json"

        const val DEFAULT_STANDARD = "serif"
        const val DEFAULT_SERIF = "serif"
        const val DEFAULT_SANS_SERIF = "sans-serif"
        const val DEFAULT_FIXED = "monospace"

        /** Chrome's slider range for "Font size" and its medium. */
        const val SIZE_MIN = 9
        const val SIZE_MAX = 72
        const val SIZE_DEFAULT = 16
        /** Chrome's slider range for "Minimum font size" (0 is off; the first stop above is 6). */
        const val MINIMUM_SIZE_MAX = 24
        const val MINIMUM_SIZE_FIRST_STOP = 6
        /** WebView's smallest `minimumFontSize`, which no page's text can feel. */
        const val NO_FLOOR = 1
        /** Chrome's floor for sizes given relative to the default (`smaller`, `0.4em`). */
        const val MINIMUM_LOGICAL_SIZE = 6

        val DEFAULT = PageFonts(null, null, null, null, SIZE_DEFAULT, 0)

        /** The fixed-width size for a standard size: 13 at 16, 20 at 24, 7 at 9 (Chrome's ratio). */
        fun fixedSizeFor(size: Int): Int = maxOf(1, (size * 13f / 16f).roundToInt())

        /**
         * The core's document (`sanitizeFontSettings` already brought it into shape; the ranges are
         * held again here for a document read back from disk). A family is a printable name or
         * null; a floor between 1 and 5 px, which Chrome's slider never offers, rounds up to its
         * first stop as the core's sanitizer does.
         */
        fun fromJson(json: JSONObject): PageFonts {
            val minimum = json.num("minimumSize").roundToInt().coerceIn(0, MINIMUM_SIZE_MAX)
            return PageFonts(
                standard = family(json, "standard"),
                serif = family(json, "serif"),
                sansSerif = family(json, "sansSerif"),
                fixed = family(json, "fixed"),
                size = json.num("size", SIZE_DEFAULT.toDouble()).roundToInt().coerceIn(SIZE_MIN, SIZE_MAX),
                minimumSize = if (minimum in 1 until MINIMUM_SIZE_FIRST_STOP) MINIMUM_SIZE_FIRST_STOP else minimum
            )
        }

        /** The document kept on disk, or the defaults for a profile that never touched the rows. */
        fun load(storage: Storage): PageFonts =
            storage.read(FILE)?.let { text -> runCatching { fromJson(JSONObject(text)) }.getOrNull() } ?: DEFAULT

        private fun family(json: JSONObject, key: String): String? =
            json.strOrNull(key)?.replace(Regex("[\"'<>;{}]"), "")?.replace(Regex("\\s+"), " ")?.trim()?.ifEmpty { null }
    }
}
