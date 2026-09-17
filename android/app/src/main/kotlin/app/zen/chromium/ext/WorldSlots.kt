package app.zen.chromium.ext

/**
 * The isolated worlds of a tab WebView are a fixed pool, decided at the view's construction.
 *
 * A WebMessageListener for a world has to be registered before the view's first document:
 * `addWebMessageListener` on a WebView with live frames re-sends the frame's JS objects to the
 * renderer, and under Chromium's lazy-binding of those objects (WebView 156, `LazyBindJsInjection`)
 * the bindings a document already holds lose their browser-side reply proxy, so the next
 * `postMessage` from an existing content script takes the renderer down (measured on the
 * emulator: a SIGSEGV in `libwebviewchromium.so` about 400 ms after a later extension's
 * configure). So every tab view registers the bridge listener of [size] world slots when it is
 * built, and the core's per-extension world names (`zenium-ext-<id>`, `zenium-ext-<id>-user`)
 * are mapped onto slots here, when an extension's units first need one, and given back when the
 * extension is detached.
 *
 * Main thread only. Pure, so the JVM unit tests cover it.
 */
class WorldSlots(val size: Int) {
    private val slotOf = HashMap<String, Int>()
    private val owners = arrayOfNulls<String>(size)
    private val nameOf = arrayOfNulls<String>(size)

    /** The WebView world name behind a slot (the same on every view). */
    fun worldName(slot: Int): String = "zenium-w$slot"

    /** The slot a core world name is mapped to, or null when it has none. */
    fun slot(name: String): Int? = slotOf[name]

    /** The extension that owns a slot, or null when it is free. */
    fun owner(slot: Int): String? = owners.getOrNull(slot)

    /** How many slots are free. */
    fun free(): Int = owners.count { it == null }

    /**
     * Map every name in `names` to a slot for `extensionId`, keeping the mappings it already has
     * and giving back the ones it no longer uses. Returns false, changing nothing, when the pool
     * cannot hold them all (the core keeps within the budget it was told; this is the backstop).
     */
    fun assign(extensionId: String, names: Collection<String>): Boolean {
        val wanted = names.toSet()
        // A name another extension holds (a core bug) is not taken over.
        if (wanted.any { name -> slotOf[name]?.let { owners[it] != extensionId } == true }) return false
        val fresh = wanted.filter { slotOf[it] == null }
        val stale = slotOf.filter { (name, slot) -> owners[slot] == extensionId && name !in wanted }.keys.toList()
        if (fresh.size > free() + stale.size) return false
        for (name in stale) release(name)
        for (name in fresh) {
            val slot = owners.indexOfFirst { it == null }
            owners[slot] = extensionId
            nameOf[slot] = name
            slotOf[name] = slot
        }
        return true
    }

    /** Give back every slot of an extension. */
    fun releaseAll(extensionId: String) {
        for (slot in owners.indices) if (owners[slot] == extensionId) releaseSlot(slot)
    }

    fun clear() {
        for (slot in owners.indices) releaseSlot(slot)
    }

    private fun release(name: String) {
        slotOf[name]?.let(::releaseSlot)
    }

    private fun releaseSlot(slot: Int) {
        nameOf[slot]?.let(slotOf::remove)
        nameOf[slot] = null
        owners[slot] = null
    }
}
