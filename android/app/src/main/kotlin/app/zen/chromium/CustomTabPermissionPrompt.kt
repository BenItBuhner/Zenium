package app.zen.chromium

import androidx.annotation.StringRes

/**
 * What a custom tab's permission prompt asks, and in what order: the family's question for the
 * permission a page's request names – "Allow <site> to know your location?", the `%1$s` the site's
 * host – and one sheet per window at a time. A custom tab has no core: no site decision is written
 * and no answer remembered, so every request of the page is a question of its own, and the queue
 * is the only memory there is – a request arriving while a sheet is up JOINS the ask that puts
 * the same question of the same site (the installed app's window coalesces its waiters the same
 * way, [WebAppNotifications]) and otherwise waits its turn behind the sheet, since two requests of
 * a custom tab can differ (the camera, then the location) where the app window's never do. Pure,
 * so the JVM test holds it; [CustomTabHost] shows the sheets.
 */
object CustomTabPermissionPrompt {
    /**
     * The question for `permission` as the engine names it (`Permissions.kt`: `camera`,
     * `microphone`, `media` for both at once, `geolocation`, `mediaKeySystem`), a string with one
     * `%1$s` for the site; null for a kind a custom tab refuses without asking.
     */
    @StringRes
    fun questionFor(permission: String): Int? = when (permission) {
        "camera" -> R.string.cct_permission_question_camera
        "microphone" -> R.string.cct_permission_question_microphone
        "media" -> R.string.cct_permission_question_media
        "geolocation" -> R.string.cct_permission_question_location
        "mediaKeySystem" -> R.string.cct_permission_question_protected_media
        else -> null
    }

    /** One question on (or waiting for) the sheet, and every request it answers. */
    class Ask(@StringRes val question: Int, val site: String) {
        val requestIds = ArrayList<String>()
    }

    /** The asks of one window: the one on the sheet first, the ones behind it in the order they came. */
    class Queue {
        private val asks = ArrayDeque<Ask>()

        /** The ask on the sheet; null while none is up. */
        val current: Ask? get() = asks.firstOrNull()

        val size: Int get() = asks.size

        /**
         * A request arrives. It joins the ask putting the same question of the same site if one is
         * up or waiting, else an ask of its own goes to the back. True when that ask is the current
         * one and no sheet is up for it yet – the caller shows the sheet.
         */
        fun add(requestId: String, @StringRes question: Int, site: String): Boolean {
            asks.firstOrNull { it.question == question && it.site == site }?.let {
                it.requestIds += requestId
                return false
            }
            asks.addLast(Ask(question, site).also { it.requestIds += requestId })
            return asks.size == 1
        }

        /** The current ask is answered: taken off, so the next in line (if any) is [current] now. */
        fun settle(): Ask? = asks.removeFirstOrNull()

        /** The window is going: nothing left to ask. */
        fun clear() = asks.clear()
    }
}
