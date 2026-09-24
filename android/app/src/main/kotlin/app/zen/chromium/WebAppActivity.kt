package app.zen.chromium

import android.app.ActivityManager
import android.content.ClipData
import android.content.ClipboardManager
import android.content.ComponentCallbacks2
import android.content.Context
import android.content.Intent
import android.content.MutableContextWrapper
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.Toast
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.webkit.ScriptHandler
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import org.json.JSONObject

/**
 * An installed web app's own window (PWA-07): one [TabWebView] – the browser's page class, its
 * user agent, clients, cookie jar ([Profiles.DEFAULT_CONTAINER]) and rules – with no browser
 * toolbar, under a status bar in the manifest's `theme_color` (the navigation bar too, as
 * Chrome's `kWebAppNavigationBarThemeColor` paints it), in a task of its own that Recents lists
 * under the app's name and icon ([ActivityManager.TaskDescription]). `display: fullscreen` hides
 * the system bars as well (Chrome's `ImmersiveMode`); `minimal-ui` is the same window as
 * `standalone` on a phone, where Chrome renders no minimal-ui controls ([WebAppRules]).
 *
 * A page outside the manifest's scope raises the custom tab's toolbar ([CustomTabToolbar] in its
 * web-app mode) with an X and the page's origin, as Chrome's `TrustedWebActivityBrowserControls-
 * VisibilityManager` shows the browser controls out of scope; the X walks the history back to the
 * newest page inside the scope, and closes the window only when there is none
 * (`CloseButtonNavigator`). The toolbar's menu is the app's overflow (PWA-08): Share, Copy link,
 * Reload, Open in Zenium.
 *
 * Inside, `window.matchMedia('(display-mode: standalone)')` (or `fullscreen`, `browser` out of
 * scope) answers as the window stands ([WebAppRules.displayModeScript]).
 *
 * The page's plumbing is [CustomTabHost]'s, unforked: downloads to the default folder, the
 * permission and external-protocol dialogs, the file chooser, element fullscreen; with
 * `pageDialogs` the app's `alert` / `confirm` / `prompt` are the native prompt sheets. Reached only
 * through [WebAppLauncherActivity] (the tile's trampoline); never from another app's intent.
 */
class WebAppActivity : BrowserActivity(), CustomTabHost.Listener, CustomTabToolbar.Listener {
    lateinit var record: WebAppRecord
        private set
    lateinit var host: CustomTabHost
        private set
    lateinit var toolbar: CustomTabToolbar
        private set
    lateinit var scheme: CustomTabScheme.Resolved
        private set

    private lateinit var shell: FrameLayout
    private lateinit var pageContainer: FrameLayout
    private lateinit var fullscreenLayer: FrameLayout
    /** The status bar's strip in the theme colour; the page sits below it. */
    private lateinit var statusStrip: View
    private var topInset = 0
    private var bottomInset = 0
    private var currentUrl = ""
    /** Whether the page on screen is inside the app's scope (the toolbar is up while it is not). */
    var inScope = true
        private set
    /** Whether the window itself keeps the system bars hidden (`display: fullscreen`, in scope). */
    var barsHidden = false
        private set
    /** The display mode the page reads through `matchMedia`, as last told. */
    var reportedDisplay = WebAppRules.Display.BROWSER
        private set
    private var displayScript: ScriptHandler? = null
    private var taskIcon: Bitmap? = null

    /** The page (a fresh view after a renderer crash, see `TabHost.replaceCrashed`). */
    val page: TabWebView? get() = if (::host.isInitialized) host.tabs.get(TAB_ID) else null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val record = WebAppRecord.fromIntent(intent)
        val url = intent?.getStringExtra(EXTRA_URL)?.takeIf { it.isNotEmpty() } ?: record?.startUrl
        if (record == null || url == null) {
            // Not a launch of ours (the launcher recreating a task whose intent lost its extras):
            // the page, if any, goes to the browser as a tab rather than to an empty window.
            if (url != null) {
                startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).setClass(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            }
            finish()
            return
        }
        this.record = record
        WindowCompat.setDecorFitsSystemWindows(window, false)
        scheme = resolveScheme(record)
        reportedDisplay = WebAppRules.reportedDisplay(record.display, inScope = true, barsHidden = WebAppRules.immersive(record.display))

        shell = FrameLayout(this)
        pageContainer = FrameLayout(this)
        fullscreenLayer = FrameLayout(this).apply {
            setBackgroundColor(Color.BLACK)
            visibility = View.GONE
        }
        host = CustomTabHost(this, this, pageContainer, fullscreenLayer, scheme.dark, pageDialogs = true)
        toolbar = CustomTabToolbar(this, toolbarConfig(url), this, CustomTabToolbar.Mode.WEB_APP)
        toolbar.visibility = View.GONE
        statusStrip = View(this).apply { setBackgroundColor(scheme.toolbar) }
        shell.addView(pageContainer, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        shell.addView(toolbar, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.TOP))
        shell.addView(statusStrip, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, Gravity.TOP))
        shell.addView(fullscreenLayer, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        setContentView(shell)
        applyScheme()
        describeTask()

        ViewCompat.setOnApplyWindowInsetsListener(shell) { _, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
            topInset = bars.top
            bottomInset = maxOf(bars.bottom, ime.bottom)
            shell.setPadding(bars.left, 0, bars.right, 0)
            toolbar.setTopInset(bars.top)
            statusStrip.layoutParams = (statusStrip.layoutParams as FrameLayout.LayoutParams).apply { height = bars.top }
            layoutPage()
            WindowInsetsCompat.CONSUMED
        }

        // Back: the page's history, predictively, as in a tab of the browser; with nothing left
        // to pop the system has it (its own back-to-home), as for any app of its own.
        host.back = PredictiveBack(this, host, chrome = { null }, onLeave = ::finish)
        applyBars()
        createPage().loadUrl(url)
        host.back.update(chrome = false, tabId = TAB_ID)
    }

    // --- the window's colours and bars ------------------------------------------------------------

    /**
     * The window's colours from the manifest's `theme_color`: the status bar's strip, the
     * out-of-scope toolbar and (Chrome's `kWebAppNavigationBarThemeColor`) the navigation bar,
     * with Zenium's v2 window colour for an app that names none; the glyphs' ink by the same 3:1
     * contrast rule as a custom tab's ([CustomTabScheme.needsLightForeground]).
     */
    private fun resolveScheme(record: WebAppRecord): CustomTabScheme.Resolved {
        val systemDark = resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK == Configuration.UI_MODE_NIGHT_YES
        return CustomTabScheme.resolve(
            CustomTabScheme.SYSTEM, systemDark,
            CustomTabScheme.Params(toolbar = record.themeColor, navigationBar = record.themeColor),
            light = CustomTabScheme.Defaults(ContextCompat.getColor(this, R.color.v2_window_light), ContextCompat.getColor(this, R.color.v2_page_light)),
            dark = CustomTabScheme.Defaults(ContextCompat.getColor(this, R.color.v2_window_dark), ContextCompat.getColor(this, R.color.v2_page_dark))
        )
    }

    /** What the out-of-scope toolbar is told: the title over the origin, share on, nothing of a caller's. */
    private fun toolbarConfig(url: String): CustomTabConfig = CustomTabConfig(
        url = url,
        session = null,
        callerPackage = null,
        scheme = scheme,
        closeIcon = null,
        closeAtEnd = false,
        showTitle = true,
        hideToolbarOnScroll = false,
        actionButton = null,
        menuItems = emptyList(),
        share = true,
        exitAnimation = null,
        remoteViews = null,
        bottomButtons = emptyList(),
        swipeUpIntent = null
    )

    private fun applyScheme() {
        shell.setBackgroundColor(scheme.navigationBar)
        pageContainer.setBackgroundColor(record.backgroundColor ?: ContextCompat.getColor(this, if (scheme.dark) R.color.v2_page_dark else R.color.v2_page_light))
        window.decorView.setBackgroundColor(scheme.navigationBar)
        val controller = WindowInsetsControllerCompat(window, shell)
        controller.isAppearanceLightStatusBars = !scheme.lightToolbarForeground
        controller.isAppearanceLightNavigationBars = !scheme.lightNavigationForeground
    }

    /**
     * Recents' card: the app's name, its tile and the theme colour, not the browser's
     * (Chrome's `CustomTabTaskDescriptionHelper`). The tile is read off the main thread from
     * where the install kept it ([WebAppStore]); the name and colour go up at once.
     */
    private fun describeTask() {
        setTitle(record.name)
        setTaskDescription(taskDescription(record.name, null, scheme.toolbar))
        val file = WebAppStore.tileFile(this, record.shortcutId)
        Thread {
            val icon = runCatching { BitmapFactory.decodeFile(file.path) }.getOrNull() ?: return@Thread
            runOnUiThread {
                if (isFinishing || isDestroyed) return@runOnUiThread
                taskIcon = icon
                setTaskDescription(taskDescription(record.name, icon, scheme.toolbar))
            }
        }.start()
    }

    @Suppress("DEPRECATION")
    private fun taskDescription(label: String, icon: Bitmap?, color: Int): ActivityManager.TaskDescription =
        // The Builder of API 33 takes an icon by resource id only; the app's tile is a bitmap.
        ActivityManager.TaskDescription(label, icon, CustomTabScheme.opaque(color))

    /**
     * The system bars: hidden for `display: fullscreen` while the page is in scope (Chrome's
     * `SharedActivityCoordinator.updateImmersiveMode`: immersive mode yields to the browser
     * controls), a swipe showing them for a moment; shown otherwise. A page element's own
     * fullscreen ([CustomTabHost.enterFullscreen]) hides and shows them itself.
     */
    private fun applyBars() {
        // The window's own pose from the display rule alone: a page element's fullscreen (a
        // video) hides the bars too, but `barsHidden` – and with it `reportedDisplay`, the mode
        // the next document starts with – does not follow it; the element's exit restores this
        // pose (onFullscreenChanged, which is also where the live page's media feature is told
        // `fullscreen` while the element is up and the mode as it stands after).
        val hide = WebAppRules.immersive(record.display) && inScope
        barsHidden = hide
        if (host.fullscreenTab != null) return
        val controller = WindowInsetsControllerCompat(window, shell)
        controller.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        if (hide) controller.hide(WindowInsetsCompat.Type.systemBars()) else controller.show(WindowInsetsCompat.Type.systemBars())
    }

    /**
     * A page element's fullscreen (the Fullscreen API, a video) enters or exits. The window's
     * own pose does not move – the bars return to the display rule's on exit, [reportedDisplay]
     * keeps the manifest's mode for the next document – but the live page's `display-mode`
     * answers `fullscreen` while the element is up and the mode as it stands after: the media
     * feature's rule, Chrome's `isFullscreen()` first in `getDisplayMode`.
     */
    override fun onFullscreenChanged(active: Boolean) {
        if (!active) applyBars()
        page?.let { tellDisplayMode(it, WebAppRules.reportedDisplay(record.display, inScope, barsHidden, elementFullscreen = active)) }
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus && ::host.isInitialized && barsHidden) applyBars()
    }

    /** The page below the status bar's strip (and the toolbar, out of scope) and above the navigation bar. */
    private fun layoutPage() {
        val lp = pageContainer.layoutParams as FrameLayout.LayoutParams
        lp.topMargin = topInset + if (inScope) 0 else toolbar.barHeight
        lp.bottomMargin = bottomInset
        pageContainer.layoutParams = lp
    }

    // --- the page --------------------------------------------------------------------------------

    /**
     * The page, in the default profile's container (the app's cookies are the browser's), around
     * a [MutableContextWrapper] so Open in Zenium can re-point it at the browser window
     * (`TabHost.adopt`), with the display-mode answer installed at every document's start.
     */
    private fun createPage(): TabWebView {
        val view = host.tabs.create(TAB_ID, Profiles.DEFAULT_CONTAINER, MutableContextWrapper(this))
        attachPage(view)
        return view
    }

    private fun attachPage(view: TabWebView) {
        view.layoutParams = FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        view.visibility = View.VISIBLE
        installDisplayScript(view)
    }

    /**
     * `matchMedia('(display-mode: …)')` inside the window: a document-start script with the
     * mode as it stands, re-registered when the mode changes so the next document starts right,
     * and the live document told through [WebAppRules.displayModeUpdate]. A WebView without
     * document-start scripts gets the script at commit instead: the page's own first reads
     * (before then) see the WebView's answer.
     */
    private fun installDisplayScript(view: TabWebView) {
        displayScript?.remove()
        displayScript = null
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            displayScript = runCatching { WebViewCompat.addDocumentStartJavaScript(view, WebAppRules.displayModeScript(reportedDisplay), setOf("*")) }.getOrNull()
        }
    }

    /** The live document told its mode: the window's ([reportedDisplay]) unless a page element's fullscreen says otherwise. */
    private fun tellDisplayMode(view: TabWebView, mode: WebAppRules.Display = reportedDisplay) {
        if (displayScript == null) view.evaluateJavascript(WebAppRules.displayModeScript(reportedDisplay), null)
        view.evaluateJavascript(WebAppRules.displayModeUpdate(mode), null)
    }

    /** What the page reports through [CustomTabHost.viewEvent]. */
    override fun onPageEvent(name: String, payload: JSONObject?) {
        when (name) {
            "navigated" -> {
                val url = payload?.strOrNull("url") ?: return
                currentUrl = url
                toolbar.setUrl(url)
                // The committed document decides, as Chrome's `CurrentPageVerifier` decides at
                // `onDidFinishNavigationInPrimaryMainFrame` (redirects land here too); a
                // same-document change (`pushState`) is not a navigation to it either.
                if (payload.optBoolean("inPage")) return
                setInScope(WebAppRules.inScope(url, record.scope))
                page?.let(::tellDisplayMode)
            }
            "title" -> toolbar.setTitle(payload?.strOrNull("title"))
            "stopLoading", "failLoad" -> toolbar.setProgress(100)
            "contextMenu" -> payload?.strOrNull("linkURL")?.takeIf { it.isNotEmpty() }?.let(::linkMenu)
            // The renderer died and TabHost swapped in a fresh view: place it and load again.
            "crashed" -> page?.let { fresh ->
                attachPage(fresh)
                fresh.loadUrl(currentUrl.ifEmpty { record.startUrl })
            }
        }
    }

    override fun onProgress(percent: Int) = toolbar.setProgress(percent)

    /**
     * The page crossed the scope's edge: the toolbar with its X comes up over a page outside
     * (the bars back with it in a fullscreen app) and goes when the page is inside again; the
     * page's `matchMedia` answer follows.
     */
    private fun setInScope(now: Boolean) {
        if (inScope == now) return
        inScope = now
        toolbar.visibility = if (now) View.GONE else View.VISIBLE
        applyBars()
        layoutPage()
        val reported = WebAppRules.reportedDisplay(record.display, inScope, barsHidden)
        if (reported != reportedDisplay) {
            reportedDisplay = reported
            page?.let(::installDisplayScript)
        }
    }

    // --- toolbar controls (out of scope) --------------------------------------------------------------

    /**
     * The X: back to the newest page of the history inside the scope (Chrome's
     * `CloseButtonNavigator.navigateOnClose`), and the window closed only when the history holds
     * none – an app opened straight onto a page outside its scope.
     */
    override fun onClose() {
        val view = page ?: return finish()
        val list = view.copyBackForwardList()
        for (i in list.currentIndex - 1 downTo 0) {
            if (WebAppRules.inScope(list.getItemAtIndex(i).url, record.scope)) {
                view.goBackOrForward(i - list.currentIndex)
                return
            }
        }
        finish()
    }

    override fun onMenu() {
        CustomTabMenuSheet(this, scheme.dark, CustomTabMenu.webAppGroups(), ::onMenuPick).show()
    }

    override fun onAction() = Unit

    override fun onMinimize() = Unit

    private fun onMenuPick(item: CustomTabMenu.Item) {
        when (item) {
            CustomTabMenu.Item.Share -> share(currentUrl.ifEmpty { record.startUrl }, page?.title?.ifEmpty { null })
            CustomTabMenu.Item.CopyLink -> copyLink(currentUrl.ifEmpty { record.startUrl })
            CustomTabMenu.Item.Reload -> page?.reload()
            CustomTabMenu.Item.OpenInZenium -> openInZenium()
            else -> Unit
        }
    }

    /** Share (PWA-08): the system chooser with the page's address, its title as the subject. */
    private fun share(url: String, title: String?) {
        val send = Intent(Intent.ACTION_SEND).apply {
            type = "text/plain"
            putExtra(Intent.EXTRA_TEXT, url)
            if (title != null) putExtra(Intent.EXTRA_SUBJECT, title)
        }
        startActivity(Intent.createChooser(send, title ?: url))
    }

    /** Copy link (PWA-08): to the clipboard; Zenium's toast below Android 13, the system's own from it (SH-04). */
    private fun copyLink(url: String) {
        val cm = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        cm.setPrimaryClip(ClipData.newPlainText("Zenium", url))
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) Toast.makeText(this, R.string.cct_link_copied, Toast.LENGTH_SHORT).show()
    }

    /** A long-press on a link: copy it or share it, the two things this window can do with one. */
    private fun linkMenu(url: String) {
        val items = arrayOf(getString(R.string.cct_copy_link), getString(R.string.cct_share))
        MaterialAlertDialogBuilder(this)
            .setTitle(url)
            .setItems(items) { _, which -> if (which == 0) copyLink(url) else share(url, null) }
            .show()
    }

    /**
     * Open in Zenium (PWA-08): the live page – history, scroll position, form state – leaves this
     * window for the browser as a tab through [TabHandoff], the way a custom tab's does (CCT-04);
     * the intent carries its URL too, for a window that never collects it. Its display-mode
     * answer is the browser's again first, and the window closes.
     */
    private fun openInZenium() {
        val view = page ?: return
        val url = view.url ?: currentUrl.ifEmpty { record.startUrl }
        displayScript?.remove()
        displayScript = null
        view.evaluateJavascript(WebAppRules.displayModeUpdate(WebAppRules.Display.BROWSER), null)
        host.tabs.release(TAB_ID) ?: return
        val token = TabHandoff.park(view)
        startActivity(
            Intent(Intent.ACTION_VIEW, Uri.parse(url))
                .setClass(this, MainActivity::class.java)
                .putExtra(TabHandoff.EXTRA_TOKEN, token)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        )
        finish()
    }

    // --- lifecycle -----------------------------------------------------------------------------------

    // The tile tapped while the app runs (`singleTop` in its own document task) delivers the
    // launch intent to `onNewIntent`, and the window comes forward as it stands: Chrome's
    // `CustomTabIntentHandler.onNewIntent` does not navigate either unless the intent forces it
    // ("the purpose of the intent was to bring the webapp to the foreground").

    override fun onDestroy() {
        displayScript?.remove()
        if (::host.isInitialized) host.destroy()
        super.onDestroy()
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        if (::shell.isInitialized) shell.requestLayout()
    }

    override fun onTrimMemory(level: Int) {
        super.onTrimMemory(level)
        if (level >= ComponentCallbacks2.TRIM_MEMORY_BACKGROUND && ::host.isInitialized) host.snapshots.clear()
    }

    companion object {
        /** The page to open, beside the app's record in the launch intent ([WebAppLauncherActivity.launchIntent]). */
        const val EXTRA_URL = "app.zen.chromium.extra.WEBAPP_URL"
        /** The one page's id within its TabHost. */
        const val TAB_ID = "web-app"
    }
}
