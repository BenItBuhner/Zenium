package app.zen.chromium

import android.content.Context
import android.content.MutableContextWrapper
import android.graphics.Rect
import android.os.Trace
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import org.json.JSONObject
import kotlin.math.roundToInt

/**
 * Owns the tab WebViews and places them above the chrome exactly where the core says, in device
 * pixels converted from the chrome's CSS pixels.
 */
class TabHost(private val container: FrameLayout, private val host: PageHost) {
    private val views = HashMap<String, TabWebView>()
    /** The frame the chrome last laid each page out at (device px), what [place] works from. */
    private val reported = HashMap<String, Rect>()
    /**
     * The page-edge band's seat per tab (device px, absent for 0): how far into its frame the
     * band's host has the page's view laid out at rest ([setBandSeat]); [place] takes it off the
     * top of the bar's placement, and the view translates the band's offset less it ([PageSeat]).
     */
    private val seats = HashMap<String, Int>()
    /**
     * The screen a fullscreen's exit is landing on while the bars settle after it ([landingOn]
     * from [Host.exitFullscreen], cleared by [landed]), and the frames held back meanwhile for
     * fitting the container the screen still is but not that screen ([PageFrameFit.judge]).
     */
    private var landingScreen: PageFrameFit.Screen? = null
    private val heldBack = HashMap<String, Rect>()
    /** The tabs whose views have been on screen here at least once ([BackgroundTabRule]'s `shownBefore`). */
    private val shownOnce = HashSet<String>()
    /**
     * The tabs whose last hide the core named a switch away from the page – the tab overview over
     * it (`LayoutReport.switchedAway`, OS-39) – until the view is shown again ([BackgroundTabRule]'s
     * `switched`).
     */
    private val switchedOff = HashSet<String>()
    private var backgroundPassPosted = false
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
        Trace.beginSection("zen:TabHost.create")
        val started = System.nanoTime()
        try {
            // A view already held under this id is an orphan: the core registers its new view before it
            // asks, so a `destroyed` for the id would land on that new view and mark it dead – a tab
            // that never gets bounds again. Drop the old one without a word.
            views.remove(tabId)?.let(::drop)
            val spare = takeSpare(containerId, context)
            val view = spare ?: TabWebView(context, tabId, containerId, host)
            if (spare != null) {
                spare.tabId = tabId
                // Views made since the spare was built sit above it: the new tab's view goes where a
                // fresh one would, on top.
                spare.bringToFront()
            } else {
                show(view, false)
                container.addView(view, FrameLayout.LayoutParams(0, 0))
            }
            readAfterChrome(view)
            host.focusHandoff?.wirePage(view)
            views[tabId] = view
            lastCreateTookSpare = spare != null
            return view
        } finally {
            lastCreateMicros = (System.nanoTime() - started) / 1_000
            Trace.endSection()
        }
    }

    // --- the spare view (W6-S26-b) -----------------------------------------------------------------

    /**
     * Whether the last [create] took the spare view rather than building one (diagnostics, the
     * tab-wake perf demo).
     */
    var lastCreateTookSpare = false
        private set

    /** How long the last [create] held the UI thread, in microseconds (diagnostics, the same demo). */
    var lastCreateMicros = 0L
        private set

    /** How many spare views [warm] has built since this host came up (diagnostics). */
    var sparesBuilt = 0
        private set

    /** Whether a spare view stands ready for the next [create] of its container. */
    val hasSpare: Boolean get() = views.containsKey(SPARE_ID)

    /** The container the standing spare was built for; null with none. */
    val spareContainerId: String? get() = views[SPARE_ID]?.containerId

    /**
     * Whether [warm] builds anything. Off, every wake builds its view inside the morph as it
     * did before the spare – the tab-wake perf demo's before-reading on the same run; the
     * product never turns it off.
     */
    var warmingEnabled = true
        internal set

    /**
     * Build the page view for the next tab the core wakes, ahead of the wake. Constructing a
     * `TabWebView` – its settings, fonts, user agent, darkening, autofill provider, page script,
     * extension bridges, renderer watch – is UI-thread work that otherwise lands inside the first
     * frames of the overview's morph into the tapped card, the moment the user is watching. The
     * host calls this on an idle moment once the pages are covered (the overview, a sheet), never
     * on the boot path, for the container of the page that was covered; [create] takes the view
     * for the first tab of that container and builds as before for any other. One at a time: a
     * spare of another container ([spareContainerId]) is the host's to drop first, on the same
     * idle moment, so the latest hide's container is the one a spare stands for.
     *
     * The spare lives in [views] under [SPARE_ID], hidden and unplaced like any view the core has
     * yet to lay out, so every push the host makes to its pages – fonts, privacy, page rules, an
     * extension installed meanwhile – reaches it the way it reaches a tab's hidden view; nothing
     * reports it to the core, which never asked for the id. It is dropped under memory pressure
     * ([dropSpare]), with its container's profile when that is cleared (a private session's end),
     * and goes with every other view at a teardown.
     */
    fun warm(containerId: String): Boolean {
        if (!warmingEnabled || hasSpare) return false
        Trace.beginSection("zen:TabHost.warm")
        try {
            val view = TabWebView(container.context, SPARE_ID, containerId, host)
            show(view, false)
            container.addView(view, FrameLayout.LayoutParams(0, 0))
            views[SPARE_ID] = view
            sparesBuilt++
            return true
        } finally {
            Trace.endSection()
        }
    }

    /** Tear the spare view down, if one stands (memory pressure, a renderer gone). */
    fun dropSpare(): Boolean {
        val view = views.remove(SPARE_ID) ?: return false
        drop(view)
        return true
    }

    /**
     * The spare, out of [views] and ready to be re-tagged, when it was built for `containerId`
     * in this window (a custom tab's page is made with another context, and keeps building its own).
     */
    private fun takeSpare(containerId: String, context: Context): TabWebView? {
        val view = views[SPARE_ID] ?: return null
        if (view.containerId != containerId || context !== container.context) return null
        views.remove(SPARE_ID)
        return view
    }

    /**
     * Take a live page out of this host without destroying it, so another host can [adopt] it:
     * "Open in Zenium" hands a custom tab's page, history and all, to the browser window.
     */
    fun release(tabId: String): TabWebView? {
        val view = views.remove(tabId) ?: return null
        reported.remove(tabId)
        heldBack.remove(tabId)
        // The band that seated it stood in this window; the host it goes to places it as reported.
        seats.remove(tabId)
        view.setBandSeat(0)
        // Behind no tab of this host's any more: the host it goes to has its own word.
        shownOnce.remove(tabId)
        switchedOff.remove(tabId)
        view.backgroundTab = false
        host.exitFullscreen(view)
        view.backTransition?.abort()
        host.snapshots.forget(tabId)
        host.focusHandoff?.unwire(view)
        (view.parent as? ViewGroup)?.removeView(view)
        return view
    }

    /**
     * Make a page another host [release]d one of ours. Its context is re-pointed at this window
     * (dialogs and pickers the page opens from now on belong here), what a new view takes from
     * its host at creation – the page script and its bridge, the pull-to-refresh mode, the page
     * fonts – is applied for this host, it starts hidden and unplaced like every new view, and
     * the core is told to adopt it as an active tab the way it adopts a popup; the core answers
     * with `view.bind`, which reports the page's URL and title.
     *
     * The fonts: a custom tab lays its page out with the fonts the file held when its process
     * started (`PageFonts.load`), which may trail a Settings change the core has since pushed
     * here (`fonts.apply` reaches the tabs this host holds, and this page was not one of them);
     * `applyFonts` brings the adopted page onto the core's current fonts, restyled in place like
     * every other tab's document (#328's Android note).
     */
    fun adopt(view: TabWebView) {
        val viewId = "handoff_${++popupSeq}"
        (view.context as? MutableContextWrapper)?.baseContext = container.context
        view.host = host
        view.installPageScript()
        view.applyPullToRefreshMode()
        view.applyFonts()
        // A page that lived in a custom tab had no extension layer; the browser window's takes it over.
        host.extensions?.attach(view)
        view.applyAutofillProvider()
        view.tabId = viewId
        // The core's view for the new tab says whether an agent drives it (OS-40) and whether
        // it holds the page's prompts for one (AgentPrompts.kt).
        view.agentDriven = false
        view.setInterceptAgentPrompts(false)
        show(view, false)
        view.translationX = 0f
        container.addView(view, FrameLayout.LayoutParams(0, 0))
        readAfterChrome(view)
        host.focusHandoff?.wirePage(view)
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
        // The tab is the core's from here: its word on an agent driving the page comes with it
        // (OS-40), as does its word on holding the page's prompts for one (AgentPrompts.kt).
        view.agentDriven = false
        view.setInterceptAgentPrompts(false)
        views[tabId] = view
        reported.remove(viewId)?.let { reported[tabId] = it }
        heldBack.remove(viewId)?.let { heldBack[tabId] = it }
        seats.remove(viewId)?.let { seats[tabId] = it }
        if (shownOnce.remove(viewId)) shownOnce.add(tabId)
        if (switchedOff.remove(viewId)) switchedOff.add(tabId)
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
        heldBack.remove(tabId)
        seats.remove(tabId)
        drop(view)
        // The spare was never a tab of the core's: nothing to tell it.
        if (tabId != SPARE_ID) host.viewEvent(tabId, "destroyed", null)
    }

    fun destroyAll() {
        for (id in views.keys.toList()) destroy(id)
    }

    /**
     * Every view, without a word to the chrome: for a chrome whose renderer is gone or whose
     * document is being replaced, and for the host's own teardown (`Host.destroy`), where the
     * core still running in the chrome must not hear a `destroyed` – a page-initiated close, to
     * it – for views that go with their host ([destroyAll] is the custom tab's, which has no core
     * behind it). The core that boots next recreates the tabs from the persisted state, so
     * nothing here must survive under a tab id it will ask for.
     */
    fun dropAll() {
        for (view in views.values.toList()) drop(view)
        views.clear()
        reported.clear()
        heldBack.clear()
        seats.clear()
        shownOnce.clear()
        switchedOff.clear()
        host.snapshots.clear()
    }

    /** Tear a view down (already removed from [views]); the chrome is not told. */
    private fun drop(view: TabWebView) {
        shownOnce.remove(view.tabId)
        switchedOff.remove(view.tabId)
        host.tabRemoved(view)
        // The window's own view going: the fill ends the way every fill ends – the record dropped
        // (the view is out of [views], so nothing is laid back) and the host told, whose reader
        // hold on the chrome lifts with it. A silent drop left the chrome out of a screen
        // reader's tree until the next window or veil (PR #481's review, REQUIRED 1).
        if (filled?.tabId == view.tabId) fillWindow(null)
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
        // A spare that lost its renderer is not worth a second one: the next wake builds its own.
        if (tabId == SPARE_ID) {
            dropSpare()
            return false
        }
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
        show(fresh, visible)
        fresh.setRadius(dead.radiusPx)
        fresh.cover.set(dead.cover.topTarget, dead.cover.bottomTarget, snap = true)
        dead.cover.reset()
        container.addView(fresh, if (index >= 0) index else -1, lp ?: FrameLayout.LayoutParams(0, 0))
        readAfterChrome(fresh)
        host.focusHandoff?.wirePage(fresh)
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
        // One that fits the container but not the screen a fullscreen's exit is landing on is
        // the same measurement caught early, before the system has turned the container: held
        // back until the bars have settled ([landed]).
        val frame = Rect(x, y, x + w, y + h)
        when (PageFrameFit.judge(w, h, container.width, container.height, landingScreen, d)) {
            PageFrameFit.Verdict.REFUSE -> return
            PageFrameFit.Verdict.HOLD -> {
                heldBack[tabId] = frame
                return
            }
            PageFrameFit.Verdict.APPLY -> heldBack.remove(tabId)
        }
        // Recorded for a view filling the window too ([fillWindow]): the frame it is put back to.
        reported[tabId] = frame
        place(view)
    }

    /**
     * A fullscreen's exit is landing on a screen of this size (device px): the frames the chrome
     * reports for another screen meanwhile are held back ([setBounds]) until [landed].
     */
    fun landingOn(screen: PageFrameFit.Screen) {
        landingScreen = screen
    }

    /**
     * The bars have settled after a fullscreen's exit (or a fullscreen begins again): the frames
     * held back for the landing are applied where they fit the container as it stands now – the
     * screen stayed the one they were laid out for – and dropped where they do not.
     */
    fun landed() {
        landingScreen = null
        if (heldBack.isEmpty()) return
        for ((tabId, frame) in heldBack) {
            val view = views[tabId] ?: continue
            if (!PageFrameFit.fits(frame.width(), frame.height(), container.width, container.height, density)) continue
            reported[tabId] = frame
            place(view)
        }
        heldBack.clear()
    }

    /** Where the bar that hides on scroll is, per the chrome's last `chrome.setBarHide`; null: it may not hide. */
    var barHide: BarHideFrame? = null
        private set

    /** A finger is down on a page on screen (its bar-hide gesture has seen the down and no lift). */
    fun touchingPage(): Boolean = views.values.any { it.visibility == View.VISIBLE && it.barHide.touching }

    /** Per frame while the bar moves: only the views on screen are laid out for it; one coming on screen catches up in [setVisible]. */
    fun setBarHide(frame: BarHideFrame?) {
        barHide = frame
        for (view in views.values) if (view.visibility == View.VISIBLE) place(view)
    }

    /**
     * The page-edge band's host seats `tabId`'s page `seatCss` CSS px into its frame (the
     * bridge's `view.setBandSeat`; `lib/band/androidHost.ts`): the view is laid out that much
     * lower and shorter than the bar's placement alone has it ([place], [BarHidePlacement.of]'s
     * `seatPx`) and translates the pull channel's offset less the seat ([TabWebView.setBandSeat],
     * [PageSeat]) – in the one layout pass, so the page stays where it is on screen. 0 places the
     * view as reported again. Recorded for a view filling the window too ([fillWindow]), which
     * takes it when it is put back, and for a view the chrome has yet to lay out, which takes it
     * with its first frame.
     */
    fun setBandSeat(tabId: String, seatCss: Double) {
        val px = (seatCss * density).toFloat().roundToInt().coerceAtLeast(0)
        val before = if (px == 0) seats.remove(tabId) ?: 0 else seats.put(tabId, px) ?: 0
        if (before == px) return
        val view = views[tabId] ?: return
        place(view)
    }

    /** The frame the chrome last laid `tabId`'s page out at (device px), or null (diagnostics, the band demo). */
    fun reportedFrameOf(tabId: String): Rect? = reported[tabId]?.let { Rect(it) }

    /**
     * Lay `view` out where the chrome put it, adjusted for the bar that hides on scroll
     * ([BarHidePlacement] has the geometry) and seated under a standing page-edge band
     * ([setBandSeat]). A view filling the window (picture-in-picture, [fillWindow]) is laid out
     * by nobody else until it is put back: the chrome's frames for it are recorded meanwhile
     * ([setBounds], [setBarHide], [setBandSeat]) and applied then.
     */
    private fun place(view: TabWebView) {
        val r = reported[view.tabId] ?: return
        val frame = barHide
        // The gesture's knowledge of the bar is not a layout: it stays current, held or not.
        view.barHide.frame = frame
        val seat = seats[view.tabId] ?: 0
        val p = BarHidePlacement.of(r.top, r.bottom, frame, held = filled?.tabId == view.tabId, seatPx = seat) ?: return
        view.setBarHideShift(p.shiftPx, p.clipPx)
        // The layout params and the translation change in this one pass: the view's top on
        // screen – the band's offset – is the same before and after, whatever frame falls between.
        view.setBandSeat(seat)
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
        val held = filled?.takeIf { it.tabId == tabId }
        if (held != null) held.radiusPx = px else views[tabId]?.setRadius(px)
    }

    /** Chrome messages cover these strips (CSS px) of the view's edges; see `ContentCover`. */
    fun setCover(tabId: String, cover: JSONObject) {
        val view = views[tabId] ?: return
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
        // Shown again: whatever switch its last hide was is over ([switched]).
        if (visible) switchedOff.remove(tabId)
        // A tab brought in front is the user's again, sheet and all (§9.23): the agent's word
        // on driving it hidden ends with the show, whoever asked for the show.
        if (visible) view.agentDriven = false
        val held = filled?.takeIf { it.tabId == tabId }
        if (held != null) {
            held.visible = visible
            return
        }
        // GONE views neither draw nor receive input; JS keeps running so background audio, like
        // in Zen, carries on until the core unloads the tab.
        val next = if (visible) View.VISIBLE else View.GONE
        if (view.visibility == next) {
            // A hide asked and waited for ([hideRequested]) that a show overtook: the view stayed
            // on screen and is read again.
            if (visible) readable(view, true)
            return
        }
        show(view, visible)
        // The bar may have moved while this view was off screen (only views on screen follow it
        // per frame, [setBarHide]): it takes the bar's current frame as it comes on.
        if (visible) place(view)
    }

    /**
     * The core's reason for the hide of `tabId` on its way ([Host.setTabVisible]): `switched` for
     * the tab overview over the page – a switch away from it, as the core's `LayoutReport.switchedAway`
     * has it – and false for a sheet or a field over it. Recorded ahead of the hide, which waits
     * for the chrome's frame and posts the pass that reads it ([show]). A word that changes for a
     * view gone already – the overview opened over the stage that had hidden the page, and the
     * core sends the hide again for the reason alone – posts the pass itself: the screen is as it
     * was, the reason is not, and the page under the overview hears it is behind.
     */
    fun switched(tabId: String, switched: Boolean) {
        val changed = if (switched) switchedOff.add(tabId) else switchedOff.remove(tabId)
        val view = views[tabId] ?: return
        if (changed && view.visibility != View.VISIBLE && tabId in shownOnce) postBackgroundPass()
    }

    /**
     * The core asked `tabId` hidden and the hide waits for the chrome's frame ([Host.setTabVisible],
     * [PageVisibility]): the page is out of a screen reader's tree from now, not from that frame
     * – what covers it (a sheet's scrim, the overview's cover) is already up in the chrome's own
     * tree (A11Y-03). A view filling the picture-in-picture window is covered by nothing.
     */
    fun hideRequested(tabId: String) {
        val view = views[tabId] ?: return
        if (filled?.tabId == tabId) return
        readable(view, false)
    }

    /**
     * `visible` on screen or gone, and read by a screen reader or not with it: a page view that
     * is not showing is `IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS`, so neither it nor its
     * document is in the tree TalkBack explores – a GONE view is left out of the tree anyway,
     * and the flag makes the rule hold whichever way the view went (a hide asked and still
     * waiting for the chrome's frame, [hideRequested], is the case the visibility alone misses).
     * A reader that asks for the unimportant views too (`FLAG_INCLUDE_NOT_IMPORTANT_VIEWS`: the
     * harness's UiAutomation) is handed the view as it is handed every view; TalkBack asks for
     * the important ones, and the harness's layers scene reads as TalkBack does. One coming back
     * reads as any view does (A11Y-03).
     */
    private fun show(view: TabWebView, visible: Boolean) {
        view.visibility = if (visible) View.VISIBLE else View.GONE
        readable(view, visible)
        // What is on screen changed for the tabs that have been on it: a view coming on, or one
        // that has been on going off. A fresh view's first GONE ([create]) posts nothing; the
        // first show (the boot's restored tab, a new tab) posts one trivial O(N) pass that finds
        // nobody behind and writes no change.
        if (visible) shownOnce.add(view.tabId)
        if (view.tabId in shownOnce) postBackgroundPass()
    }

    /**
     * Page visibility on a tab switch (OS-39): once the frame's changes to what is on screen are
     * in – posted, so the hides one frame brings together (a tablet split's two, under a cover)
     * are read as one and the engine's word goes out from no layout call – every view hears
     * whether its tab is behind another tab on screen ([BackgroundTabRule.behind]), and one that
     * is forwards the hide to the engine the way the window's reaches it ([TabWebView.backgroundTab]):
     * its page is hidden, as Chrome's switched-away tab is, and shown again with the view. The
     * core's relayout hides a view the same way for a switch and for the chrome's covers, so the
     * rule tells them apart by whether some tab is on the screen, and by the core's word on the
     * one cover that is a switch, the tab overview ([switched]); the hide waits for the chrome's
     * frame ([Host.setTabVisible]) and the card picture is taken before it, so neither is touched.
     */
    private fun postBackgroundPass() {
        if (backgroundPassPosted) return
        backgroundPassPosted = true
        container.post {
            backgroundPassPosted = false
            val behind = BackgroundTabRule.behind(views.values.map {
                BackgroundTabRule.Tab(it.tabId, it.visibility == View.VISIBLE, it.tabId in shownOnce, it.backgroundTab, it.tabId in switchedOff)
            })
            for (view in views.values) view.backgroundTab = view.tabId in behind
        }
    }

    private fun readable(view: TabWebView, readable: Boolean) {
        view.importantForAccessibility = if (readable) View.IMPORTANT_FOR_ACCESSIBILITY_AUTO else View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
    }

    /**
     * A screen reader takes the chrome before the page: the view is traversed after the chrome
     * WebView (`R.id.zen_chrome`; the [PageHost.underlay]) – the bar and what the chrome has up
     * first, the page's document after (A11Y-03). Whether the hint reaches the reader is this
     * WebView's to say: Chromium builds the node for a WebView's own view itself
     * (`WebContentsAccessibilityImpl.createNodeForHost`) and copies what it copies; the framework
     * lists the root's children top-to-bottom, tallest first among equals, which puts the chrome
     * – the window's full height under the pages – ahead of every page view regardless. The
     * harness reads both (`ChromeA11yDemo`, the layers scene). A host without a chrome (a custom
     * tab) has nothing to read after.
     */
    private fun readAfterChrome(view: TabWebView) {
        val chrome = host.underlay ?: return
        if (chrome.id != View.NO_ID) view.accessibilityTraversalAfter = chrome.id
    }

    fun bringToFront(tabId: String) {
        views[tabId]?.bringToFront()
    }

    /**
     * Where `tabId`'s view stands on screen right now – laid out, with the slide a pull or a
     * hiding bar has it on – in the container's device px; null for a view not showing or not
     * laid out yet. What the fullscreen layer's reveal starts from ([FullscreenReveal]). Only
     * `translationY` is folded in: a tab's view is slid on Y alone (the pull, the hiding bar) and
     * never translated on X or scaled – a transform added there would need adding here.
     */
    fun frameOf(tabId: String): Rect? {
        val view = views[tabId] ?: return null
        if (view.visibility != View.VISIBLE || view.width == 0 || view.height == 0) return null
        val dy = view.translationY.toInt()
        return Rect(view.left, view.top + dy, view.right, view.bottom + dy)
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
     * scroll, a band's seat, or the bounds the core lays it out at (which keep arriving and are
     * recorded for later, [setBounds]; the bar's frames and the seat too, [setBarHide],
     * [setBandSeat]) – so the small window shows nothing
     * but the page, whose video the core lays over the viewport. `null` puts the view back where
     * the chrome has it by now, laid out for the bar as it stands ([place]). A view that is gone
     * by then is simply not restored. The host hears each change ([PageHost.windowFillChanged]):
     * the chrome under a filling view is covered, and a screen reader is not to find its bar there.
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
                show(view, before.visible)
            }
        }
        val view = tabId?.let { views[it] }
        if (view != null) {
            val lp = (view.layoutParams as? FrameLayout.LayoutParams) ?: FrameLayout.LayoutParams(0, 0)
            filled = Filled(view.tabId, FrameLayout.LayoutParams(lp), view.visibility == View.VISIBLE, view.radiusPx, view.cover.topTarget, view.cover.bottomTarget)
            view.layoutParams = FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
            view.setRadius(0f)
            view.cover.set(0f, 0f, snap = true)
            view.setBarHideShift(0f, 0)
            view.setBandSeat(0)
            show(view, true)
            view.bringToFront()
        }
        if (before != null || filled != null) host.windowFillChanged(filled?.tabId)
    }

    companion object {
        /** The id the spare view is held under in [views] – never a tab id of the core's (those are `tab_…` and the popup / handoff ids). */
        const val SPARE_ID = "spare"
    }
}
