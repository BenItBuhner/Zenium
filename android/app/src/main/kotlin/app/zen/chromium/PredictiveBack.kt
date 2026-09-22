package app.zen.chromium

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.LinearGradient
import android.graphics.Outline
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Shader
import android.graphics.Typeface
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.text.TextPaint
import android.text.TextUtils
import android.util.Log
import android.view.Choreographer
import android.view.View
import android.view.ViewGroup
import android.view.ViewOutlineProvider
import android.webkit.WebHistoryItem
import android.widget.FrameLayout
import android.window.BackEvent
import android.window.OnBackAnimationCallback
import android.window.OnBackInvokedDispatcher
import androidx.activity.OnBackPressedCallback
import androidx.annotation.RequiresApi
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.exp
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * The system back gesture, predictively.
 *
 * On API 34+ an [OnBackAnimationCallback] follows the finger: `start`, a stream of `progress`
 * values, then `commit` or `cancel`. Below that a plain [OnBackPressedCallback] gets the one
 * event there is. Either way the target is decided when the gesture begins, in this order:
 *
 *  1. HTML fullscreen (a video) leaves fullscreen;
 *  2. a chrome surface – three-dot menu, URL bar, tab overview, a panel, the drawer – is handed
 *     the gesture over the bridge (`__zenHost.backEvent`) and animates its own dismissal; the
 *     chrome says whether it has one through `back.update`;
 *  3. Zenium's own fullscreen (Menu > Fullscreen, the system bars hidden) is left;
 *  4. the page WebView can go back: [PageBackTransition] slides the live page out over a snapshot
 *     of the previous history entry, natively, and only navigates once the slide has committed;
 *  5. the tab is at its first page and the chrome has a back for that (`root` in `back.update`:
 *     a child tab closes back to its opener, a page gives way to a new tab, …): the commit goes
 *     to the chrome, which says whether the app should leave after all (a tab another app opened
 *     closes and hands the user back to it);
 *  6. nothing – then no callback is registered at all, so the system's own back-to-home
 *     animation runs untouched (before API 33 the callback stays and backgrounds the task, as the
 *     system would otherwise finish the activity).
 *
 * Registration follows the target: [refresh] re-decides it whenever the chrome's surfaces, the
 * active tab, its history or fullscreen change, except while a gesture is in flight.
 *
 * A custom tab has no chrome (`chrome` answers null) and never leaves back to the system: with
 * `alwaysHandle` the callback stays registered and a back with nothing left to pop runs `onLeave`,
 * which closes the tab to the app that opened it with that app's exit animation. Its one native
 * surface (the find bar) is announced through `update(chrome = true)` and dismissed by
 * `dismissOverlay` when the back commits.
 */
class PredictiveBack(
    private val activity: BrowserActivity,
    private val host: PageHost,
    private val chrome: () -> ChromeWebView?,
    private val onLeave: () -> Unit,
    private val alwaysHandle: Boolean = false,
    private val dismissOverlay: () -> Boolean = { false }
) {
    enum class Target { NONE, FULLSCREEN, CHROME, PAGE, ROOT }

    private var chromeHandles = false
    private var rootHandles = false
    private var pageTabId: String? = null
    private var target = Target.NONE
    private var inFlight = false
    private var page: PageBackTransition? = null
    private var registered = false
    private var animated: AnimatedCallback? = null

    /** Whether the chrome currently has a surface a back would dismiss (instrumentation reads this). */
    val chromeSurfaceUp: Boolean get() = chromeHandles

    /** Below API 34 there is no gesture progress: back is one event, handled when it fires. */
    private val plain = object : OnBackPressedCallback(false) {
        override fun handleOnBackPressed() = commit()
    }

    @RequiresApi(Build.VERSION_CODES.UPSIDE_DOWN_CAKE)
    private inner class AnimatedCallback : OnBackAnimationCallback {
        override fun onBackStarted(backEvent: BackEvent) =
            start(if (backEvent.swipeEdge == BackEvent.EDGE_RIGHT) EDGE_RIGHT else EDGE_LEFT)

        override fun onBackProgressed(backEvent: BackEvent) = progress(backEvent.progress)
        override fun onBackInvoked() = commit()
        override fun onBackCancelled() = cancel()
    }

    init {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            activity.onBackPressedDispatcher.addCallback(activity, plain)
        }
        refresh()
    }

    /**
     * The chrome's view of things: does it have a surface to dismiss, which tab is active, and
     * does it have a back for that tab's first page (a host without a chrome has none).
     */
    fun update(chrome: Boolean, tabId: String?, root: Boolean = false) {
        Log.v(TAG, "chrome: surface=$chrome tab=$tabId root=$root")
        chromeHandles = chrome
        rootHandles = root
        pageTabId = tabId
        refresh()
    }

    /** Re-decide whether the app handles the next back at all. Deferred while a gesture is in flight. */
    fun refresh() {
        if (inFlight) return
        val next = currentTarget()
        val enabled = next != Target.NONE || alwaysHandle || Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU
        if (enabled != registered) Log.d(TAG, "back would $next (chrome=$chromeHandles tab=$pageTabId): callback ${if (enabled) "on" else "off"}")
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            setRegistered(enabled)
        } else {
            plain.isEnabled = enabled
            registered = enabled
        }
    }

    /** A page transition finished (or was torn down): the page's history may look different now. */
    fun onPageTransitionEnded(transition: PageBackTransition) {
        if (page === transition) page = null
        refresh()
    }

    private fun currentTarget(): Target = decideTarget(
        fullscreen = host.fullscreenTab != null,
        chrome = chromeHandles,
        immersive = host.immersive,
        pageCanGoBack = pageTab()?.canGoBack() == true,
        root = rootHandles
    )

    private fun pageTab(): TabWebView? = pageTabId?.let { host.tabs.get(it) }

    @RequiresApi(Build.VERSION_CODES.UPSIDE_DOWN_CAKE)
    private fun setRegistered(enabled: Boolean) {
        if (enabled == registered) return
        registered = enabled
        val callback = animated ?: AnimatedCallback().also { animated = it }
        val dispatcher = activity.onBackInvokedDispatcher
        if (enabled) dispatcher.registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT, callback)
        else dispatcher.unregisterOnBackInvokedCallback(callback)
    }

    private fun start(edge: Int) {
        if (inFlight) cancel()
        target = currentTarget()
        inFlight = true
        Log.d(TAG, "gesture from the ${edgeName(edge)} edge: $target")
        when (target) {
            Target.CHROME -> chrome()?.backEvent("start", json("edge" to edgeName(edge)))
            Target.PAGE -> page = pageTab()?.let { tab -> PageBackTransition.begin(tab, host, edge) }
            Target.FULLSCREEN, Target.ROOT, Target.NONE -> Unit
        }
    }

    private fun progress(fraction: Float) {
        if (!inFlight) return
        when (target) {
            Target.CHROME -> chrome()?.backEvent("progress", json("progress" to fraction.toDouble()))
            Target.PAGE -> page?.progress(fraction)
            Target.FULLSCREEN, Target.ROOT, Target.NONE -> Unit
        }
    }

    private fun commit() {
        // A back button (or a host without progress) commits without ever having started.
        val decided = if (inFlight) target else currentTarget()
        Log.d(TAG, "commit: $decided")
        inFlight = false
        target = Target.NONE
        when (decided) {
            Target.FULLSCREEN -> {
                val tab = host.fullscreenTab
                if (tab != null) host.exitFullscreen(tab) else host.leaveImmersive()
            }
            // The chrome answers whether it did something; a "no" at a tab's first page is its
            // decision that the app should leave (the last tab, a tab another app opened).
            Target.CHROME, Target.ROOT -> {
                val view = chrome()
                if (view != null) view.backCommit { handled -> if (!handled) nothingLeft() }
                else if (!dismissOverlay()) nothingLeft()
            }
            Target.PAGE -> {
                val transition = page
                page = null
                if (transition != null) transition.commit() else nothingLeft()
            }
            Target.NONE -> nothingLeft()
        }
        refresh()
    }

    private fun cancel() {
        if (!inFlight) return
        Log.d(TAG, "cancel: $target")
        inFlight = false
        when (target) {
            Target.CHROME -> chrome()?.backEvent("cancel", null)
            Target.PAGE -> {
                page?.cancel()
                page = null
            }
            Target.FULLSCREEN, Target.ROOT, Target.NONE -> Unit
        }
        target = Target.NONE
        refresh()
    }

    /** No surface took the back: navigate the page plainly if it can, else leave like Chrome does. */
    private fun nothingLeft() {
        val tab = pageTab()
        if (tab != null && tab.canGoBack()) tab.goBack() else onLeave()
    }

    companion object {
        private const val TAG = "ZenBack"
        const val EDGE_LEFT = 0
        const val EDGE_RIGHT = 1

        fun edgeName(edge: Int): String = if (edge == EDGE_RIGHT) "right" else "left"

        /**
         * What the next back does, in the order the class comment gives: a page's fullscreen ends
         * first, a chrome surface closes next, then the app's own fullscreen is left, the page goes
         * back while it can, then the chrome's back at the tab's first page, and only with none of
         * these does the system take over.
         */
        fun decideTarget(fullscreen: Boolean, chrome: Boolean, immersive: Boolean, pageCanGoBack: Boolean, root: Boolean): Target = when {
            fullscreen -> Target.FULLSCREEN
            chrome -> Target.CHROME
            immersive -> Target.FULLSCREEN
            pageCanGoBack -> Target.PAGE
            root -> Target.ROOT
            else -> Target.NONE
        }
    }
}

/**
 * In-page predictive back, Chrome style, done with native views because the page is one: the
 * live WebView slides towards the edge the swipe came from, revealing a [BackPreviewView] that
 * sits directly beneath it in the same bounds and shows the previous history entry – its
 * snapshot from [HistorySnapshots] when there is one, otherwise a neutral page with the site's
 * favicon and title – arriving with a little parallax under a thinning scrim.
 *
 * Commit springs the page the rest of the way out, *then* calls `goBack()`, so the outgoing
 * page never shows the incoming document mid-slide; the preview stays on screen until the new
 * page has painted (commit-visible plus a settle, page finished, or a same-document history
 * update, whichever comes first, with a hard timeout), and only then does the WebView snap back
 * into place over it, so nothing flashes. Cancel springs everything back to where it was; a
 * gesture that starts during that spring catches it.
 */
class PageBackTransition private constructor(
    private val tab: TabWebView,
    private val host: PageHost,
    edge: Int,
    entry: HistorySnapshots.Entry?,
    item: WebHistoryItem
) {
    enum class NavigationEvent { STARTED, COMMIT_VISIBLE, FINISHED, HISTORY_UPDATED }

    private val parent = tab.parent as ViewGroup
    private val preview = BackPreviewView(tab.context)
    private val width = tab.width.toFloat()
    private val direction = if (edge == PredictiveBack.EDGE_RIGHT) -1f else 1f
    private val main = Handler(Looper.getMainLooper())
    private val spring = Spring(SPRING_STIFFNESS, SPRING_DAMPING, ::onSpringFrame, ::onSpringRest)

    /** Where the page is, in px along the swipe (0 = in place, `width` = fully out). */
    private var position = 0f
    private var fingerPosition = 0f
    private var springPosition = 0f
    private var velocity = 0f
    private var lastProgressAt = 0L
    private var finishing = false
    private var caught = false
    private var awaitingPaint = false
    private var sawStart = false
    private var done = false
    private var revealAt = 0L
    private val reveal = Runnable { reveal() }

    init {
        preview.setContent(
            bitmap = entry?.bitmap,
            title = entry?.title?.ifEmpty { null } ?: item.title ?: "",
            subtitle = hostOf(item.url),
            favicon = entry?.favicon ?: item.favicon,
            dark = host.themeDark,
            scrim = host.themeScrim
        )
        preview.radius = tab.radiusPx
        val lp = tab.layoutParams as? FrameLayout.LayoutParams
        val bounds = FrameLayout.LayoutParams(lp?.width ?: tab.width, lp?.height ?: tab.height).apply {
            leftMargin = lp?.leftMargin ?: tab.left
            topMargin = lp?.topMargin ?: tab.top
        }
        parent.addView(preview, parent.indexOfChild(tab), bounds)
        tab.backTransition = this
        applyPosition(0f)
    }

    /** The finger moved; `fraction` is the system's 0…1 back progress. */
    fun progress(fraction: Float) {
        if (done || finishing) return
        val now = SystemClock.uptimeMillis()
        val next = fraction.coerceIn(0f, 1f) * width
        if (lastProgressAt != 0L) {
            val dt = (now - lastProgressAt) / 1000f
            if (dt > 0f) velocity = (next - fingerPosition) / dt
        }
        lastProgressAt = now
        fingerPosition = next
        // Caught mid spring-back: the spring keeps easing home and the finger takes over once it
        // is past it, so the page never jumps to where a fresh gesture starts.
        applyPosition(if (caught && spring.running) max(springPosition, next) else next)
    }

    /** Let go past the threshold: slide the rest of the way out, then navigate. */
    fun commit() {
        if (done) return
        spring.stop()
        caught = false
        finishing = true
        val fling = if (SystemClock.uptimeMillis() - lastProgressAt > VELOCITY_MEMORY_MS) 0f else velocity
        spring.animate(position, max(fling, MIN_COMMIT_VELOCITY), width)
    }

    /** Let go early: spring back into place. */
    fun cancel() {
        if (done || finishing) return
        spring.stop()
        caught = false
        val fling = if (SystemClock.uptimeMillis() - lastProgressAt > VELOCITY_MEMORY_MS) 0f else velocity
        spring.animate(position, min(fling, 0f), 0f)
    }

    /** A new gesture began while the cancel spring was still running. */
    private fun catchUp() {
        caught = true
        lastProgressAt = 0L
        fingerPosition = 0f
    }

    /** Navigation callbacks of the tab, while the preview covers for the loading page. */
    fun onNavigation(event: NavigationEvent) {
        if (!awaitingPaint) return
        when (event) {
            NavigationEvent.STARTED -> sawStart = true
            // Same-document history (no load at all): painted within a frame.
            NavigationEvent.HISTORY_UPDATED -> if (!sawStart) scheduleReveal(FRAME_MS)
            NavigationEvent.COMMIT_VISIBLE -> scheduleReveal(COMMIT_SETTLE_MS)
            NavigationEvent.FINISHED -> scheduleReveal(0)
        }
    }

    /** The tab is going away (closed, renderer replaced): drop everything at once. */
    fun abort() {
        teardown()
    }

    private fun onSpringFrame(x: Float) {
        springPosition = x
        applyPosition(if (caught) max(x, fingerPosition) else x)
    }

    private fun onSpringRest(x: Float) {
        if (finishing) navigateBack()
        else if (!caught) teardown()
    }

    private fun applyPosition(px: Float) {
        position = px.coerceIn(0f, width)
        tab.translationX = direction * position
        preview.update(position / width, direction)
    }

    private fun navigateBack() {
        if (done) return
        if (!tab.canGoBack() || !tab.isAttachedToWindow) {
            teardown()
            return
        }
        awaitingPaint = true
        sawStart = false
        tab.goBack()
        scheduleReveal(REVEAL_TIMEOUT_MS)
    }

    /** Reveal in `delayMs` unless something sooner is already scheduled. */
    private fun scheduleReveal(delayMs: Long) {
        val at = SystemClock.uptimeMillis() + delayMs
        if (revealAt != 0L && at >= revealAt) return
        revealAt = at
        main.removeCallbacks(reveal)
        main.postDelayed(reveal, delayMs)
    }

    private fun reveal() {
        if (done) return
        teardown()
    }

    private fun teardown() {
        if (done) return
        done = true
        spring.stop()
        main.removeCallbacks(reveal)
        tab.translationX = 0f
        (preview.parent as? ViewGroup)?.removeView(preview)
        if (tab.backTransition === this) tab.backTransition = null
        host.onPageTransitionEnded(this)
    }

    companion object {
        private const val TAG = "ZenBack"
        private const val SPRING_STIFFNESS = 420f
        private const val SPRING_DAMPING = 40f
        /** Even a slow release slides out at a pace that reads as a decision. */
        private const val MIN_COMMIT_VELOCITY = 900f
        private const val VELOCITY_MEMORY_MS = 120L
        private const val FRAME_MS = 17L
        /** After commit-visible the new document exists; give it a moment to lay out and paint. */
        private const val COMMIT_SETTLE_MS = 250L
        /** Never hold the preview past this – a page that will not paint is the page's problem. */
        private const val REVEAL_TIMEOUT_MS = 1500L

        /**
         * Start the transition for `tab`, or return null when it cannot be shown (page hidden,
         * no history, another transition finishing – the commit then navigates plainly). A gesture
         * that lands while a cancel is still springing back catches that transition instead.
         */
        fun begin(tab: TabWebView, host: PageHost, edge: Int): PageBackTransition? {
            tab.backTransition?.let { running ->
                if (running.finishing || running.done) return null
                running.catchUp()
                return running
            }
            if (!tab.isShown || tab.width <= 0 || tab.parent !is ViewGroup) return null
            val history = tab.copyBackForwardList()
            // The entry back lands on (not always the one behind: see TabWebView.backIndex).
            val index = tab.backIndex(history)
            if (index < 0) return null
            val item = history.getItemAtIndex(index) ?: return null
            val entry = host.snapshots.get(tab.tabId, index, item.url)
            Log.d(TAG, "preview of ${item.url}: ${if (entry == null) "placeholder" else "snapshot"}, scrim #${"%08x".format(host.themeScrim)}")
            // The page being left becomes the forward entry: remember it while it is still whole.
            tab.rememberCurrentPage(force = true)
            return PageBackTransition(tab, host, edge, entry, item)
        }

        private fun hostOf(url: String?): String =
            runCatching { Uri.parse(url ?: "").host ?: "" }.getOrDefault("").removePrefix("www.")
    }
}

/**
 * The page that appears under the one sliding away during an in-page back: its snapshot, scaled
 * to the view's width and top-aligned like the chrome's thumbnails, or a quiet placeholder page
 * carrying the site's favicon and title. Draws the parallax, the scrim that lifts as the page
 * arrives – the chrome's own `--zen-scrim`, so the dim carries the space's tint like every sheet
 * in the chrome – and the shadow the departing page casts on it; clipped to the tab's corners.
 */
class BackPreviewView(context: Context) : View(context) {
    private var bitmap: Bitmap? = null
    private var favicon: Bitmap? = null
    private var title = ""
    private var subtitle = ""
    private var dark = false
    private var scrim = 0
    private var fraction = 0f
    private var direction = 1f
    private val density = resources.displayMetrics.density
    private val bitmapPaint = Paint(Paint.FILTER_BITMAP_FLAG or Paint.ANTI_ALIAS_FLAG)
    private val titlePaint = TextPaint(Paint.ANTI_ALIAS_FLAG).apply {
        typeface = Typeface.DEFAULT_BOLD
        textSize = 15f * density
        textAlign = Paint.Align.CENTER
    }
    private val subtitlePaint = TextPaint(Paint.ANTI_ALIAS_FLAG).apply {
        textSize = 12f * density
        textAlign = Paint.Align.CENTER
    }
    private val shadowPaint = Paint()
    private var shadowFor = 0f
    private val dst = RectF()

    var radius = 0f
        set(value) {
            field = value
            invalidateOutline()
        }

    init {
        clipToOutline = true
        outlineProvider = object : ViewOutlineProvider() {
            override fun getOutline(view: View, outline: Outline) {
                outline.setRoundRect(0, 0, view.width, view.height, radius)
            }
        }
    }

    /** `scrim` is the chrome's scrim token as ARGB; its alpha is the dim over a fully covered page. */
    fun setContent(bitmap: Bitmap?, title: String, subtitle: String, favicon: Bitmap?, dark: Boolean, scrim: Int) {
        this.bitmap = bitmap
        this.title = title
        this.subtitle = subtitle
        this.favicon = favicon
        this.dark = dark
        this.scrim = scrim
        invalidate()
    }

    /** `fraction` of the page's travel that has happened (0…1); `direction` +1 = page moving right. */
    fun update(fraction: Float, direction: Float) {
        this.fraction = fraction
        this.direction = direction
        invalidate()
    }

    override fun onDraw(canvas: Canvas) {
        val w = width.toFloat()
        val h = height.toFloat()
        if (w <= 0f || h <= 0f) return
        canvas.drawColor(if (dark) BACKGROUND_DARK else BACKGROUND_LIGHT)
        val image = bitmap
        if (image != null && !image.isRecycled) {
            // The incoming page starts a quarter of the way over and settles as the outgoing one leaves.
            canvas.save()
            canvas.translate(-direction * (1f - fraction) * PARALLAX * w, 0f)
            val scale = w / image.width
            dst.set(0f, 0f, w, image.height * scale)
            canvas.drawBitmap(image, null, dst, bitmapPaint)
            canvas.restore()
        } else {
            drawPlaceholder(canvas, w, h)
        }
        // The scrim lifts as the page arrives: the token's alpha at the start, none at the end.
        val alpha = (Color.alpha(scrim) * (1f - fraction)).toInt()
        if (alpha > 0) canvas.drawColor(Color.argb(alpha, Color.red(scrim), Color.green(scrim), Color.blue(scrim)))
        drawEdgeShadow(canvas, w, h)
    }

    /**
     * The quiet page that stands in for a missing snapshot: the site's favicon, title and host,
     * centred in the strip the gesture has revealed so far (and in the page once it is all there),
     * so the identity of where back leads is readable at any point of the swipe.
     */
    private fun drawPlaceholder(canvas: Canvas, w: Float, h: Float) {
        val fg = if (dark) FOREGROUND_DARK else FOREGROUND_LIGHT
        titlePaint.color = fg
        subtitlePaint.color = fg and 0x00FFFFFF or (0x99 shl 24)
        val revealed = fraction * w
        val minHalf = 72f * density
        val cx = if (direction > 0f) min(w / 2f, max(revealed / 2f, minHalf)) else max(w / 2f, w - max(revealed / 2f, minHalf))
        val maxWidth = max(120f * density, 2f * min(cx, w - cx) - 24f * density)
        val icon = favicon
        val iconSize = 36f * density
        val gap = 12f * density
        val hasSubtitle = subtitle.isNotEmpty()
        val textHeight = titlePaint.textSize * 1.3f + (if (hasSubtitle) subtitlePaint.textSize * 1.4f else 0f)
        val total = (if (icon != null) iconSize + gap else 0f) + textHeight
        var y = (h - total) / 2f
        if (icon != null && !icon.isRecycled) {
            dst.set(cx - iconSize / 2f, y, cx + iconSize / 2f, y + iconSize)
            canvas.drawBitmap(icon, null, dst, bitmapPaint)
            y += iconSize + gap
        }
        val shownTitle = TextUtils.ellipsize(title.ifEmpty { subtitle }, titlePaint, maxWidth, TextUtils.TruncateAt.END)
        y += titlePaint.textSize
        canvas.drawText(shownTitle, 0, shownTitle.length, cx, y, titlePaint)
        if (hasSubtitle && title.isNotEmpty()) {
            val shownHost = TextUtils.ellipsize(subtitle, subtitlePaint, maxWidth, TextUtils.TruncateAt.END)
            y += subtitlePaint.textSize * 1.5f
            canvas.drawText(shownHost, 0, shownHost.length, cx, y, subtitlePaint)
        }
    }

    /** A soft shadow on this page along the edge of the one sliding over it. */
    private fun drawEdgeShadow(canvas: Canvas, w: Float, h: Float) {
        val travel = fraction * w
        if (travel <= 0f || travel >= w) return
        val size = SHADOW_WIDTH * density
        // Page moving right leaves its edge at `travel` from the left; moving left, from the right.
        val edge = if (direction > 0f) travel else w - travel
        val inner = if (direction > 0f) edge - size else edge + size
        if (shadowFor != edge) {
            shadowFor = edge
            shadowPaint.shader = LinearGradient(edge, 0f, inner, 0f, SHADOW_COLOR, Color.TRANSPARENT, Shader.TileMode.CLAMP)
        }
        canvas.drawRect(min(edge, inner), 0f, max(edge, inner), h, shadowPaint)
    }

    companion object {
        private const val PARALLAX = 0.25f
        private const val SHADOW_WIDTH = 28f
        private const val SHADOW_COLOR = 0x33000000
        private const val BACKGROUND_LIGHT = 0xFFF2F1F5.toInt()
        private const val BACKGROUND_DARK = 0xFF1C1C22.toInt()
        private const val FOREGROUND_LIGHT = 0xFF1E1E24.toInt()
        private const val FOREGROUND_DARK = 0xFFECECF1.toInt()
    }
}

/**
 * A damped spring on the Choreographer, the closed-form solution of the oscillator like the
 * chrome's `spring.ts`, so a page sliding out natively and a sheet sliding out in the chrome move
 * alike. `stop()` leaves the state where it was; the next `animate()` can start from there.
 */
class Spring(
    private val stiffness: Float,
    private val damping: Float,
    private val onFrame: (Float) -> Unit,
    private val onRest: (Float) -> Unit
) {
    private var x = 0f
    private var v = 0f
    private var target = 0f
    private var lastNanos = 0L
    // The thread's Choreographer, taken at the first frame asked for (the main thread's, where
    // a spring runs): a spring that never animates never touches it, so the geometry that owns
    // springs (`ContentCover`) can be built and snapped in a plain unit test.
    private val choreographer by lazy { Choreographer.getInstance() }
    private val frame = Choreographer.FrameCallback { nanos -> tick(nanos) }

    var running = false
        private set

    fun animate(from: Float, velocity: Float, to: Float) {
        x = from
        v = velocity
        target = to
        lastNanos = 0L
        if (!running) {
            running = true
            choreographer.postFrameCallback(frame)
        }
    }

    fun stop(): Float {
        if (running) {
            running = false
            choreographer.removeFrameCallback(frame)
        }
        return x
    }

    private fun tick(nanos: Long) {
        if (!running) return
        val dt = if (lastNanos == 0L) 1f / 60f else ((nanos - lastNanos) / 1e9f).coerceIn(0.001f, 0.064f)
        lastNanos = nanos
        step(dt)
        onFrame(x)
        if (x == target && v == 0f) {
            running = false
            onRest(x)
        } else {
            choreographer.postFrameCallback(frame)
        }
    }

    private fun step(dt: Float) {
        val x0 = x - target
        val v0 = v
        val w0 = sqrt(stiffness)
        val zeta = damping / (2f * sqrt(stiffness))
        var nx: Float
        var nv: Float
        if (abs(zeta - 1f) < 1e-4f) {
            val b = v0 + w0 * x0
            val decay = exp(-w0 * dt)
            nx = decay * (x0 + b * dt)
            nv = decay * (b - w0 * (x0 + b * dt))
        } else if (zeta < 1f) {
            val wd = w0 * sqrt(1f - zeta * zeta)
            val b = (v0 + zeta * w0 * x0) / wd
            val decay = exp(-zeta * w0 * dt)
            val c = cos(wd * dt)
            val s = sin(wd * dt)
            nx = decay * (x0 * c + b * s)
            nv = decay * ((b * wd - zeta * w0 * x0) * c - (x0 * wd + zeta * w0 * b) * s)
        } else {
            val root = w0 * sqrt(zeta * zeta - 1f)
            val r1 = -zeta * w0 + root
            val r2 = -zeta * w0 - root
            val c2 = (v0 - r1 * x0) / (r2 - r1)
            val c1 = x0 - c2
            val e1 = exp(r1 * dt)
            val e2 = exp(r2 * dt)
            nx = c1 * e1 + c2 * e2
            nv = c1 * r1 * e1 + c2 * r2 * e2
        }
        if (abs(nx) < REST_DELTA && abs(nv) < REST_SPEED) {
            x = target
            v = 0f
        } else {
            x = nx + target
            v = nv
        }
    }

    companion object {
        private const val REST_DELTA = 0.5f
        private const val REST_SPEED = 8f
    }
}
