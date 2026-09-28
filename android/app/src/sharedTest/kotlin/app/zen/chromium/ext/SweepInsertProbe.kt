package app.zen.chromium.ext

/**
 * The compat sweep's reading of a script-insert probe: when an extension's `<script src>` of its
 * own web-accessible file left no trace in the page's resource timeline (AdGuard Extra's
 * `userscript.js` on WebView 156 at compat round 23's BEFORE: its isolated-world content script
 * ran at document_start with no error and appended and removed the element, and the timeline
 * held no entry for it in ~100 s, where WebView 113's page world fetched it), the driver runs
 * the same insertion again three ways and reads each load's verdict – in the extension's world
 * with `chrome.runtime.getURL(file)` as the content script spells it, in the world with the
 * served origin spelled out, and in the page world with the served origin – so the miss is
 * told apart: the timing of document_start (every insert loads now and the world's leaves a
 * timeline entry), the timeline's blindness (the world's insert loads and leaves NO entry where
 * the page's leaves one: the row's timeline read cannot see a world load on the lane, so the
 * extension's own insertion is unread, not shown missing), the world's `getURL` spelling (the
 * served origin loads from the world, the `getURL` string does not), the world itself (the
 * page's insert alone loads) or the loader (none loads). Pure; the driver's `adguardExtraProbe`
 * records the legs and this names them.
 */
object SweepInsertProbe {
    /** What one inserted element came to: its `load` event, its `error` event, or neither within the wait. */
    enum class Verdict { LOAD, ERROR, NONE }

    /**
     * The legs: whether the world's inserts ran at all (a WebView without isolated worlds has
     * one realm, so the page's insert stands for both), the three verdicts, whether each left a
     * timeline entry, and the bridge's script-recovery lines of the row (`mainScript`,
     * `extFetch`: a refused element the bootstrap handed to the host).
     */
    data class Legs(
        val worldRan: Boolean,
        val world: Verdict,
        val worldOrigin: Verdict,
        val page: Verdict,
        val worldEntry: Boolean,
        val worldOriginEntry: Boolean,
        val pageEntry: Boolean,
        val recoveryLines: Int
    )

    /** The verdict of an element from the attribute its listeners wrote (`load` / `error`), none without one. */
    fun verdict(attribute: String?): Verdict = when (attribute) {
        "load" -> Verdict.LOAD
        "error" -> Verdict.ERROR
        else -> Verdict.NONE
    }

    /** The reading, one sentence naming where the miss is; the recovery lines appended when the bridge has any. */
    fun reading(legs: Legs): String {
        val recovery = if (legs.recoveryLines > 0) "; the bridge carries ${legs.recoveryLines} script-recovery line(s) for the row" else ""
        if (!legs.worldRan) {
            return when (legs.page) {
                Verdict.LOAD -> "one realm: the page's insert of the served origin loads now (${entryWord(legs.pageEntry)}), so the extension's own miss is its moment, not the loader"
                Verdict.ERROR -> "one realm: the page's insert of the served origin fails with an error event (${entryWord(legs.pageEntry)}) – the served answer is refused"
                Verdict.NONE -> "one realm: the page's insert of the served origin came to nothing in the wait (${entryWord(legs.pageEntry)}) – the loader"
            } + recovery
        }
        val worldLoads = legs.world == Verdict.LOAD || legs.worldOrigin == Verdict.LOAD
        val worldEntries = (legs.world == Verdict.LOAD && legs.worldEntry) || (legs.worldOrigin == Verdict.LOAD && legs.worldOriginEntry)
        return when {
            legs.world != Verdict.LOAD && legs.worldOrigin == Verdict.LOAD ->
                "the world's getURL spelling is the miss: the served origin loads from the world (${entryWord(legs.worldOriginEntry)}) where the getURL string ${legs.world.name.lowercase()} (${entryWord(legs.worldEntry)})"
            worldLoads && legs.page == Verdict.LOAD && !worldEntries && legs.pageEntry ->
                "the same insertion loads from the world and the page now, and the world's load leaves no timeline entry where the page's leaves one: the row's timeline read is blind to a world load on this lane – the extension's own document_start insertion is unread, not shown missing (Chrome's timeline is blind to it by the same rule; the served-resource record is the row's read)"
            worldLoads && legs.page == Verdict.LOAD ->
                "the same insertion loads from the world and the page now (world ${legs.world.name.lowercase()}, ${entryWord(legs.worldEntry)}; page load, ${entryWord(legs.pageEntry)}): the extension's own miss is document_start's moment – an element appended under <html> before <head> exists –, not the world or the loader"
            !worldLoads && legs.page == Verdict.LOAD ->
                "the world is the miss: the page's insert loads (${entryWord(legs.pageEntry)}) where neither of the world's does (getURL ${legs.world.name.lowercase()}, served origin ${legs.worldOrigin.name.lowercase()})"
            legs.world == Verdict.ERROR && legs.worldOrigin == Verdict.ERROR && legs.page == Verdict.ERROR ->
                "every insert fails with an error event (entries: world ${legs.worldEntry}, page ${legs.pageEntry}) – the served answer is refused in both worlds"
            legs.world == Verdict.NONE && legs.worldOrigin == Verdict.NONE && legs.page == Verdict.NONE ->
                "the loader is the miss: no insert came to a load or an error in the wait from either world (entries: world ${legs.worldEntry}, page ${legs.pageEntry})"
            else ->
                "mixed: world ${legs.world.name.lowercase()} / served origin ${legs.worldOrigin.name.lowercase()} / page ${legs.page.name.lowercase()} (entries ${legs.worldEntry} / ${legs.worldOriginEntry} / ${legs.pageEntry})"
        } + recovery
    }

    private fun entryWord(entry: Boolean): String = if (entry) "a timeline entry" else "no timeline entry"
}
