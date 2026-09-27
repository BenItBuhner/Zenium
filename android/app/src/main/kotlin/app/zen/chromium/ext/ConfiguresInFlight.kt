package app.zen.chromium.ext

/**
 * How many `ext.configure` calls of an extension are between their request and their landing.
 *
 * A configure compiles its units off the main thread and installs them on it, seconds later
 * for a plan of Adblock Ad Blocker Pro's size (11 units, 19.8 million characters: 8.1 s cold on
 * the API 34 emulator). Instrumentation that reads the runtime's heap for the extension
 * ([Extensions.unitMemory]) in that window reads a plan being replaced: compat round 22's
 * `[lane]` run took Adblock's heap split while the worker's `registerContentScripts` re-plan
 * (1 unit to 11) was in flight – the reading stood on the compiler's lock for the compile's last
 * 1.5 s, counted the new plan's 11 units against the 1 installed, released the compiler's copy,
 * and the configure's post then installed the 11 it had in hand, live until the row's disable and
 * counted with the rules. The count here tells such a reading to wait: a configure is [begun]
 * when it is requested and [landed] when its post has run (applied, dropped as stale, refused
 * a world slot, or its directory refused before a compile), so [pending] is zero exactly when
 * the runtime's units for the extension are what its last configure installed.
 *
 * Main thread only ([Extensions.handle] and the configure's post both run there). Pure, so the
 * JVM unit tests cover it.
 */
class ConfiguresInFlight {
    private val counts = HashMap<String, Int>()

    /** A configure of the extension was requested: its compile is about to start. */
    fun begun(extensionId: String) {
        counts[extensionId] = (counts[extensionId] ?: 0) + 1
    }

    /** A configure's post ran, whatever it did; a landing with none pending (after [reset]) is no error. */
    fun landed(extensionId: String) {
        val left = (counts[extensionId] ?: 0) - 1
        if (left <= 0) counts.remove(extensionId) else counts[extensionId] = left
    }

    /** The configures of the extension requested and not landed yet. */
    fun pending(extensionId: String): Int = counts[extensionId] ?: 0

    /** Every extension went (a new runtime, or this one destroyed): what was in flight lands as dropped. */
    fun reset() {
        counts.clear()
    }
}
