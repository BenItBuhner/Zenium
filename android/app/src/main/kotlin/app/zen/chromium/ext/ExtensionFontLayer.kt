package app.zen.chromium.ext

import app.zen.chromium.PageFonts
import org.json.JSONObject

/**
 * `chrome.fontSettings`' layer over the user's page fonts, as the core's `ext.fonts.apply` carries
 * it (`extensionFontSettings.ts`, `WebViewFontLayer`): one value per `WebSettings` field the
 * extensions hold – null where the user's setting (or the engine's own) stands – and, for what
 * `WebSettings` has no setter for (a family for one script, the `math` family), the `:lang()`
 * stylesheet with the script that puts it into a document (`extensionFontStylesheet.ts`). [over]
 * lays the values on the user's [PageFonts] document: `TabWebView.applyFonts` applies the result to
 * every tab, live and at creation, so the user's document is never written and a layer that goes
 * (a clear, a disable, an uninstall) leaves the user's value in place. The stylesheet is
 * [Extensions]' own: registered at document start on every tab view and replaced in the open
 * documents on every change ([Extensions.setFontLayer]).
 *
 * The families are names the engine can resolve as a page names them: Blink on Android asks Skia's
 * `SkFontMgr_Android`, whose name map is `fonts.xml`'s family and alias names ([FontFiles]).
 */
data class ExtensionFontLayer(
    val standard: String?,
    val serif: String?,
    val sansSerif: String?,
    val fixed: String?,
    val cursive: String?,
    val fantasy: String?,
    /** Chrome's default font size, CSS px; null while no extension holds it. */
    val size: Int?,
    /** Chrome's `default_fixed_font_size`, its own preference (the setting derives it from the size). */
    val fixedSize: Int?,
    val minimumSize: Int?,
    /** The stylesheet text (empty: none) and the script that puts it into a document (or takes it out). */
    val css: String,
    val script: String
) {
    /** Whether the extensions hold nothing: the user's document alone applies. */
    val isEmpty: Boolean
        get() = standard == null && serif == null && sansSerif == null && fixed == null && cursive == null && fantasy == null &&
            size == null && fixedSize == null && minimumSize == null && css.isEmpty()

    /** The user's document with this layer over it: an extension's value where one is held, the user's else. */
    fun over(base: PageFonts): PageFonts =
        if (isEmpty) base
        else PageFonts(
            standard = standard ?: base.standard,
            serif = serif ?: base.serif,
            sansSerif = sansSerif ?: base.sansSerif,
            fixed = fixed ?: base.fixed,
            size = size ?: base.size,
            minimumSize = minimumSize ?: base.minimumSize,
            cursive = cursive,
            fantasy = fantasy,
            fixedSizeOverride = fixedSize
        )

    /** One line for the log. */
    fun summary(): String = if (isEmpty) "none" else buildString {
        listOf("standard" to standard, "serif" to serif, "sansSerif" to sansSerif, "fixed" to fixed, "cursive" to cursive, "fantasy" to fantasy)
            .filter { it.second != null }.forEach { append(it.first).append('=').append(it.second).append(' ') }
        listOf("size" to size, "fixedSize" to fixedSize, "minimumSize" to minimumSize)
            .filter { it.second != null }.forEach { append(it.first).append('=').append(it.second).append("px ") }
        if (css.isNotEmpty()) append("stylesheet ").append(css.length).append(" chars")
    }.trim()

    companion object {
        val EMPTY = ExtensionFontLayer(null, null, null, null, null, null, null, null, null, "", "")

        /** The core's payload; the families cleaned as [PageFonts] cleans the user's, the sizes held to what WebView takes (1–72). */
        fun fromJson(json: JSONObject): ExtensionFontLayer = ExtensionFontLayer(
            standard = family(json, "standard"),
            serif = family(json, "serif"),
            sansSerif = family(json, "sansSerif"),
            fixed = family(json, "fixed"),
            cursive = family(json, "cursive"),
            fantasy = family(json, "fantasy"),
            size = size(json, "size", 1),
            fixedSize = size(json, "fixedSize", 1),
            minimumSize = size(json, "minimumSize", 0),
            css = json.optString("css", ""),
            script = json.optString("script", "")
        )

        private fun family(json: JSONObject, key: String): String? =
            json.optString(key, "").takeIf { !json.isNull(key) }
                ?.replace(Regex("[\"'<>;{}]"), "")?.replace(Regex("\\s+"), " ")?.trim()?.ifEmpty { null }

        private fun size(json: JSONObject, key: String, floor: Int): Int? =
            if (json.isNull(key) || !json.has(key)) null
            else json.optDouble(key).takeIf { it.isFinite() }?.let { Math.round(it).toInt().coerceIn(floor, PageFonts.SIZE_MAX) }
    }
}
