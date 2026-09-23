package app.zen.chromium

/**
 * The once-only rule of the app's notification permission ask ([Permissions.ensureNotificationsAllowed]),
 * apart from Android: Android 13's `POST_NOTIFICATIONS` prompt shows ONCE per install, the first
 * time anything wants to post (a site's first notification grant, the first download, an
 * extension's first card), and never a second time whoever asks; everyone arriving while the
 * prompt is up shares its answer. `askedBefore` and `markAsked` are the install's memory.
 */
class NotificationAsk(private val askedBefore: () -> Boolean, private val markAsked: () -> Unit) {
    private var waiters: ArrayList<(Boolean) -> Unit>? = null

    /**
     * One caller. Without a prompt to face (`needsPrompt` false: below Android 13, or the permission
     * held) it is answered at once with `allowed`, the system's switch. Otherwise it waits for the
     * prompt's answer ([settle]); the answer is whether THIS caller must show the prompt, true for
     * the first caller of an install only. A caller after the one ask is answered no at once.
     */
    fun arrive(needsPrompt: Boolean, allowed: Boolean, then: (Boolean) -> Unit): Boolean {
        if (!needsPrompt) {
            then(allowed)
            return false
        }
        waiters?.let { up ->
            up += then
            return false
        }
        if (askedBefore()) {
            then(false)
            return false
        }
        markAsked()
        waiters = arrayListOf(then)
        return true
    }

    /** The prompt's answer, handed to everyone who waited for it. */
    fun settle(granted: Boolean) {
        val up = waiters ?: return
        waiters = null
        for (then in up) then(granted)
    }
}
