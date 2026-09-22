package app.zen.chromium

import android.content.Context
import android.content.MutableContextWrapper
import android.graphics.Rect
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
    /** The frame the chrome last laid each page out at (device px), what [place] works from. */
    private val reported = HashMap<String, Rect>()
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
        reported.remove(tabId)
        host.exitFullscreen(view)
        view.backTransition?.abort()
        host.snapshots.forget(tabId)
        (view.parent as? ViewGroup)?.removeView(view)
        return view
    }

    /**
     * Make a page another host [release]d one of ours. Its context is re-pointed at this window
     * (dialogs and pickers the page opens from now on belong here), what a new view takes from
     * its host at creation – the page script and its bridge, the pull-to-refresh mode – is applied
     * for this host, it starts hidden and unplaced like every new view, and the core is told to
     * adopt it as an active tab the way it adopts a popup; the core answers with `view.bind`,
     * which reports the page's URL and title.
     */
    fun adopt(view: TabWebView) {
        val viewId = "handoff_${++popupSeq}"
        (view.context as? MutableContextWrapper)?.baseContext = container.context
        view.host = host
        view.installPageScript()
        view.applyPullToRefreshMode()
        // A page that lived in a custom tab had no extension layer; the browser window's takes it over.
        host.extensions?.attach(view)
        view.applyAutofillProvider()
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
        // The list and the state pushed under the provisional id are not kept under it.
        host.viewBound(viewId, tabId)
        view.tabId = tabId
        views[tabId] = view
        reported.remove(viewId)?.let { reported[tabId] = it }
        // Whatever the popup loaded before the core knew its tab id is reported now: the list
        // first, as at a commit, so the core records it as it handles the `navigated`.
        view.pushHistory(force = true)
        host.viewEvent(tabId, "navigated", view.navState().put("inPage", false))
        if (!view.title.isNullOrEmpty()) host.viewEvent(tabId, "title", json("title" to view.title))
    }

    fun destroy(tabId: String) {
        val view = views.remove(tabId) ?: return
        // A page still on screen as its tab closes (the active tab, closed from the menu) is
        // pictured first: the card an undo brings back shows the page as it was left.
        view.captureThumbnail()
        reported.remove(tabId)
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
        reported.clear()
        host.snapshots.clear()
    }

    /** Tear a view down (already removed from [views]); the chrome is not told. */
    private fun drop(view: TabWebView) {
        if (filled?.tabId == view.tabId) filled = null
        if (fullscreenHeld?.tabId == view.tabId) fullscreenHeld = null
        host.exitFullscreen(view)
        view.backTransition?.abort()
        view.cover.reset()
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
        fresh.setRadius(dead.radiusPx)
        fresh.cover.set(dead.cover.topTarget, dead.cover.bottomTarget, snap = true)
        dead.cover.reset()
        container.addView(fresh, if (index >= 0) index else -1, lp ?: FrameLayout.LayoutParams(0, 0))
        views[tabId] = fresh
        place(fresh)
        return true
    }

    fun setBounds(tabId: String, rect: JSONObject) {
        val view = views[tabId] ?: return
        val d = density
        val x = (rect.num("x") * d).toInt()
        val y = (rect.num("y") * d).toInt()
        val w = (rect.num("width") * d).toInt().coerceAtLeast(0)
        val h = (rect.num("height") * d).toInt().coerceAtLeast(0)
        // A frame that does not fit the container is a stale measurement of a window that is
        // gone (the chrome behind a rotation, BH-32): it would lay the page out cropped until the
        // chrome's next report, which lays it out right. Refused, the last good frame stands.
        if (!PageFrameFit.fits(w, h, container.width, container.height, d)) return
        // Recorded for a view filling the window too ([fillWindow]), and for one held through a
        // fullscreen ([holdFullscreen]): the frame it is put back to.
        reported[tabId] = Rect(x, y, x + w, y + h)
        if (fullscreenHeld?.tabId == tabId) return
        place(view)
    }

    // --- a page's fullscreen -----------------------------------------------------------------------

    /**
     * The tab whose view is held where it was through a page's fullscreen ([holdFullscreen]),
     * with the corners and covers the core asks for meanwhile, to apply at the release.
     */
    private class FullscreenHeld(val tabId: String, var radiusPx: Float?, var coverTop: Float?, var coverBottom: Float?)
    private var fullscreenHeld: FullscreenHeld? = null

    /** The tab whose view is held through a fullscreen right now, or null. */
    val fullscreenHolding: String? get() = fullscreenHeld?.tabId

    /**
     * `tabId`'s page went fullscreen (MOT-32): the engine draws its fullscreen element in the
     * host's own layer over everything, and the view underneath is no part of it (the engine
     * routes the view's size and draws nowhere else while the layer stands), so the frames the
     * core lays it out at meanwhile – the window, for an element in fullscreen
     * (`Window.applyLayout`), the chrome's next inline frame at the exit, a frame the chrome
     * measured behind a rotation – are recorded ([setBounds], [setRadius], [setCover]) and not
     * applied: the view keeps the frame it had, and the page in it is laid out once at the
     * exit, at the frame it comes back to. The hold lasts past the exit until its landing has
     * settled ([releaseFullscreenHold], [Host.onLandingSettled]): a screen that turns back after
     * the exit would lay the page out in the frame it is leaving otherwise (the resize beyond the
     * portrait window of BH-32, and one more at the turn). A hold under way is released first.
     */
    fun holdFullscreen(tabId: String) {
        releaseFullscreenHold()
        if (views[tabId] == null) return
        fullscreenHeld = FullscreenHeld(tabId, null, null, null)
    }

    /**
     * The exit has landed: the held view takes the frame, corners and covers the core last asked
     * for – the same it had, when the window came back to where it was, and nothing moves. A
     * recorded frame that does not fit the container as it stands now was a screen's that is
     * gone (the landscape a video turned to, measured before the turn back, BH-32): it is
     * dropped, the view keeps the frame it held, and the chrome's next report lays it out.
     */
    fun releaseFullscreenHold() {
        val held = fullscreenHeld ?: return
        fullscreenHeld = null
        val view = views[held.tabId] ?: return
        val r = reported[held.tabId]
        if (r != null && !PageFrameFit.fits(r.width(), r.height(), container.width, container.height, density)) {
            reported.remove(held.tabId)
        } else {
            place(view)
        }
        held.radiusPx?.let { if (filled?.tabId != held.tabId) view.setRadius(it) }
        if (held.coverTop != null && held.coverBottom != null && filled?.tabId != held.tabId) {
            view.cover.set(held.coverTop!!, held.coverBottom!!, snap = true)
        }
    }

    /** Where the bar that hides on scroll is, per the chrome's last `chrome.setBarHide`; null: it may not hide. */
    var barHide: BarHideFrame? = null
        private set

    /** A finger is down on a page on screen (its bar-hide gesture has seen the down and no lift). */
    fun touchingPage(): Boolean = views.values.any { it.visibility == View.VISIBLE && it.barHide.touching }

    /** Per frame while the bar moves: only the views on screen are laid out for it; one coming on screen catches up in [setVisible]. */
    fun setBarHide(frame: BarHideFrame?) {
        barHide = frame
        for (view in views.values) if (view.visibility == View.VISIBLE && fullscreenHeld?.tabId != view.tabId) place(view)
    }

    /**
     * Lay `view` out where the chrome put it, adjusted for the bar that hides on scroll
     * ([BarHidePlacement] has the geometry). A view filling the window (picture-in-picture,
     * [fillWindow]) is laid out by nobody else until it is put back: the chrome's frames for it
     * are recorded meanwhile ([setBounds], [setBarHide]) and applied then.
     */
    private fun place(view: TabWebView) {
        val r = reported[view.tabId] ?: return
        val frame = barHide
        // The gesture's knowledge of the bar is not a layout: it stays current, held or not.
        view.barHide.frame = frame
        val p = BarHidePlacement.of(r.top, r.bottom, frame, held = filled?.tabId == view.tabId) ?: return
        view.setBarHideShift(p.shiftPx, p.clipPx)
        val w = r.width()
        val h = p.height
        val lp = (view.layoutParams as? FrameLayout.LayoutParams) ?: FrameLayout.LayoutParams(w, h)
        if (lp.leftMargin == r.left && lp.topMargin == p.top && lp.width == w && lp.height == h) return
        lp.leftMargin = r.left
        lp.topMargin = p.top
        lp.width = w
        lp.height = h
        view.layoutParams = lp
    }

    fun setRadius(tabId: String, radiusCss: Double) {
        val px = (radiusCss * density).toFloat()
        fullscreenHeld?.takeIf { it.tabId == tabId }?.let { it.radiusPx = px; return }
        val held = filled?.takeIf { it.tabId == tabId }
        if (held != null) held.radiusPx = px else views[tabId]?.setRadius(px)
    }

    /** Chrome messages cover these strips (CSS px) of the view's edges; see `ContentCover`. */
    fun setCover(tabId: String, cover: JSONObject) {
        val view = views[tabId] ?: return
        fullscreenHeld?.takeIf { it.tabId == tabId }?.let {
            it.coverTop = cover.num("top").toFloat()
            it.coverBottom = cover.num("bottom").toFloat()
            return
        }
        val held = filled?.takeIf { it.tabId == tabId }
        if (held != null) {
            held.coverTop = cover.num("top").toFloat()
            held.coverBottom = cover.num("bottom").toFloat()
            return
        }
        // A view that is not showing has nothing to animate: it takes the value for when it is.
        view.cover.set(cover.num("top").toFloat(), cover.num("bottom").toFloat(), snap = view.visibility != View.VISIBLE)
    }

    fun setVisible(tabId: String, visible: Boolean) {
        val view = views[tabId] ?: return
        val held = filled?.takeIf { it.tabId == tabId }
        if (held != null) {
            held.visible = visible
            return
        }
        // GONE views neither draw nor receive input; JS keeps running so background audio, like
        // in Zen, carries on until the core unloads the tab.
        val next = if (visible) View.VISIBLE else View.GONE
        if (view.visibility == next) return
        view.visibility = next
        // The bar may have moved while this view was off screen (only views on screen follow it
        // per frame, [setBarHide]): it takes the bar's current frame as it comes on.
        if (visible) place(view)
    }

    fun bringToFront(tabId: String) {
        views[tabId]?.bringToFront()
    }

    // --- picture-in-picture ----------------------------------------------------------------------

    /**
     * The tab whose view fills the window ([fillWindow]), with what it had before, to put back.
     * `bounds` is the layout the view had as it filled, for a view the chrome never laid out; one
     * with a reported frame is put back through [place], which lays it out for the bar that hides
     * on scroll as it stands then.
     */
    private class Filled(val tabId: String, val bounds: FrameLayout.LayoutParams, var visible: Boolean, var radiusPx: Float, var coverTop: Float, var coverBottom: Float)
    private var filled: Filled? = null

    /** The tab whose view fills the window right now, or null. */
    val filling: String? get() = filled?.tabId

    /**
     * The window is (or is about to be) the picture-in-picture one: `tabId`'s view alone fills it
     * – over the chrome, without its corners, its covers, the slide and clip of a bar hiding on
     * scroll, or the bounds the core lays it out at (which keep arriving and are recorded for
     * later, [setBounds]; the bar's frames too, [setBarHide]) – so the small window shows nothing
     * but the page, whose video the core lays over the viewport. `null` puts the view back where
     * the chrome has it by now, laid out for the bar as it stands ([place]). A view that is gone
     * by then is simply not restored.
     */
    fun fillWindow(tabId: String?) {
        val before = filled
        if (before != null) {
            filled = null
            val view = views[before.tabId]
            if (view != null) {
                if (reported.containsKey(before.tabId)) place(view) else view.layoutParams = before.bounds
                view.setRadius(before.radiusPx)
                view.cover.set(before.coverTop, before.coverBottom, snap = true)
                view.visibility = if (before.visible) View.VISIBLE else View.GONE
            }
        }
        if (tabId == null) return
        val view = views[tabId] ?: return
        val lp = (view.layoutParams as? FrameLayout.LayoutParams) ?: FrameLayout.LayoutParams(0, 0)
        filled = Filled(tabId, FrameLayout.LayoutParams(lp), view.visibility == View.VISIBLE, view.radiusPx, view.cover.topTarget, view.cover.bottomTarget)
        view.layoutParams = FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        view.setRadius(0f)
        view.cover.set(0f, 0f, snap = true)
        view.setBarHideShift(0f, 0)
        view.visibility = View.VISIBLE
        view.bringToFront()
    }
}
