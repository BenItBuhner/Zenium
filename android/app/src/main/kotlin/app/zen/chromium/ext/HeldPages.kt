package app.zen.chromium.ext

/**
 * Tab pages asked for on an extension's origin before the runtime serves the extension.
 *
 * At boot the core restores the windows before it configures the extensions (`browser.start`
 * restores, `extensions.start()` configures, and a configure reads and compiles files), so a
 * restored tab on an extension page requests its document while [Extensions.intercept] has
 * nothing to answer with. The core says first which extensions it is about to configure
 * (`ext.expect`, before the windows are restored); a main-frame request for one of those is
 * answered with an empty document and held here, and the page is loaded again once the
 * extension's configure completes ([served]). A page of an extension the core will not serve
 * (not enabled, not installed, or one whose attach failed by the time the core said it was
 * done, `ext.expect []`) fails as Chrome fails the page of an extension that is not enabled:
 * `ERR_BLOCKED_BY_CLIENT` ([expect], [dropped] hand those pages back to fail).
 *
 * Pure bookkeeping, generic over the view so it runs under JUnit; the intercept thread holds,
 * the main thread releases, so every entry point is synchronized.
 */
class HeldPages<V : Any> {
    class Held<V>(val view: V, val url: String)

    private val expected = HashSet<String>()
    private val held = LinkedHashMap<String, MutableList<Held<V>>>()

    /**
     * The ids the core is about to configure, replacing the last word. Returns the pages held
     * for any other id: those extensions are not coming, the pages fail.
     */
    @Synchronized
    fun expect(ids: Collection<String>): List<Held<V>> {
        expected.clear()
        expected.addAll(ids)
        val release = ArrayList<Held<V>>()
        for (id in held.keys.toList()) if (id !in expected) release.addAll(held.remove(id)!!)
        return release
    }

    /** Whether the core said it would configure `id`. */
    @Synchronized
    fun expects(id: String): Boolean = id in expected

    /**
     * Hold `view`'s main-frame request for `url`, a page of `id`, until the extension is served;
     * one hold per view and URL, however often the document is asked for meanwhile.
     */
    @Synchronized
    fun hold(id: String, view: V, url: String) {
        val list = held.getOrPut(id) { ArrayList() }
        if (list.none { it.view === view && it.url == url }) list.add(Held(view, url))
    }

    /**
     * Take one hold back: the extension turned out to be served between the check and the
     * hold (the intercept thread lost the race to a configure), the request gets the real answer.
     */
    @Synchronized
    fun unhold(id: String, view: V, url: String) {
        val list = held[id] ?: return
        val at = list.indexOfLast { it.view === view && it.url == url }
        if (at >= 0) list.removeAt(at)
        if (list.isEmpty()) held.remove(id)
    }

    /** The extension is served now: the pages held for it, to load again. */
    @Synchronized
    fun served(id: String): List<Held<V>> = held.remove(id) ?: emptyList()

    /** The extension is gone (detached) or not coming: the pages held for it, to fail. */
    @Synchronized
    fun dropped(id: String): List<Held<V>> {
        expected.remove(id)
        return held.remove(id) ?: emptyList()
    }

    /** Ids with pages held right now (instrumentation). */
    @Synchronized
    fun holding(): Set<String> = held.keys.toSet()
}
