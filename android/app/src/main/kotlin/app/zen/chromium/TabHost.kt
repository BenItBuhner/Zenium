package app.zen.chromium

import android.content.Context
import android.content.MutableContextWrapper
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import org.json.JSONObject

/**
 * Owns the tab WebViews and places them above the chrome exactly where the core says, in device
 * pixels converted from the chrome's CSS pixels.
 */
class TabHost(private val container: FrameLayout, private val host: PageHost) {
    private val views = HashMap<String, TabWebView>()
    private var popupSeq = 0
    private val density: Float get() = container.resources.displayMetrics.density

    fun get(tabId: String): TabWebView? = views[tabId]

    fun all(): Collection<TabWebView> = views.values

    fun tabIdOf(view: View?): String? = (view as? TabWebView)?.tabId

    /**
     * `context` is the activity by default; a [MutableContextWrapper] around it lets the page move
     * to another activity later (see [adopt]), which is what a custom tab creates its page with.
     */
    fun create(tabId: String, containerId: String, context: Context = container.context): TabWebView {
        // A view already held under this id is an orphan: the core registers its new view before it
        // asks, so a `destroyed` for the id would land on that new view and mark it dead – a tab
        // that never gets bounds again. Drop the old one without a word.
        views.remove(tabId)?.let(::drop)
        val view = TabWebView(context, tabId, containerId, host)
        view.visibility = View.GONE
        container.addView(view, FrameLayout.LayoutParams(0, 0))
        views[tabId] = view
        return view
    }

    /**
     * Take a live page out of this host without destroying it, so another host can [adopt] it:
     * "Open in Zenium" hands a custom tab's page, history and all, to the browser window.
     */
    fun release(tabId: String): TabWebView? {
        val view = views.remove(tabId) ?: return null
        host.exitFullscreen(view)
        view.backTransition?.abort()
        host.snapshots.forget(tabId)
        (view.parent as? ViewGroup)?.removeView(view)
        return view
    }

    /**
     * Make a page another host [release]d one of ours. Its context is re-pointed at this window
     * (dialogs and pickers the page opens from now on belong here), it starts hidden and unplaced
     * like every new view, and the core is told to adopt it as an active tab the way it adopts a
     * popup; the core answers with `view.bind`, which reports the page's URL and title.
     */
    fun adopt(view: TabWebView) {
        val viewId = "handoff_${++popupSeq}"
        (view.context as? MutableContextWrapper)?.baseContext = container.context
        view.host = host
        view.tabId = viewId
        view.visibility = View.GONE
        view.translationX = 0f
        container.addView(view, FrameLayout.LayoutParams(0, 0))
        views[viewId] = view
        host.hostEvent("view.adopt", json("viewId" to viewId, "parentTabId" to null, "active" to true))
    }

    /** A `window.open` popup: created before the core knows about it, bound once it does. */
    fun createPopup(containerId: String): TabWebView {
        val viewId = "popup_${++popupSeq}"
        return create(viewId, containerId)
    }

    fun bind(viewId: String, tabId: String) {
        val view = views.remove(viewId) ?: return
        view.tabId = tabId
        views[tabId] = view
        // Whatever the popup loaded before the core knew its tab id is reported now.
        host.viewEvent(tabId, "navigated", view.navState().put("inPage", false))
        if (!view.title.isNullOrEmpty()) host.viewEvent(tabId, "title", json("title" to view.title))
    }

    fun destroy(tabId: String) {
        val view = views.remove(tabId) ?: return
        drop(view)
        host.viewEvent(tabId, "destroyed", null)
    }

    fun destroyAll() {
        for (id in views.keys.toList()) destroy(id)
    }

    /**
     * Every view, without a word to the chrome: for a chrome whose renderer is gone or whose
     * document is being replaced. The core that boots next recreates the tabs from the persisted
     * state, so nothing here must survive under a tab id it will ask for.
     */
    fun dropAll() {
        for (view in views.values.toList()) drop(view)
        views.clear()
        host.snapshots.clear()
    }

    /** Tear a view down (already removed from [views]); the chrome is not told. */
    private fun drop(view: TabWebView) {
        host.exitFullscreen(view)
        view.backTransition?.abort()
        host.snapshots.forget(view.tabId)
        (view.parent as? ViewGroup)?.removeView(view)
        view.stopLoading()
        runCatching { view.destroy() }
    }

    /**
     * The renderer process behind a tab died: swap in a fresh WebView with the same identity, and
     * answer whether that happened. A view that is no longer the one registered for its tab – the
     * chrome lost the same renderer and dropped it while being rebuilt, or it was replaced already
     * – is left alone: registering a stand-in under a tab id the rebooted core is about to create
     * would hand that tab a view the core knows nothing about.
     */
    fun replaceCrashed(dead: TabWebView): Boolean {
        val tabId = dead.tabId
        if (views[tabId] !== dead) return false
        val lp = dead.layoutParams as? FrameLayout.LayoutParams
        val visible = dead.visibility == View.VISIBLE
        dead.backTransition?.abort()
        val index = container.indexOfChild(dead)
        views.remove(tabId)
        container.removeView(dead)
        runCatching { dead.destroy() }
        // The dead view's context (a custom tab's page carries a MutableContextWrapper), so the
        // replacement can still move to another window later.
        val fresh = TabWebView(dead.context, tabId, dead.containerId, host)
        fresh.visibility = if (visible) View.VISIBLE else View.GONE
        container.addView(fresh, if (index >= 0) index else -1, lp ?: FrameLayout.LayoutParams(0, 0))
        views[tabId] = fresh
        return true
    }

    fun setBounds(tabId: String, rect: JSONObject) {
        val view = views[tabId] ?: return
        val d = density
        val x = (rect.num("x") * d).toInt()
        val y = (rect.num("y") * d).toInt()
        val w = (rect.num("width") * d).toInt().coerceAtLeast(0)
        val h = (rect.num("height") * d).toInt().coerceAtLeast(0)
        val lp = (view.layoutParams as? FrameLayout.LayoutParams) ?: FrameLayout.LayoutParams(w, h)
        if (lp.leftMargin == x && lp.topMargin == y && lp.width == w && lp.height == h) return
        lp.leftMargin = x
        lp.topMargin = y
        lp.width = w
        lp.height = h
        view.layoutParams = lp
    }

    fun setRadius(tabId: String, radiusCss: Double) {
        views[tabId]?.setRadius((radiusCss * density).toFloat())
    }

    fun setVisible(tabId: String, visible: Boolean) {
        val view = views[tabId] ?: return
        // GONE views neither draw nor receive input; JS keeps running so background audio, like
        // in Zen, carries on until the core unloads the tab.
        val next = if (visible) View.VISIBLE else View.GONE
        if (view.visibility != next) view.visibility = next
    }

    fun bringToFront(tabId: String) {
        views[tabId]?.bringToFront()
    }
}
