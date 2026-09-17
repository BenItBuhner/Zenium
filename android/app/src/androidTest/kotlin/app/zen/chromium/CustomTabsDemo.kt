package app.zen.chromium

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.PointF
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import android.util.Log
import android.view.accessibility.AccessibilityNodeInfo
import android.widget.Toast
import androidx.browser.customtabs.CustomTabColorSchemeParams
import androidx.browser.customtabs.CustomTabsCallback
import androidx.browser.customtabs.CustomTabsClient
import androidx.browser.customtabs.CustomTabsIntent
import androidx.browser.customtabs.CustomTabsServiceConnection
import androidx.browser.customtabs.CustomTabsSession
import androidx.core.content.ContextCompat
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import org.json.JSONObject
import org.json.JSONTokener
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Drives Zenium as a Custom Tabs provider so the `android-customtabs-demo` workflow can record it:
 * another app ("Nimbus News", [CustomTabCallerActivity] in the instrumentation APK, its own
 * package and process) opens a story in a custom tab whose intent this driver built the way a
 * real client does – `CustomTabsClient.bindCustomTabsService` against the debug application id,
 * `warmup`, `newSession` with a callback, `mayLaunchUrl`, then a `CustomTabsIntent` with the
 * session, a toolbar colour, the title, toolbar hiding, an action button, two menu items and exit
 * animations. The recording shows the tab arriving over the caller in the caller's colour, a link
 * followed and back stepping within the tab's history, the toolbar hiding on scroll, the menu,
 * one of the caller's items firing (its PendingIntent lands back in the "app" as a toast), Open
 * in Zenium landing in the browser window with the live page, a second, dark-scheme tab, and X
 * closing back to the caller with the caller's exit animation.
 *
 * The session callback's navigation events and the return to the caller are asserted; the
 * screenshots (`customtabs-*.png`) and the recording are the rest of the evidence.
 */
@RunWith(AndroidJUnit4::class)
class CustomTabsDemo : DemoHarness("customtabs-demo-state.json", "customtabs", "customtabs-demo") {
    override val tag = "CustomTabsDemo"

    private val callerPackage: String = instrumentation.context.packageName
    private var client: CustomTabsClient? = null
    private var session: CustomTabsSession? = null
    private val events: MutableList<String> = Collections.synchronizedList(ArrayList())
    private var receiver: BroadcastReceiver? = null

    @Test
    fun record() = runDemo()

    override fun warmUp() {
        connect()
        listenForCallerActions()
        showCaller(customTabIntent(dark = false))
    }

    override fun demo() {
        // 1. The other app.
        shot("01-caller")
        beat()

        // 2. Its button opens the story as a custom tab: the caller's blue toolbar, title over host,
        //    lock, the action button and the menu button, sliding up over the caller.
        openCustomTab()
        shot("02-toolbar-light")
        beat()

        // 3. A link followed inside the tab: the toolbar follows the page (host, title, lock).
        val page = customTab()?.page
        if (page != null) {
            plantLink(page)?.let { p ->
                Finger().tap(p.x, p.y)
                waitForPage("example.com")
                SystemClock.sleep(1_500)
                shot("03-navigated")
                beat()
            }
        } else {
            Log.w(tag, "no custom tab page to plant a link in")
        }

        // 4. Back steps within the tab's history, not out of the tab.
        back()
        waitForPage("wikipedia.org")
        SystemClock.sleep(2_000)
        shot("04-back-in-history")
        assertTrue("back stayed within the custom tab", waitForWindow(app.packageName, 3_000) && findByLabel(CLOSE_LABEL) != null)
        beat()

        // 5. EXTRA_ENABLE_URLBAR_HIDING: the toolbar leaves as the page scrolls down and returns
        //    as it scrolls up.
        scroll(-0.45f)
        SystemClock.sleep(1_500)
        shot("05-toolbar-hidden")
        scroll(0.45f)
        SystemClock.sleep(1_500)

        // 6. The menu: the caller's items, Zenium's page actions, Open in Zenium.
        openMenu()
        shot("06-menu-light")
        beat()

        // 7. One of the caller's items: its PendingIntent fires with the page's URL (the toast is
        //    the caller's receiver answering).
        if (clickByLabel(SAVE_LABEL)) {
            SystemClock.sleep(1_800)
            shot("07-caller-item")
        } else {
            Log.w(tag, "no $SAVE_LABEL in the menu")
            dismissSheet()
        }
        beat()

        // 7b. Find in page: the bar takes the toolbar's row and counts matches as the query goes in.
        openMenu()
        findInPage("07b-find-light")

        // 8. Open in Zenium: the live page moves into the browser window.
        openMenu()
        if (clickByLabel(OPEN_IN_ZENIUM_LABEL)) {
            waitForWindow(app.packageName, 10_000)
            SystemClock.sleep(6_000)
            shot("08-open-in-zenium")
            Log.i(tag, "browser window shows ${findByLabelPrefix(PILL_LABEL)}")
        } else {
            Log.w(tag, "no $OPEN_IN_ZENIUM_LABEL in the menu")
            dismissSheet()
        }
        beat()

        // 9. A second tab from the caller, in the dark scheme with Zenium's own toolbar colour.
        showCaller(customTabIntent(dark = true))
        openCustomTab()
        shot("09-toolbar-dark")
        beat()
        openMenu()
        shot("10-menu-dark")
        beat()
        findInPage("10b-find-dark")

        // 10. X closes the tab, with the caller's exit animation, back into the caller.
        clickByLabel(CLOSE_LABEL)
        val returned = waitForWindow(callerPackage, 8_000)
        SystemClock.sleep(1_500)
        shot("11-closed-to-caller")

        Log.i(tag, "session events: $events")
        assertTrue("the session callback heard the tab show (TAB_SHOWN)", events.contains("TAB_SHOWN"))
        assertTrue("the session callback heard a navigation start", events.contains("NAVIGATION_STARTED"))
        assertTrue("the session callback heard the tab hide (TAB_HIDDEN)", events.contains("TAB_HIDDEN"))
        assertTrue("closing the custom tab returned to the caller", returned)
    }

    // --- the client side -------------------------------------------------------------------------

    /** Bind the provider service as a client app does, and prepare a session with a callback. */
    private fun connect() {
        val latch = CountDownLatch(1)
        val bound = CustomTabsClient.bindCustomTabsService(app, app.packageName, object : CustomTabsServiceConnection() {
            override fun onCustomTabsServiceConnected(name: ComponentName, connected: CustomTabsClient) {
                client = connected
                latch.countDown()
            }

            override fun onServiceDisconnected(name: ComponentName?) {
                client = null
            }
        })
        assertTrue("bindCustomTabsService(${app.packageName})", bound)
        assertTrue("the Custom Tabs service connected", latch.await(15, TimeUnit.SECONDS))
        val c = client ?: error("no client after connecting")
        Log.i(tag, "warmup: ${c.warmup(0)}")
        val s = c.newSession(object : CustomTabsCallback() {
            override fun onNavigationEvent(navigationEvent: Int, extras: Bundle?) {
                val name = when (navigationEvent) {
                    NAVIGATION_STARTED -> "NAVIGATION_STARTED"
                    NAVIGATION_FINISHED -> "NAVIGATION_FINISHED"
                    NAVIGATION_FAILED -> "NAVIGATION_FAILED"
                    NAVIGATION_ABORTED -> "NAVIGATION_ABORTED"
                    TAB_SHOWN -> "TAB_SHOWN"
                    TAB_HIDDEN -> "TAB_HIDDEN"
                    else -> "event $navigationEvent"
                }
                events.add(name)
                Log.i(tag, "session: $name")
            }
        }) ?: error("newSession returned null")
        session = s
        Log.i(tag, "mayLaunchUrl: ${s.mayLaunchUrl(Uri.parse(STORY_URL), null, null)}")
    }

    /**
     * The caller's side of its action button and menu items: the PendingIntents are broadcasts,
     * received here (the driver stands in for the app) and shown as a toast naming the page.
     */
    private fun listenForCallerActions() {
        val r = object : BroadcastReceiver() {
            override fun onReceive(context: Context, intent: Intent) {
                val what = if (intent.action == ACTION_OPEN_IN_APP) "Opened in the app" else "Saved for later"
                val where = intent.data?.host ?: "no URL"
                Log.i(tag, "caller received ${intent.action} for ${intent.dataString}")
                Toast.makeText(context, "Nimbus News · $what · $where", Toast.LENGTH_LONG).show()
            }
        }
        val filter = IntentFilter().apply {
            addAction(ACTION_SAVE)
            addAction(ACTION_OPEN_IN_APP)
            addDataScheme("http")
            addDataScheme("https")
        }
        ContextCompat.registerReceiver(app, r, filter, ContextCompat.RECEIVER_NOT_EXPORTED)
        receiver = r
    }

    /** A mutable broadcast PendingIntent, so the provider can fill the page's URL in as data. */
    private fun callerAction(action: String, requestCode: Int): PendingIntent {
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or
            (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0)
        return PendingIntent.getBroadcast(app, requestCode, Intent(action).setPackage(app.packageName), flags)
    }

    /**
     * What a client builds: light scheme with its brand colour on the toolbar (and a dark-scheme
     * variant of it in EXTRA_COLOR_SCHEME_PARAMS), or the dark scheme with only the bar under
     * the page named, leaving the toolbar to Zenium.
     */
    private fun customTabIntent(dark: Boolean): Intent {
        val s = session ?: error("no session")
        val save = callerAction(ACTION_SAVE, 1)
        val builder = CustomTabsIntent.Builder(s)
            .setShowTitle(true)
            .setUrlBarHidingEnabled(true)
            .setShareState(CustomTabsIntent.SHARE_STATE_ON)
            .setActionButton(bookmarkIcon(), SAVE_LABEL, save, true)
            .addMenuItem(SAVE_LABEL, save)
            .addMenuItem("Open in Nimbus News", callerAction(ACTION_OPEN_IN_APP, 2))
            .setExitAnimations(app, android.R.anim.fade_in, android.R.anim.slide_out_right)
        if (dark) {
            builder.setColorScheme(CustomTabsIntent.COLOR_SCHEME_DARK)
                .setColorSchemeParams(
                    CustomTabsIntent.COLOR_SCHEME_DARK,
                    CustomTabColorSchemeParams.Builder().setNavigationBarColor(0xFF131313.toInt()).build()
                )
        } else {
            builder.setColorScheme(CustomTabsIntent.COLOR_SCHEME_LIGHT)
                .setDefaultColorSchemeParams(CustomTabColorSchemeParams.Builder().setToolbarColor(BRAND).build())
                .setColorSchemeParams(
                    CustomTabsIntent.COLOR_SCHEME_DARK,
                    CustomTabColorSchemeParams.Builder().setToolbarColor(BRAND_DARK).build()
                )
        }
        val intent = builder.build().intent
        intent.data = Uri.parse(STORY_URL)
        // Clients aim the intent at the provider they bound (CustomTabsClient.getPackageName).
        intent.setPackage(app.packageName)
        return intent
    }

    /** A 24 dp bookmark glyph, white so the provider's tint applies (`setActionButton(…, tint = true)`). */
    private fun bookmarkIcon(): Bitmap {
        val size = (24 * density).toInt()
        val bitmap = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = Color.WHITE
            style = Paint.Style.STROKE
            strokeWidth = 2 * density
            strokeJoin = Paint.Join.ROUND
            strokeCap = Paint.Cap.ROUND
        }
        val u = size / 24f
        val path = Path().apply {
            moveTo(6 * u, 3 * u)
            lineTo(18 * u, 3 * u)
            lineTo(18 * u, 21 * u)
            lineTo(12 * u, 17 * u)
            lineTo(6 * u, 21 * u)
            close()
        }
        canvas.drawPath(path, paint)
        return bitmap
    }

    // --- the caller ------------------------------------------------------------------------------

    /** Bring Nimbus News up (or forward) holding `launch` for its button. */
    private fun showCaller(launch: Intent) {
        val intent = Intent()
            .setClassName(callerPackage, CALLER_ACTIVITY)
            .putExtra(CustomTabCallerActivity.EXTRA_LAUNCH, launch)
            .putExtra(CustomTabCallerActivity.EXTRA_BROWSER, app.packageName)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        app.startActivity(intent)
        assertTrue("the caller app came up", waitForWindow(callerPackage, 15_000))
        SystemClock.sleep(2_000)
    }

    /** Press the caller's button and wait for the custom tab and its page. */
    private fun openCustomTab() {
        assertTrue("the caller's button is on screen", clickByLabel(READ_LABEL))
        assertTrue("the custom tab came up", waitForWindow(app.packageName, 15_000))
        assertTrue("the custom tab's toolbar is up", waitFor(CLOSE_LABEL, 10_000) != null)
        waitForPage("wikipedia.org")
        SystemClock.sleep(2_500)
    }

    // --- moves -----------------------------------------------------------------------------------

    private fun openMenu() {
        ensureForeground()
        assertTrue("the menu button is on screen", clickByLabel(MENU_LABEL))
        waitFor(OPEN_IN_ZENIUM_LABEL, 5_000)
        SystemClock.sleep(1_500)
    }

    private fun dismissSheet() {
        if (findByLabel(OPEN_IN_ZENIUM_LABEL) != null) {
            back()
            SystemClock.sleep(1_200)
        }
    }

    /**
     * From the open menu: Find in Page, a query into the bar's field (set through the focused
     * node, the way an IME would; keys if there is none), a shot of the counted matches, then
     * the bar's own close.
     */
    private fun findInPage(name: String) {
        if (!clickByLabel(FIND_LABEL)) {
            Log.w(tag, "no $FIND_LABEL in the menu")
            dismissSheet()
            return
        }
        assertTrue("the find bar came up", waitFor(FIND_CLOSE_LABEL, 5_000) != null)
        SystemClock.sleep(800)
        val field = ui.rootInActiveWindow?.findFocus(AccessibilityNodeInfo.FOCUS_INPUT)
        val typed = field?.performAction(
            AccessibilityNodeInfo.ACTION_SET_TEXT,
            Bundle().apply { putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, FIND_QUERY) }
        ) ?: false
        if (!typed) instrumentation.sendStringSync(FIND_QUERY)
        SystemClock.sleep(1_800)
        shot(name)
        beat()
        clickByLabel(FIND_CLOSE_LABEL)
        SystemClock.sleep(1_000)
    }

    /** Drag the page by `fraction` of the window height (negative: content moves up). */
    private fun scroll(fraction: Float) {
        val f = Finger()
        val startY = if (fraction < 0) height * 0.75f else height * 0.35f
        f.down(width / 2f, startY)
        f.moveBy(0f, fraction * height, 350)
        f.hold(100)
        f.up()
    }

    private fun topPackage(): String? = ui.rootInActiveWindow?.packageName?.toString()

    private fun waitForWindow(packageName: String, timeoutMs: Long): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (topPackage() == packageName) return true
            SystemClock.sleep(200)
        }
        Log.w(tag, "window of $packageName never came up; top is ${topPackage()}")
        return false
    }

    // --- the page --------------------------------------------------------------------------------

    /** The custom tab that is resumed, if one is (the driver shares Zenium's process). */
    private fun customTab(): CustomTabActivity? {
        var found: CustomTabActivity? = null
        instrumentation.runOnMainSync {
            found = ActivityLifecycleMonitorRegistry.getInstance()
                .getActivitiesInStage(Stage.RESUMED)
                .filterIsInstance<CustomTabActivity>()
                .firstOrNull()
        }
        return found
    }

    /**
     * Wait until the custom tab's page is on a host ending in `host` (Wikipedia sends phones to
     * `en.m.wikipedia.org`) and has finished loading.
     */
    private fun waitForPage(host: String) {
        val deadline = SystemClock.uptimeMillis() + 20_000
        while (SystemClock.uptimeMillis() < deadline) {
            val page = customTab()?.page
            val state = if (page != null) evalJs(page, PAGE_STATE_JS) else null
            if (state != null && state.endsWith(":complete") && state.substringBefore(':').endsWith(host)) return
            SystemClock.sleep(500)
        }
        Log.w(tag, "the page never reported $host complete")
    }

    /** Add a big link to example.com over the page and return where it is on screen. */
    private fun plantLink(page: TabWebView): PointF? {
        val text = evalJs(page, PLANT_LINK_JS) ?: run {
            Log.w(tag, "planting the link returned nothing")
            return null
        }
        val origin = IntArray(2)
        instrumentation.runOnMainSync { page.getLocationOnScreen(origin) }
        val point = JSONObject(text)
        return PointF(origin[0] + point.getDouble("x").toFloat(), origin[1] + point.getDouble("y").toFloat())
    }

    private fun evalJs(page: TabWebView, script: String): String? {
        val latch = CountDownLatch(1)
        var result: String? = null
        instrumentation.runOnMainSync {
            page.evaluateJavascript(script) {
                result = it
                latch.countDown()
            }
        }
        latch.await(10, TimeUnit.SECONDS)
        return runCatching { JSONTokener(result ?: "null").nextValue() as? String }.getOrNull()
    }

    companion object {
        private const val CALLER_ACTIVITY = "app.zen.chromium.CustomTabCallerActivity"
        private const val STORY_URL = "https://en.wikipedia.org/wiki/Damping"
        private const val BRAND = 0xFF2E5BFF.toInt()
        private const val BRAND_DARK = 0xFF1B2A6B.toInt()
        private const val ACTION_SAVE = "app.zen.chromium.demo.SAVE"
        private const val ACTION_OPEN_IN_APP = "app.zen.chromium.demo.OPEN_IN_APP"

        private const val READ_LABEL = "Read the story"
        private const val SAVE_LABEL = "Save for later"
        private const val CLOSE_LABEL = "Close"
        private const val MENU_LABEL = "Menu"
        private const val OPEN_IN_ZENIUM_LABEL = "Open in Zenium"
        private const val FIND_LABEL = "Find in Page"
        private const val FIND_CLOSE_LABEL = "Close find bar"
        private const val FIND_QUERY = "damping"

        private const val PAGE_STATE_JS = "location.host + ':' + document.readyState"

        /** One tall link over the page; its centre in device pixels relative to the WebView. */
        private val PLANT_LINK_JS = """
            (function () {
              var a = document.createElement('a');
              a.href = 'https://example.com/';
              a.textContent = 'Continue to example.com →';
              a.style.cssText = 'position:fixed;left:16px;right:16px;top:40%;display:block;padding:22px 18px;' +
                'border-radius:14px;background:#fff;color:#1d1d2c;text-decoration:none;z-index:2147483647;' +
                'font:600 18px/1.3 system-ui,sans-serif;box-shadow:0 2px 10px rgba(0,0,0,.14)';
              document.body.appendChild(a);
              var vv = window.visualViewport;
              var scale = (vv ? vv.scale : 1) * (window.devicePixelRatio || 1);
              var r = a.getBoundingClientRect();
              return JSON.stringify({
                x: (r.left + r.width / 2 - (vv ? vv.offsetLeft : 0)) * scale,
                y: (r.top + r.height / 2 - (vv ? vv.offsetTop : 0)) * scale
              });
            })()
        """.trimIndent()
    }
}
