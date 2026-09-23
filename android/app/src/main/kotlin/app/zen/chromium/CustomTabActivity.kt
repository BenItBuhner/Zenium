package app.zen.chromium

import android.app.PendingIntent
import android.app.PictureInPictureParams
import android.content.ClipData
import android.content.ClipboardManager
import android.content.ComponentCallbacks2
import android.content.Context
import android.content.Intent
import android.content.MutableContextWrapper
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.Rect
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.util.Rational
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.Toast
import androidx.appcompat.app.AppCompatDelegate
import androidx.browser.customtabs.CustomTabsCallback
import androidx.browser.customtabs.CustomTabsIntent
import androidx.core.content.ContextCompat
import androidx.core.os.BundleCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import org.json.JSONObject
import kotlin.math.abs

/**
 * Another app's custom tab, rendered by Zenium: a [TabWebView] (the same page class, clients and
 * plumbing as a tab of the browser window) under a native toolbar in the caller's colours, with
 * the caller's close control, action button and menu items, the caller's bottom toolbar
 * ([CustomTabBottomBar], CCT-07) above the navigation bar, closing back into the caller's task
 * with the caller's exit animation. "Open in Zenium" hands the live page to the browser window;
 * Minimize shrinks the tab into a floating picture-in-picture card (CCT-11) and the platform's
 * expand control brings it back.
 *
 * Reached through [LinkDispatchActivity] (or `MainActivity.handleIntent` when aimed at the
 * browser directly), always in the task of whoever started it and never in the browser's own:
 * the manifest gives it its own (empty) affinity, so a `singleTask` browser cannot swallow it.
 */
class CustomTabActivity : BrowserActivity(), CustomTabToolbar.Listener, CustomTabFindBar.Listener, CustomTabBottomBar.Listener, CustomTabSessions.Visuals {
    lateinit var config: CustomTabConfig
        private set
    lateinit var host: CustomTabHost
        private set
    lateinit var toolbar: CustomTabToolbar
        private set
    lateinit var bottomBar: CustomTabBottomBar
        private set

    private lateinit var shell: FrameLayout
    private lateinit var pageContainer: FrameLayout
    private lateinit var fullscreenLayer: FrameLayout
    /** The status bar strip in the toolbar's colour; the toolbar slides up behind it when hiding. */
    private lateinit var statusStrip: View
    private var divider: View? = null
    private var findBar: CustomTabFindBar? = null
    private var topInset = 0
    private var bottomInset = 0
    /** The soft keyboard is up: the bottom toolbar steps aside for it, as Chrome's does. */
    private var keyboardUp = false
    private var toolbarShown = true
    private var toolbarAnimating = false
    private var scrolledSinceTurn = 0
    private var lastScrollY = 0
    private var currentUrl = ""
    /** The caller's `PendingIntent` for a swipe up on the bottom toolbar; the caller can set it later. */
    private var swipeUpIntent: PendingIntent? = null
    /** The intent that hears the bottom toolbar's RemoteViews clicks; replaced by the caller's later views. */
    private var remoteClickIntent: PendingIntent? = null
    /** The bottom bar's height the page was last laid out for, so a change can slide instead of jump. */
    private var laidOutBarHeight = 0
    /** Minimize's card, in the shell only while the tab is in picture-in-picture. */
    private var minimizedCard: CustomTabMinimizedCard? = null
    private var minimized = false
    /** While set, [getPackageName] answers with the caller's package (see [closeToCaller]). */
    private var packageForAnimation: String? = null

    /** The page (a fresh view after a renderer crash, see `TabHost.replaceCrashed`). */
    val page: TabWebView? get() = host.tabs.get(TAB_ID)

    override fun onCreate(savedInstanceState: Bundle?) {
        // The caller's colour scheme decides the scheme of every native piece (dialogs, the
        // menu), not the system's: applied before the theme is resolved.
        when (intent.getIntExtra(CustomTabsIntent.EXTRA_COLOR_SCHEME, CustomTabsIntent.COLOR_SCHEME_SYSTEM)) {
            CustomTabsIntent.COLOR_SCHEME_LIGHT -> delegate.localNightMode = AppCompatDelegate.MODE_NIGHT_NO
            CustomTabsIntent.COLOR_SCHEME_DARK -> delegate.localNightMode = AppCompatDelegate.MODE_NIGHT_YES
        }
        super.onCreate(savedInstanceState)
        config = CustomTabConfig.from(this, intent)
        WindowCompat.setDecorFitsSystemWindows(window, false)

        shell = FrameLayout(this)
        pageContainer = FrameLayout(this)
        fullscreenLayer = FrameLayout(this).apply {
            setBackgroundColor(Color.BLACK)
            visibility = View.GONE
        }
        host = CustomTabHost(this, pageContainer, fullscreenLayer, config.scheme.dark)
        toolbar = CustomTabToolbar(this, config, this)
        statusStrip = View(this).apply { setBackgroundColor(config.scheme.toolbar) }
        bottomBar = CustomTabBottomBar(this, config.scheme, this)
        swipeUpIntent = config.swipeUpIntent
        remoteClickIntent = config.remoteViews?.clickIntent
        bottomBar.setRemoteViews(config.remoteViews)
        bottomBar.setButtons(config.bottomButtons)
        bottomBar.swipeUpEnabled = swipeUpIntent != null
        bottomBar.visibility = if (bottomBar.hasContent) View.VISIBLE else View.GONE
        shell.addView(pageContainer, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        shell.addView(toolbar, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.TOP))
        shell.addView(statusStrip, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, Gravity.TOP))
        shell.addView(bottomBar, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM))
        shell.addView(fullscreenLayer, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        setContentView(shell)
        applyScheme()

        ViewCompat.setOnApplyWindowInsetsListener(shell) { _, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
            topInset = bars.top
            bottomInset = maxOf(bars.bottom, ime.bottom)
            keyboardUp = ime.bottom > bars.bottom
            shell.setPadding(bars.left, 0, bars.right, 0)
            toolbar.setTopInset(bars.top)
            statusStrip.layoutParams = (statusStrip.layoutParams as FrameLayout.LayoutParams).apply { height = bars.top }
            bottomBar.setBottomInset(bars.bottom)
            bottomBar.visibility = if (bottomBar.hasContent && !keyboardUp && !minimized) View.VISIBLE else View.GONE
            layoutPage()
            WindowInsetsCompat.CONSUMED
        }
        CustomTabSessions.attach(config.session, this)

        // Back: the page's history first (predictively, like a tab of the browser), then out to
        // the caller. The callback never lets go, so the system never finishes us without the
        // exit animation the caller asked for.
        host.back = PredictiveBack(this, host, chrome = { null }, onLeave = ::closeToCaller, alwaysHandle = true, dismissOverlay = ::closeFind)
        createPage().loadUrl(config.url)
        host.back.update(chrome = false, tabId = TAB_ID)
    }

    // --- the page --------------------------------------------------------------------------------

    /**
     * The page, created around a [MutableContextWrapper] so "Open in Zenium" can re-point it at
     * the browser window (`TabHost.adopt`), full size in its container.
     */
    private fun createPage(): TabWebView {
        val view = host.tabs.create(TAB_ID, Profiles.DEFAULT_CONTAINER, MutableContextWrapper(this))
        attachPage(view)
        return view
    }

    private fun attachPage(view: TabWebView) {
        view.layoutParams = FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        view.visibility = View.VISIBLE
        if (config.hideToolbarOnScroll) {
            view.setOnScrollChangeListener { _, _, y, _, _ -> onPageScrolled(y) }
        }
    }

    /** What the page reports through [CustomTabHost.viewEvent]. */
    fun onPageEvent(name: String, payload: JSONObject?) {
        when (name) {
            "navigated" -> {
                val url = payload?.strOrNull("url") ?: return
                currentUrl = url
                toolbar.setUrl(url)
            }
            "title" -> toolbar.setTitle(payload?.strOrNull("title"))
            "startLoading" -> {
                showToolbar()
                CustomTabSessions.navigationEvent(config.session, CustomTabsCallback.NAVIGATION_STARTED)
            }
            "stopLoading" -> {
                toolbar.setProgress(100)
                CustomTabSessions.navigationEvent(config.session, CustomTabsCallback.NAVIGATION_FINISHED)
            }
            "failLoad" -> {
                toolbar.setProgress(100)
                CustomTabSessions.navigationEvent(config.session, CustomTabsCallback.NAVIGATION_FAILED)
            }
            "found" -> findBar?.setCount(payload?.optInt("activeMatchOrdinal") ?: 0, payload?.optInt("matches") ?: 0)
            "contextMenu" -> payload?.strOrNull("linkURL")?.takeIf { it.isNotEmpty() }?.let(::linkMenu)
            // The renderer died and TabHost swapped in a fresh view: place it and load again.
            "crashed" -> page?.let { fresh ->
                attachPage(fresh)
                fresh.loadUrl(currentUrl.ifEmpty { config.url })
            }
        }
    }

    fun onProgress(percent: Int) = toolbar.setProgress(percent)

    // --- colours and bars (CCT-09) ---------------------------------------------------------------

    private fun applyScheme() {
        val scheme = config.scheme
        // Edge to edge: the toolbar paints the status bar strip in its own colour (its top inset)
        // and the shell's background is what shows under the navigation bar.
        shell.setBackgroundColor(scheme.navigationBar)
        pageContainer.setBackgroundColor(ContextCompat.getColor(this, if (scheme.dark) R.color.v2_page_dark else R.color.v2_page_light))
        window.decorView.setBackgroundColor(scheme.navigationBar)
        val controller = WindowInsetsControllerCompat(window, shell)
        controller.isAppearanceLightStatusBars = !scheme.lightToolbarForeground
        controller.isAppearanceLightNavigationBars = !scheme.lightNavigationForeground
        scheme.navigationBarDivider?.let { color ->
            divider = View(this).apply { setBackgroundColor(color) }
            shell.addView(divider, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 1, Gravity.BOTTOM))
        }
    }

    /**
     * Place the page under the toolbar (or under the status bar alone when it is hidden) and
     * above the caller's bottom toolbar (or the navigation bar alone while the bottom toolbar is
     * hidden with it, or gone for the keyboard): the page's viewport never runs under the bar.
     */
    private fun layoutPage() {
        val lp = pageContainer.layoutParams as FrameLayout.LayoutParams
        lp.topMargin = topInset + if (toolbarShown) toolbar.barHeight else 0
        val barHeight = currentBarHeight()
        laidOutBarHeight = barHeight
        lp.bottomMargin = CustomTabBottomBarRules.pageBottomMargin(bottomInset, barHeight, toolbarShown && barHeight > 0)
        pageContainer.layoutParams = lp
        (divider?.layoutParams as? FrameLayout.LayoutParams)?.let {
            it.bottomMargin = bottomInset
            divider?.layoutParams = it
            divider?.visibility = if (bottomInset > 0) View.VISIBLE else View.GONE
        }
    }

    /** The bottom toolbar's height as the page should allow for it now; 0 when there is none to show. */
    private fun currentBarHeight(): Int {
        if (bottomBar.visibility != View.VISIBLE) return 0
        val laidOut = bottomBar.barHeight
        if (laidOut > 0) return laidOut
        val width = (if (shell.width > 0) shell.width else resources.displayMetrics.widthPixels) - shell.paddingLeft - shell.paddingRight
        return bottomBar.measureBarHeight(width.coerceAtLeast(1))
    }

    // --- toolbar hiding on scroll (EXTRA_ENABLE_URLBAR_HIDING) ----------------------------------

    private fun onPageScrolled(y: Int) {
        val dy = y - lastScrollY
        lastScrollY = y
        if (findBar != null || host.fullscreenTab != null || toolbarAnimating) return
        if (y <= 0) {
            scrolledSinceTurn = 0
            showToolbar()
            return
        }
        // Direction changes restart the count, so a page scrolled slowly still gets there.
        if ((dy > 0) != (scrolledSinceTurn > 0)) scrolledSinceTurn = 0
        scrolledSinceTurn += dy
        val threshold = (SCROLL_THRESHOLD_DP * resources.displayMetrics.density).toInt()
        if (scrolledSinceTurn > threshold && toolbarShown) hideToolbar()
        else if (scrolledSinceTurn < -threshold && !toolbarShown) showToolbar()
        if (abs(scrolledSinceTurn) > threshold) scrolledSinceTurn = 0
    }

    /**
     * The toolbar slides up behind the status bar strip ([statusStrip], drawn over it in the same
     * colour) and the page follows it: the page is first grown by the bar's height behind it (one
     * relayout, drawn where it was), then both translate together so nothing jumps and no gap
     * opens at the bottom. The caller's bottom toolbar goes with it, down past the navigation
     * bar (§11.5's bottom dock: the page grows under it at the first frame, the bar slides off
     * what is now the page's own strip), as Chrome's bottom bar rides the browser controls.
     */
    private fun hideToolbar() {
        if (!toolbarShown || toolbarAnimating) return
        toolbarShown = false
        toolbarAnimating = true
        val h = toolbar.barHeight.toFloat()
        val bar = currentBarHeight()
        layoutPage()
        pageContainer.translationY = h
        toolbar.animate().translationY(-h).setDuration(TOOLBAR_MS).start()
        if (bar > 0) {
            bottomBar.stopSettling()
            bottomBar.animate().translationY(CustomTabBottomBarRules.hiddenTranslation(bar, bottomInset).toFloat()).setDuration(TOOLBAR_MS).start()
        }
        pageContainer.animate().translationY(0f).setDuration(TOOLBAR_MS).withEndAction { toolbarAnimating = false }.start()
    }

    /** The reverse: the bars return first, the page gives the bottom toolbar its strip back at the rest. */
    private fun showToolbar() {
        if (toolbarShown) return
        toolbarShown = true
        toolbarAnimating = true
        val h = toolbar.barHeight.toFloat()
        toolbar.animate().translationY(0f).setDuration(TOOLBAR_MS).start()
        if (bottomBar.translationY != 0f) bottomBar.animate().translationY(0f).setDuration(TOOLBAR_MS).start()
        pageContainer.animate().translationY(h).setDuration(TOOLBAR_MS).withEndAction {
            pageContainer.translationY = 0f
            layoutPage()
            toolbarAnimating = false
        }.start()
    }

    // --- the caller's bottom toolbar (CCT-07) -------------------------------------------------------

    override fun onRemoteViewClick(id: Int) {
        val intent = remoteClickIntent ?: return
        sendToCaller(intent, Intent().putExtra(CustomTabsIntent.EXTRA_REMOTEVIEWS_CLICKED_ID, id))
    }

    override fun onBottomButton(button: CustomTabConfig.ActionButton) = sendToCaller(button.intent)

    override fun onSwipeUp() {
        swipeUpIntent?.let { sendToCaller(it) }
    }

    /**
     * The bar's own height changed (the caller's later `setSecondaryToolbarViews`, typically the
     * secondary toolbar it reveals after a swipe up). Shown, the bar's edge slides from where it
     * was to where it is on §11's spring (the bar's own reveal, so it rides along under a finger
     * still holding the bar) and the page takes a taller bar at the rest, a shorter one at once;
     * hidden, it simply parks the bar further off. The first layout is not a change.
     */
    override fun onBarHeightChanged() {
        if (minimized) return
        val now = currentBarHeight()
        val was = laidOutBarHeight
        if (!toolbarShown) {
            bottomBar.translationY = CustomTabBottomBarRules.hiddenTranslation(now, bottomInset).toFloat()
            laidOutBarHeight = now
            return
        }
        if (was == 0 || now == was || toolbarAnimating) {
            layoutPage()
            return
        }
        if (now < was) layoutPage()
        bottomBar.revealGrowth(now - was)
    }

    override fun onBarSettled() {
        if (!minimized && toolbarShown && !toolbarAnimating) layoutPage()
    }

    /**
     * The caller's later visuals (`CustomTabsService.updateVisuals` for this tab's session): new
     * bottom toolbar views (or none), a new swipe-up intent (or none), a new icon for one of its
     * buttons. True when anything named in the bundle was applied.
     */
    override fun applyVisuals(bundle: Bundle): Boolean {
        var applied = false
        if (bundle.containsKey(CustomTabsIntent.EXTRA_REMOTEVIEWS)) {
            val remote = CustomTabConfig.remoteViews(bundle)
            remoteClickIntent = remote?.clickIntent
            bottomBar.setRemoteViews(remote)
            bottomBar.visibility = if (bottomBar.hasContent && !keyboardUp && !minimized) View.VISIBLE else View.GONE
            if (!bottomBar.hasContent) layoutPage()
            applied = true
        }
        if (bundle.containsKey(CustomTabsIntent.EXTRA_SECONDARY_TOOLBAR_SWIPE_UP_GESTURE)) {
            swipeUpIntent = BundleCompat.getParcelable(bundle, CustomTabsIntent.EXTRA_SECONDARY_TOOLBAR_SWIPE_UP_GESTURE, PendingIntent::class.java)
            bottomBar.swipeUpEnabled = swipeUpIntent != null
            applied = true
        }
        bundle.getBundle(CustomTabsIntent.EXTRA_ACTION_BUTTON_BUNDLE)?.let { button ->
            val icon = BundleCompat.getParcelable(button, CustomTabsIntent.KEY_ICON, Bitmap::class.java) ?: return@let
            val description = button.getString(CustomTabsIntent.KEY_DESCRIPTION) ?: ""
            val id = button.getInt(CustomTabsIntent.KEY_ID, CustomTabButtons.TOP_BAR_ID)
            applied = (if (id == CustomTabButtons.TOP_BAR_ID) toolbar.updateAction(icon, description) else bottomBar.updateButton(id, icon, description)) || applied
        }
        return applied
    }

    // --- Minimize (CCT-11) ----------------------------------------------------------------------------

    /**
     * The tab into a floating picture-in-picture window, Chrome's 16:9 card, grown out of the
     * toolbar. Only this activity ever enters picture-in-picture; the browser window's is the
     * video's. The system may refuse (a policy, a task that cannot); then nothing changes.
     */
    override fun onMinimize() {
        if (minimized || isFinishing || host.fullscreenTab != null) return
        closeFind()
        val builder = PictureInPictureParams.Builder()
            .setAspectRatio(Rational(CustomTabMinimize.ASPECT_WIDTH, CustomTabMinimize.ASPECT_HEIGHT))
        val source = Rect()
        if (toolbar.getGlobalVisibleRect(source)) builder.setSourceRectHint(source)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            builder.setSeamlessResizeEnabled(false)
            builder.setAutoEnterEnabled(false)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            val card = CustomTabMinimize.card(page?.title, currentUrl.ifEmpty { config.url })
            builder.setTitle(card.title)
            if (card.host != card.title) builder.setSubtitle(card.host)
        }
        runCatching { enterPictureInPictureMode(builder.build()) }
    }

    override fun onPictureInPictureModeChanged(isInPictureInPictureMode: Boolean, newConfig: Configuration) {
        super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig)
        val event = CustomTabMinimize.event(minimized, isInPictureInPictureMode) ?: return
        minimized = isInPictureInPictureMode
        if (minimized) showMinimizedCard() else hideMinimizedCard()
        CustomTabSessions.minimized(config.session, event)
    }

    /** The card over everything; the page waits paused and out of sight, its title and favicon on the card. */
    private fun showMinimizedCard() {
        val card = minimizedCard ?: CustomTabMinimizedCard(this, config.scheme.dark).also { minimizedCard = it }
        card.show(CustomTabMinimize.card(page?.title, currentUrl.ifEmpty { config.url }), page?.favicon)
        if (card.parent == null) shell.addView(card, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        pageContainer.visibility = View.INVISIBLE
        toolbar.visibility = View.INVISIBLE
        statusStrip.visibility = View.INVISIBLE
        bottomBar.visibility = View.GONE
        divider?.visibility = View.GONE
        page?.onPause()
    }

    private fun hideMinimizedCard() {
        minimizedCard?.let(shell::removeView)
        pageContainer.visibility = View.VISIBLE
        toolbar.visibility = View.VISIBLE
        statusStrip.visibility = View.VISIBLE
        bottomBar.visibility = if (bottomBar.hasContent && !keyboardUp) View.VISIBLE else View.GONE
        page?.onResume()
        layoutPage()
    }

    /** The tab is in its floating card. */
    val isMinimized: Boolean get() = minimized

    // --- toolbar controls --------------------------------------------------------------------------

    override fun onClose() = closeToCaller()

    override fun onMenu() {
        val titles = config.menuItems.map { it.title }
        CustomTabMenuSheet(this, config.scheme.dark, CustomTabMenu.groups(titles, config.share), ::onMenuPick).show()
    }

    override fun onAction() {
        config.actionButton?.let { sendToCaller(it.intent) }
    }

    private fun onMenuPick(item: CustomTabMenu.Item) {
        when (item) {
            is CustomTabMenu.Item.Caller -> config.menuItems.getOrNull(item.index)?.let { sendToCaller(it.intent) }
            CustomTabMenu.Item.Share -> share()
            CustomTabMenu.Item.CopyLink -> copyLink(currentUrl.ifEmpty { config.url })
            CustomTabMenu.Item.Reload -> page?.reload()
            CustomTabMenu.Item.FindInPage -> openFind()
            CustomTabMenu.Item.OpenInZenium -> openInZenium()
        }
    }

    /**
     * The caller's `PendingIntent` for a button, menu item, bottom toolbar click or swipe, told
     * which page it was pressed on (`fill` carries anything more, such as the clicked id).
     */
    private fun sendToCaller(pendingIntent: PendingIntent, fill: Intent = Intent()) {
        fill.setData(Uri.parse(currentUrl.ifEmpty { config.url }))
        try {
            pendingIntent.send(this, 0, fill)
        } catch (e: PendingIntent.CanceledException) {
            // The caller cancelled it; nothing to do.
        }
    }

    private fun share() {
        val url = currentUrl.ifEmpty { config.url }
        val title = page?.title?.ifEmpty { null }
        val send = Intent(Intent.ACTION_SEND).apply {
            type = "text/plain"
            putExtra(Intent.EXTRA_TEXT, url)
            if (title != null) putExtra(Intent.EXTRA_SUBJECT, title)
        }
        startActivity(Intent.createChooser(send, title ?: url))
    }

    private fun copyLink(url: String) {
        val cm = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        cm.setPrimaryClip(ClipData.newPlainText("Zenium", url))
        // Android 13+ shows its own confirmation.
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) Toast.makeText(this, R.string.cct_link_copied, Toast.LENGTH_SHORT).show()
    }

    /** A long-press on a link: the few things a custom tab can do with it. */
    private fun linkMenu(url: String) {
        val items = arrayOf(getString(R.string.cct_copy_link), getString(R.string.cct_share))
        MaterialAlertDialogBuilder(this)
            .setTitle(url)
            .setItems(items) { _, which ->
                when (which) {
                    0 -> copyLink(url)
                    1 -> startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).apply {
                        type = "text/plain"
                        putExtra(Intent.EXTRA_TEXT, url)
                    }, url))
                }
            }
            .show()
    }

    // --- find in page ------------------------------------------------------------------------------

    private fun openFind() {
        if (findBar != null) return
        showToolbar()
        val bar = CustomTabFindBar(this, toolbar.ink, toolbar.barHeight, this)
        bar.setBackgroundColor(config.scheme.toolbar)
        toolbar.addView(bar, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, toolbar.barHeight, Gravity.BOTTOM))
        findBar = bar
        host.back.update(chrome = true, tabId = TAB_ID)
        bar.focusField()
    }

    /** True when the find bar was up (and is now gone). */
    private fun closeFind(): Boolean {
        val bar = findBar ?: return false
        findBar = null
        bar.hideKeyboard()
        toolbar.removeView(bar)
        page?.stopFind()
        host.back.update(chrome = false, tabId = TAB_ID)
        return true
    }

    override fun onFind(text: String, forward: Boolean, newSession: Boolean) {
        val view = page ?: return
        if (text.isEmpty()) view.stopFind() else view.find(text, forward, newSession)
    }

    override fun onFindClosed() {
        closeFind()
    }

    // --- leaving -------------------------------------------------------------------------------------

    /**
     * Open in Zenium (CCT-04): the live page – history, scroll position, form state – leaves this
     * host for the browser window through [TabHandoff]; the intent carries its URL too, for a
     * window that never collects it.
     */
    private fun openInZenium() {
        val view = page ?: return
        val url = view.url ?: currentUrl.ifEmpty { config.url }
        closeFind()
        host.tabs.release(TAB_ID) ?: return
        view.setOnScrollChangeListener(null)
        val token = TabHandoff.park(view)
        startActivity(
            Intent(Intent.ACTION_VIEW, Uri.parse(url))
                .setClass(this, MainActivity::class.java)
                .putExtra(TabHandoff.EXTRA_TOKEN, token)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        )
        finish()
    }

    /**
     * Close (CCT-05): finish into the caller's task. A caller that sent `EXTRA_EXIT_ANIMATION_BUNDLE`
     * gets its own animations, which live in its package: `overridePendingTransition` resolves
     * them through [getPackageName], answered with that package for the duration of the call
     * (Chrome does the same). Otherwise the theme's slide-down runs.
     */
    fun closeToCaller() {
        if (isFinishing) return
        host.fullscreenTab?.let(host::exitFullscreen)
        finish()
        val animation = config.exitAnimation() ?: return
        packageForAnimation = animation.packageName
        try {
            @Suppress("DEPRECATION")
            overridePendingTransition(animation.enterRes, animation.exitRes)
        } finally {
            packageForAnimation = null
        }
    }

    override fun getPackageName(): String = packageForAnimation ?: super.getPackageName()

    // --- lifecycle -----------------------------------------------------------------------------------

    override fun onStart() {
        super.onStart()
        CustomTabSessions.navigationEvent(config.session, CustomTabsCallback.TAB_SHOWN)
    }

    override fun onStop() {
        CustomTabSessions.navigationEvent(config.session, CustomTabsCallback.TAB_HIDDEN)
        super.onStop()
    }

    override fun onDestroy() {
        CustomTabSessions.detach(config.session, this)
        bottomBar.stopSettling()
        host.destroy()
        super.onDestroy()
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        shell.requestLayout()
    }

    override fun onTrimMemory(level: Int) {
        super.onTrimMemory(level)
        if (level >= ComponentCallbacks2.TRIM_MEMORY_BACKGROUND) host.snapshots.clear()
    }

    companion object {
        /** The one page's id within its TabHost. */
        const val TAB_ID = "custom-tab"
        private const val TOOLBAR_MS = 200L
        /** Scroll distance in one direction before the toolbar moves. */
        private const val SCROLL_THRESHOLD_DP = 40
    }
}
