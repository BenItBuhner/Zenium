package app.zen.chromium

import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import org.json.JSONObject
import java.io.File

/**
 * What the install kept of an app's manifest for its window (PWA-07): the fields the core's
 * `shortcut.pin` request carries from `tab.webApp` (`ShortcutRequest.display / scope /
 * themeColor / backgroundColor`, `src/core/webapp.ts`). Carried in the shortcut's intent, as
 * Chrome's `WebappConstants.EXTRA_*` are, and kept under `files/zen/webapps/<shortcutId>.json`
 * beside the tile the launcher shows (`<shortcutId>.png`, the Recents icon and the splash's), so a
 * later row (PWA-06, PWA-09) can read an app without its page.
 *
 * A record needs a scope and an own-window display mode to be one; a plain page shortcut (no
 * manifest) or a `browser` app has none and opens as a tab, as it did before this record existed.
 */
class WebAppRecord(
    /** The app's id (manifest `id` resolved, else its start URL) – the core's key. */
    val id: String,
    val name: String,
    val startUrl: String,
    val scope: String,
    val display: WebAppRules.Display,
    /** ARGB, opaque; null when the manifest names no `theme_color`. */
    val themeColor: Int?,
    /** ARGB, opaque; null when the manifest names no `background_color`. */
    val backgroundColor: Int?
) {
    /** The launcher's id for the app's shortcut and the name of its files here. */
    val shortcutId: String get() = Shortcuts.shortcutId(id)

    /**
     * The record as the intent extras [putInto] writes and [fromIntent] reads back: the words as
     * strings, the colours as ints, a colour the manifest left out absent. Pure, so the pairing
     * of the two has a JVM test ([fromExtras]).
     */
    fun extras(): Map<String, Any> = buildMap {
        put(EXTRA_ID, id)
        put(EXTRA_NAME, name)
        put(EXTRA_START_URL, startUrl)
        put(EXTRA_SCOPE, scope)
        put(EXTRA_DISPLAY, display.manifestWord)
        if (themeColor != null) put(EXTRA_THEME_COLOR, themeColor)
        if (backgroundColor != null) put(EXTRA_BACKGROUND_COLOR, backgroundColor)
    }

    fun putInto(intent: Intent): Intent {
        for ((key, value) in extras()) {
            if (value is Int) intent.putExtra(key, value) else intent.putExtra(key, value.toString())
        }
        return intent
    }

    fun toJson(): JSONObject = json(
        "id" to id, "name" to name, "startUrl" to startUrl, "scope" to scope, "display" to display.manifestWord,
        "themeColor" to themeColor, "backgroundColor" to backgroundColor
    )

    companion object {
        const val EXTRA_ID = "app.zen.chromium.extra.WEBAPP_ID"
        const val EXTRA_NAME = "app.zen.chromium.extra.WEBAPP_NAME"
        const val EXTRA_START_URL = "app.zen.chromium.extra.WEBAPP_START_URL"
        const val EXTRA_SCOPE = "app.zen.chromium.extra.WEBAPP_SCOPE"
        const val EXTRA_DISPLAY = "app.zen.chromium.extra.WEBAPP_DISPLAY"
        const val EXTRA_THEME_COLOR = "app.zen.chromium.extra.WEBAPP_THEME_COLOR"
        const val EXTRA_BACKGROUND_COLOR = "app.zen.chromium.extra.WEBAPP_BACKGROUND_COLOR"

        /**
         * The record a `shortcut.pin` request describes, or null for a plain page shortcut: one
         * without a scope, or whose display mode opens a tab (`browser`, or a word this build does
         * not know), or whose start URL is not inside its own scope.
         */
        fun fromRequest(args: JSONObject, title: String): WebAppRecord? {
            val display = WebAppRules.Display.parse(args.strOrNull("display"))
            if (!WebAppRules.ownWindow(display)) return null
            val scope = args.strOrNull("scope")?.takeIf { it.isNotEmpty() } ?: return null
            val url = args.str("url")
            if (!WebAppRules.inScope(url, scope)) return null
            return WebAppRecord(
                id = args.str("id"),
                name = title,
                startUrl = url,
                scope = scope,
                display = display,
                themeColor = ShortcutTile.parseHex(args.strOrNull("themeColor")),
                backgroundColor = ShortcutTile.parseHex(args.strOrNull("backgroundColor"))
            )
        }

        /** The record a launch intent carries, or null when it carries none (an old shortcut). */
        fun fromIntent(intent: Intent?): WebAppRecord? = intent?.let { i ->
            fromExtras(string = i::getStringExtra, int = { key -> if (i.hasExtra(key)) i.getIntExtra(key, 0) else null })
        }

        /**
         * [fromIntent] over the extras alone – [string] and [int] read one key each, null for a
         * key that is not there: a record, or null for an intent without one (a tile pinned
         * before the record existed carries the URL alone) or with a display that opens a tab.
         */
        fun fromExtras(string: (String) -> String?, int: (String) -> Int?): WebAppRecord? {
            val id = string(EXTRA_ID)?.takeIf { it.isNotEmpty() } ?: return null
            val startUrl = string(EXTRA_START_URL)?.takeIf { it.isNotEmpty() } ?: return null
            val scope = string(EXTRA_SCOPE)?.takeIf { it.isNotEmpty() } ?: return null
            val display = WebAppRules.Display.parse(string(EXTRA_DISPLAY))
            if (!WebAppRules.ownWindow(display)) return null
            return WebAppRecord(
                id = id,
                name = string(EXTRA_NAME)?.ifBlank { null } ?: startUrl,
                startUrl = startUrl,
                scope = scope,
                display = display,
                themeColor = int(EXTRA_THEME_COLOR),
                backgroundColor = int(EXTRA_BACKGROUND_COLOR)
            )
        }

        fun fromJson(json: JSONObject): WebAppRecord? {
            val display = WebAppRules.Display.parse(json.strOrNull("display"))
            if (!WebAppRules.ownWindow(display)) return null
            return WebAppRecord(
                id = json.strOrNull("id")?.takeIf { it.isNotEmpty() } ?: return null,
                name = json.strOrNull("name") ?: "",
                startUrl = json.strOrNull("startUrl")?.takeIf { it.isNotEmpty() } ?: return null,
                scope = json.strOrNull("scope")?.takeIf { it.isNotEmpty() } ?: return null,
                display = display,
                themeColor = if (json.isNull("themeColor")) null else json.optInt("themeColor"),
                backgroundColor = if (json.isNull("backgroundColor")) null else json.optInt("backgroundColor")
            )
        }
    }
}

/** The records and tiles on disk, `files/zen/webapps/`; written on the install's IO thread, read by the app's window. */
object WebAppStore {
    private fun dir(context: Context): File = File(context.filesDir, "zen/webapps")

    fun recordFile(context: Context, shortcutId: String): File = File(dir(context), "$shortcutId.json")
    fun tileFile(context: Context, shortcutId: String): File = File(dir(context), "$shortcutId.png")

    /** Any thread but the main one. Failures are swallowed: the intent's extras carry the record too. */
    fun save(context: Context, record: WebAppRecord, tile: Bitmap?) {
        runCatching { write(dir(context), record, tile) }
    }

    /**
     * The install's write into [dir]: the record as [WebAppRecord.toJson] has it – so a record
     * written before (a re-install) starts over, its first-launch mark ([WebAppDisclosure.KEY])
     * with it – and the tile beside it.
     */
    fun write(dir: File, record: WebAppRecord, tile: Bitmap?) {
        dir.mkdirs()
        replace(File(dir, "${record.shortcutId}.json"), record.toJson().toString())
        if (tile != null) File(dir, "${record.shortcutId}.png").outputStream().use { tile.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    /**
     * [text] into [file] whole or not at all: a temp beside it, renamed over it (the shape
     * `Storage.writeBytes` has), so a death mid-write leaves the file as it was rather than torn –
     * a torn record reads as none to [load] and to [WebAppDisclosure]. Throws when nothing landed.
     */
    fun replace(file: File, text: String) {
        file.parentFile?.mkdirs()
        val tmp = File(file.parentFile, "${file.name}.tmp")
        tmp.writeText(text)
        if (!tmp.renameTo(file)) {
            file.delete()
            if (!tmp.renameTo(file)) throw java.io.IOException("could not rename ${tmp.name} over ${file.name}")
        }
    }

    fun load(context: Context, shortcutId: String): WebAppRecord? =
        runCatching { WebAppRecord.fromJson(JSONObject(recordFile(context, shortcutId).readText())) }.getOrNull()
}
