package app.zen.chromium.ext

/**
 * Which attach of an extension a configure belongs to.
 *
 * `ext.configure` compiles its units off the main thread and installs them on it, so an
 * `ext.detach` of the same extension (or a new runtime's `ext.env`, which resets everything) can
 * land between the two. Without a check, the post would put the units, the served record and the
 * configure stats of a detached extension back and install its document-start scripts on every
 * tab, where they stay until its next attach or the app's restart (measured in compat round 17:
 * uBlock Origin Lite's `scripting.registerContentScripts` some 35 s after its worker's start,
 * re-planned by the core into a host compile while the extension was being disabled).
 *
 * A configure notes [current] when it is requested; its post applies only while [isCurrent]
 * still says so. A detach moves the extension's epoch, a reset moves every extension's.
 *
 * Main thread only (the note, the move and the check all run there). Pure, so the JVM unit
 * tests cover it.
 */
class AttachEpochs {
    private var generation = 0L
    private var resetAt = 0L
    private val detachedAt = HashMap<String, Long>()

    /** The extension's epoch now: a value that no earlier configure of it could have noted. */
    fun current(extensionId: String): Long = maxOf(resetAt, detachedAt[extensionId] ?: 0L)

    /** Whether nothing has detached or reset the extension since `epoch` was noted. */
    fun isCurrent(extensionId: String, epoch: Long): Boolean = current(extensionId) == epoch

    /** The extension was detached: every configure of it requested before now is stale. */
    fun detached(extensionId: String) {
        detachedAt[extensionId] = ++generation
    }

    /** Every extension went (a new runtime): every configure requested before now is stale. */
    fun reset() {
        resetAt = ++generation
        detachedAt.clear()
    }
}
