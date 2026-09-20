package app.zen.chromium

import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap

/**
 * What the host keeps of each tab's back/forward list for the core's two synchronous questions,
 * which come in on the bridge thread, where the WebView cannot be asked: the last list the view
 * pushed (`historyChanged { entries, index }`, for `view.navigationEntries`) and the latest
 * `hostState` behind it (the `saveState` bundle, encoded, for `view.navigationHostState`). Both
 * are written on the main thread as the view pushes ([listChanged], [stateChanged]) and read
 * from the bridge thread ([entries], [hostState]); the view refreshes the state before it pushes
 * the list, so the state is never staler than the list it is asked for with.
 *
 * An entry lives as long as its tab's view: gone when the view is destroyed ([forget]), when a
 * popup's view takes its tab's id (whatever was kept under the provisional id goes, [forget]
 * again), and all of them when the chrome is rebuilt ([clear]). `now` is the clock the state's
 * age ([stateAge]) is told by; the demo driver reads it at close time.
 */
class NavigationMirror(private val now: () -> Long = System::currentTimeMillis) {
    private class State(val text: String, val at: Long)

    private val lists = ConcurrentHashMap<String, JSONObject>()
    private val states = ConcurrentHashMap<String, State>()

    /** The view of `tabId` pushed `list` (`{ entries, index }`). */
    fun listChanged(tabId: String, list: JSONObject) {
        lists[tabId] = list
    }

    /** The view of `tabId` has this `hostState` for its list now, or none (null: private, empty, over the cap). */
    fun stateChanged(tabId: String, hostState: String?) {
        if (hostState == null) states.remove(tabId) else states[tabId] = State(hostState, now())
    }

    /** Nothing is kept for `tabId` any more: its view is gone, or goes on under another id. */
    fun forget(tabId: String) {
        lists.remove(tabId)
        states.remove(tabId)
    }

    /** Every tab's view is gone (the chrome, and the core with it, is rebuilt). */
    fun clear() {
        lists.clear()
        states.clear()
    }

    /** `view.navigationEntries`: the last list pushed, or `{ entries: [], index: -1 }` for a tab that pushed none. */
    fun entries(tabId: String): JSONObject = lists[tabId] ?: NavigationState.emptySnapshot()

    /** `view.navigationHostState`: the latest state, or null when there is none to keep. */
    fun hostState(tabId: String): String? = states[tabId]?.text

    /** How long ago the state of `tabId` was last refreshed, in the clock's units, or null without one. */
    fun stateAge(tabId: String): Long? = states[tabId]?.let { now() - it.at }
}
