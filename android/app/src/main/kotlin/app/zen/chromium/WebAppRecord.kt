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

    fun putInto(intent: Intent): Intent = intent
        .putExtra(EXTRA_ID, id)
        .putExtra(EXTRA_NAME, name)
        .putExtra(EXTRA_START_URL, startUrl)
        .putExtra(EXTRA_SCOPE, scope)
        .putExtra(EXTRA_DISPLAY, display.manifestWord)
        .apply {
            if (themeColor != null) putExtra(EXTRA_THEME_COLOR, themeColor)
            if (backgroundColor != null) putExtra(EXTRA_BACKGROUND_COLOR, backgroundColor)
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
        fun fromIntent(intent: Intent?): WebAppRecord? {
            if (intent == null) return null
            val id = intent.getStringExtra(EXTRA_ID)?.takeIf { it.isNotEmpty() } ?: return null
            val startUrl = intent.getStringExtra(EXTRA_START_URL)?.takeIf { it.isNotEmpty() } ?: return null
            val scope = intent.getStringExtra(EXTRA_SCOPE)?.takeIf { it.isNotEmpty() } ?: return null
            val display = WebAppRules.Display.parse(intent.getStringExtra(EXTRA_DISPLAY))
            if (!WebAppRules.ownWindow(display)) return null
            return WebAppRecord(
                id = id,
                name = intent.getStringExtra(EXTRA_NAME)?.ifBlank { null } ?: startUrl,
                startUrl = startUrl,
                scope = scope,
                display = display,
                themeColor = if (intent.hasExtra(EXTRA_THEME_COLOR)) intent.getIntExtra(EXTRA_THEME_COLOR, 0) else null,
                backgroundColor = if (intent.hasExtra(EXTRA_BACKGROUND_COLOR)) intent.getIntExtra(EXTRA_BACKGROUND_COLOR, 0) else null
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
        runCatching {
            dir(context).mkdirs()
            recordFile(context, record.shortcutId).writeText(record.toJson().toString())
            if (tile != null) tileFile(context, record.shortcutId).outputStream().use { tile.compress(Bitmap.CompressFormat.PNG, 100, it) }
        }
    }

    fun load(context: Context, shortcutId: String): WebAppRecord? =
        runCatching { WebAppRecord.fromJson(JSONObject(recordFile(context, shortcutId).readText())) }.getOrNull()
}
