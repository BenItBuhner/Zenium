package app.zen.chromium

import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import org.json.JSONObject

/**
 * Owns the tab WebViews and places them above the chrome exactly where the core says, in device
 * pixels converted from the chrome's CSS pixels.
 */
class TabHost(private val container: FrameLayout, private val host: Host) {
    private val views = HashMap<String, TabWebView>()
    private var popupSeq = 0
    private val density: Float get() = container.resources.displayMetrics.density

    fun get(tabId: String): TabWebView? = views[tabId]

    fun all(): Collection<TabWebView> = views.values

    fun tabIdOf(view: View?): String? = (view as? TabWebView)?.tabId

    fun create(tabId: String, containerId: String): TabWebView {
        views[tabId]?.let { destroy(tabId) }
        val view = TabWebView(container.context, tabId, containerId, host)
        view.visibility = View.GONE
        container.addView(view, FrameLayout.LayoutParams(0, 0))
        views[tabId] = view
        return view
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
        host.chrome.viewEvent(tabId, "navigated", view.navState().put("inPage", false))
        if (!view.title.isNullOrEmpty()) host.chrome.viewEvent(tabId, "title", json("title" to view.title))
    }

    fun destroy(tabId: String) {
        val view = views.remove(tabId) ?: return
        host.exitFullscreen(view)
        (view.parent as? ViewGroup)?.removeView(view)
        view.stopLoading()
        view.destroy()
        host.chrome.viewEvent(tabId, "destroyed", null)
    }

    fun destroyAll() {
        for (id in views.keys.toList()) destroy(id)
    }

    /** The renderer process behind a tab died: swap in a fresh WebView with the same identity. */
    fun replaceCrashed(dead: TabWebView) {
        val tabId = dead.tabId
        val lp = dead.layoutParams as? FrameLayout.LayoutParams
        val visible = dead.visibility == View.VISIBLE
        val index = container.indexOfChild(dead)
        views.remove(tabId)
        container.removeView(dead)
        runCatching { dead.destroy() }
        val fresh = TabWebView(container.context, tabId, dead.containerId, host)
        fresh.visibility = if (visible) View.VISIBLE else View.GONE
        container.addView(fresh, if (index >= 0) index else -1, lp ?: FrameLayout.LayoutParams(0, 0))
        views[tabId] = fresh
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
