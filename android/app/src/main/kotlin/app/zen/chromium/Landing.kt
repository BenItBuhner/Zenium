package app.zen.chromium

import android.content.Intent

/**
 * The state a Home-screen widget or a launcher shortcut asks the browser window to land in
 * (WID-07): the omnibox focused with the keyboard up ([SEARCH]), the voice search sheet listening
 * ([VOICE]), a new private tab ([PRIVATE]) or the QR scanner ([SCAN]). It travels as one string
 * extra on the intent that starts or re-enters `MainActivity`, and nothing else: the activity's
 * intent switch reads it ([of]) and hands the word to `ChromeWebView.land`. On a cold start the
 * chrome's document is still loading, so the word waits in a [Stash] and travels IN the core's
 * boot answer (`BootInfo.landing`), which `bootAndroid` applies right after `browser.start()`, in
 * the boot's own run – so the chrome's first frame already shows the requested state and the
 * restored tab is never seen first. Warm (`onNewIntent`) it goes to `window.__zenHost.land` at
 * once. No new work on the boot path: an extra, its reader, and one null read of the answer's
 * field in a start that carries none.
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

    /**
     * The landing [intent] asks for – the extra's word, or the one its action implies
     * ([forwarded]: a third party's explicit `NEW_PRIVATE_TAB` intent aimed at `MainActivity`
     * itself is the private landing by another name, on the same path) – or null.
     */
    fun of(intent: Intent?): String? = forwarded(intent?.action, intent?.getStringExtra(EXTRA))

    /**
     * The landing an intent's word and action come to: the landing it named, or the one its
     * action implies (`PrivateBrowsing.ACTION_NEW_TAB` is the private landing by another name –
     * the shortcut that predates the extra keeps its action, and so does a pinned copy of it aimed
     * straight at `MainActivity`). What the trampoline carries over to `MainActivity` for a
     * shortcut's intent, and what `MainActivity` reads of its own. Null for a plain launcher tap.
     */
    fun forwarded(action: String?, extra: String?): String? =
        parse(extra) ?: if (action == PrivateBrowsing.ACTION_NEW_TAB) PRIVATE else null

    /**
     * Where a landing waits for the core's boot answer (`ChromeWebView.land`, [take] from
     * `Host.dispatchSync("boot")`). Until the document's core has asked for its boot, [offer]
     * keeps the word (a later offer replaces an earlier one: the last tap is what the user
     * wants) and [take] hands it into the answer, once; from then on the document is booted,
     * [offer] declines and the caller sends the word to the host global at once – the warm path.
     * [reset] is a replaced chrome document, whose core will ask for its boot again. Offered on
     * the main thread, taken on the bridge thread, hence the lock. Pure, so it has a JVM test.
     */
    class Stash {
        private val lock = Any()
        private var pending: String? = null
        private var booted = false

        /** Keep [state] for the boot answer; false once that answer has been taken (send it now). */
        fun offer(state: String): Boolean = synchronized(lock) {
            if (booted) {
                false
            } else {
                pending = state
                true
            }
        }

        /** The boot answer's landing: what waited, or null; the document counts as booted from here on. */
        fun take(): String? = synchronized(lock) {
            booted = true
            pending.also { pending = null }
        }

        /** The chrome document is being replaced: the next boot answer carries the next landing. */
        fun reset() {
            synchronized(lock) { booted = false }
        }
    }
}
