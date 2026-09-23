package app.zen.chromium

import android.content.Intent

/**
 * The state a Home-screen widget or a launcher shortcut asks the browser window to land in
 * (WID-07): the omnibox focused with the keyboard up ([SEARCH]), the voice search sheet listening
 * ([VOICE]), a new private tab ([PRIVATE]) or the QR scanner ([SCAN]). It travels as one string
 * extra on the intent that starts or re-enters `MainActivity`, and nothing else: the activity's
 * intent switch reads it ([of]) and hands the word to the chrome through the queue the launch URL
 * and the private shortcut ride already (`ChromeWebView.land` → `window.__zenHost.land`), where the
 * boot delivers it in the same run that starts the core – so the chrome's first frame already
 * shows the requested state and the restored tab is never seen first. No new work on the boot
 * path: an extra and its reader.
 *
 * The widget's `PendingIntent`s ([SearchWidgetProvider]) aim straight at `MainActivity` – a widget's
 * intent is fired as built, unlike a manifest shortcut's, which the system stamps with
 * `FLAG_ACTIVITY_CLEAR_TASK` (`ShortcutParser`) and which therefore goes through the
 * `LauncherIconActivity` trampoline with the extra carried over ([forwarded]). Pure where it can
 * be, so the parse has a JVM test.
 */
object Landing {
    /** The intent extra's name; its value one of [STATES]. */
    const val EXTRA = "app.zen.chromium.extra.LANDING"

    /** The omnibox focused for the active tab, the keyboard up (the widget's bar, the Search shortcut). */
    const val SEARCH = "search"

    /** The voice search sheet open and listening (the widget's mic). */
    const val VOICE = "voice"

    /** A new private tab in the current space (the widget's mask, the New private tab shortcut). */
    const val PRIVATE = "private"

    /** The QR scanner open (the Scan QR code shortcut). */
    const val SCAN = "scan"

    /** A plain new tab in the current space, active (the New tab shortcut). */
    const val NEW_TAB = "newTab"

    val STATES: Set<String> = setOf(SEARCH, VOICE, PRIVATE, SCAN, NEW_TAB)

    /**
     * The state a raw extra value names, or null for anything that is not one of [STATES]: an
     * absent extra, an empty string, or a word this build does not know (an older widget's intent
     * after an update, a hand-built `am start`). Case and surrounding blanks are forgiven, the
     * value the chrome receives is the canonical word.
     */
    fun parse(value: String?): String? {
        val word = value?.trim() ?: return null
        return STATES.firstOrNull { it.equals(word, ignoreCase = true) }
    }

    /** The landing [intent] asks for, or null. */
    fun of(intent: Intent?): String? = parse(intent?.getStringExtra(EXTRA))

    /**
     * What the trampoline carries over to `MainActivity` for a shortcut's intent: the landing it
     * named, or the one its action implies (`PrivateBrowsing.ACTION_NEW_TAB` is the private
     * landing by another name – the shortcut that predates the extra keeps its action). Null for a
     * plain launcher tap.
     */
    fun forwarded(action: String?, extra: String?): String? =
        parse(extra) ?: if (action == PrivateBrowsing.ACTION_NEW_TAB) PRIVATE else null
}
