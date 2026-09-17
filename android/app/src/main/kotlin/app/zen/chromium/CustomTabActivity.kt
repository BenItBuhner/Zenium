package app.zen.chromium

import android.app.PendingIntent
import android.content.ClipData
import android.content.ClipboardManager
import android.content.ComponentCallbacks2
import android.content.Context
import android.content.Intent
import android.content.MutableContextWrapper
import android.content.res.Configuration
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.Toast
import androidx.appcompat.app.AppCompatDelegate
import androidx.browser.customtabs.CustomTabsCallback
import androidx.browser.customtabs.CustomTabsIntent
import androidx.core.content.ContextCompat
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
 * the caller's close control, action button and menu items, closing back into the caller's task
 * with the caller's exit animation. "Open in Zenium" hands the live page to the browser window.
 *
 * Reached through [LinkDispatchActivity] (or `MainActivity.handleIntent` when aimed at the
 * browser directly), always in the task of whoever started it and never in the browser's own:
 * the manifest gives it its own (empty) affinity, so a `singleTask` browser cannot swallow it.
 */
class CustomTabActivity : BrowserActivity(), CustomTabToolbar.Listener, CustomTabFindBar.Listener {
    lateinit var config: CustomTabConfig
        private set
    lateinit var host: CustomTabHost
        private set
    lateinit var toolbar: CustomTabToolbar
        private set

    private lateinit var shell: FrameLayout
    private lateinit var pageContainer: FrameLayout
    private lateinit var fullscreenLayer: FrameLayout
    private var divider: View? = null
    private var findBar: CustomTabFindBar? = null
    private var topInset = 0
    private var bottomInset = 0
    private var toolbarShown = true
    private var toolbarAnimating = false
    private var scrolledSinceTurn = 0
    private var lastScrollY = 0
    private var currentUrl = ""
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
        shell.addView(pageContainer, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        shell.addView(toolbar, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.TOP))
        shell.addView(fullscreenLayer, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        setContentView(shell)
        applyScheme()

        ViewCompat.setOnApplyWindowInsetsListener(shell) { _, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
            topInset = bars.top
            bottomInset = maxOf(bars.bottom, ime.bottom)
            shell.setPadding(bars.left, 0, bars.right, 0)
            toolbar.setTopInset(bars.top)
            layoutPage()
            WindowInsetsCompat.CONSUMED
        }

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

    /** Place the page under the toolbar (or under the status bar alone when it is hidden). */
    private fun layoutPage() {
        val lp = pageContainer.layoutParams as FrameLayout.LayoutParams
        lp.topMargin = topInset + if (toolbarShown) toolbar.barHeight else 0
        lp.bottomMargin = bottomInset
        pageContainer.layoutParams = lp
        (divider?.layoutParams as? FrameLayout.LayoutParams)?.let {
            it.bottomMargin = bottomInset
            divider?.layoutParams = it
            divider?.visibility = if (bottomInset > 0) View.VISIBLE else View.GONE
        }
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
     * The toolbar slides up and the page follows it: the page is first grown by the bar's height
     * behind it (one relayout, drawn where it was), then both translate together so nothing
     * jumps and no gap opens at the bottom.
     */
    private fun hideToolbar() {
        if (!toolbarShown || toolbarAnimating) return
        toolbarShown = false
        toolbarAnimating = true
        val h = toolbar.barHeight.toFloat()
        layoutPage()
        pageContainer.translationY = h
        toolbar.animate().translationY(-h).setDuration(TOOLBAR_MS).start()
        pageContainer.animate().translationY(0f).setDuration(TOOLBAR_MS).withEndAction { toolbarAnimating = false }.start()
    }

    private fun showToolbar() {
        if (toolbarShown) return
        toolbarShown = true
        toolbarAnimating = true
        val h = toolbar.barHeight.toFloat()
        toolbar.animate().translationY(0f).setDuration(TOOLBAR_MS).start()
        pageContainer.animate().translationY(h).setDuration(TOOLBAR_MS).withEndAction {
            pageContainer.translationY = 0f
            layoutPage()
            toolbarAnimating = false
        }.start()
    }

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

    /** The caller's `PendingIntent` for a button or menu item, told which page it was pressed on. */
    private fun sendToCaller(pendingIntent: PendingIntent) {
        val fill = Intent().setData(Uri.parse(currentUrl.ifEmpty { config.url }))
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
