package app.zen.chromium

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.graphics.PointF
import android.net.Uri
import android.os.Binder
import android.os.Build
import android.os.Bundle
import android.os.IBinder
import android.os.Parcel
import android.os.SystemClock
import android.util.Log
import androidx.browser.customtabs.CustomTabsCallback
import androidx.browser.customtabs.CustomTabsIntent
import androidx.browser.customtabs.CustomTabsService
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import org.json.JSONObject
import org.json.JSONTokener
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Drives the Auth Tab (CCT-13) so the `android-auth-tab-demo` workflow can record it: "Nimbus
 * News" ([CustomTabCallerActivity], the instrumentation APK's own package and process) starts
 * an Auth Tab intent FOR A RESULT – the extras androidx.browser 1.9.0's `AuthTabIntent` writes,
 * put on by hand here (the test APK carries 1.8.0, as Zenium does) – over a sign-in page this
 * driver serves on the loopback ([DemoServer]), and reads the result the tab hands back.
 *
 * What it reads and asserts:
 *  - the Auth Tab's CHROME: the custom tab's toolbar under Chrome's fixed configuration – the
 *    close control and the title, no Minimize, no Share in the slot, and a menu without Share,
 *    Add to Home Screen, Open in Zenium or the caller's rows (Copy Link, Find in Page, Desktop
 *    Site over an icon row of Forward, Page Info, Reload) – light and dark (the design stills);
 *  - the CUSTOM SCHEME return: the sign-in form's Continue posts to the "server", which answers
 *    303 to `zeniumtest://done?code=1`; the redirect is never loaded – the tab closes and the
 *    caller's `onActivityResult` reads `RESULT_OK` (-1) with the URI as data;
 *  - BACK out of the tab: `RESULT_CANCELED` (0), no data;
 *  - the HTTPS return refused: a redirect host and path the caller cannot prove it owns (no
 *    verified link, no `assetlinks.json` on the loopback's 443) – the navigation to it is claimed
 *    all the same and the caller reads `RESULT_VERIFICATION_FAILED` (2), no data;
 *  - the SESSION on the wire: the driver binds the provider's service and sends the 1.9.0
 *    proxy's `newAuthTabSession` transaction (the callback binder, the typed bundle) itself, and
 *    that callback hears the tab's navigation events as the 1.9.0 `IAuthTabCallback` would.
 *
 * The stills `auth-tab-*.png` are the design gate's (the tab light and dark) and the rest of the
 * evidence; `findings.txt` the results read.
 */
@RunWith(AndroidJUnit4::class)
class AuthTabDemo : DemoHarness("customtabs-demo-state.json", "auth-tab", "auth-tab-demo") {
    override val tag = "AuthTabDemo"

    private val callerPackage: String = instrumentation.context.packageName
    private lateinit var server: DemoServer
    private lateinit var findings: File
    private var service: IBinder? = null
    private var connection: ServiceConnection? = null
    /** What the Auth Tab session's callback heard, as `CustomTabsCallback.NAVIGATION_*` names. */
    private val events: MutableList<String> = Collections.synchronizedList(ArrayList())

    /** The client's `IAuthTabCallback`, as 1.9.0's stub would answer the one-way `onNavigationEvent`. */
    private val callback = object : Binder() {
        init {
            attachInterface(null, CALLBACK_DESCRIPTOR)
        }

        override fun onTransact(code: Int, data: Parcel, reply: Parcel?, flags: Int): Boolean {
            if (code != TRANSACTION_ON_NAVIGATION_EVENT) return super.onTransact(code, data, reply, flags)
            data.enforceInterface(CALLBACK_DESCRIPTOR)
            val event = data.readInt()
            val extras = if (data.readInt() != 0) Bundle.CREATOR.createFromParcel(data) else null
            val name = when (event) {
                CustomTabsCallback.NAVIGATION_STARTED -> "NAVIGATION_STARTED"
                CustomTabsCallback.NAVIGATION_FINISHED -> "NAVIGATION_FINISHED"
                CustomTabsCallback.NAVIGATION_FAILED -> "NAVIGATION_FAILED"
                CustomTabsCallback.NAVIGATION_ABORTED -> "NAVIGATION_ABORTED"
                CustomTabsCallback.TAB_SHOWN -> "TAB_SHOWN"
                CustomTabsCallback.TAB_HIDDEN -> "TAB_HIDDEN"
                else -> "event $event"
            }
            events.add(name)
            Log.i(tag, "auth tab session heard $name (extras ${extras?.size() ?: "none"})")
            return true
        }
    }

    @Test
    fun record() = runDemo()

    override fun warmUp() {
        findings = File(out, "findings.txt")
        findings.writeText("Zenium Android Auth Tab (CCT-13), API ${Build.VERSION.SDK_INT}, ${width}x$height, density $density\n\n")
        server = DemoServer(
            PORT,
            routes(),
            redirects = mapOf(
                APPROVE_PATH to "$SCHEME://done?code=1",
                HTTPS_APPROVE_PATH to "https://$HOST:$PORT$HTTPS_DONE_PATH?code=2"
            )
        ).also { it.start() }
        Log.i(tag, "server: ${server.selfCheck()}")
        bindService()
        newAuthTabSession()
        showCaller(authTabIntent(dark = false, https = false))
    }

    override fun demo() {
        // 1. The other app, its button a sign-in.
        shot("01-caller")
        beat()

        // 2. The Auth Tab, light: the custom tab's toolbar under Chrome's fixed configuration.
        openAuthTab(SIGNIN_PATH)
        readChrome("light")
        shot("02-light")
        beat()

        // 3. Its menu: no Share, no Add to Home Screen, no Open in Zenium, no caller rows.
        openMenu()
        readMenu("light")
        shot("03-menu-light")
        beat()
        dismissSheet()

        // 4. Continue: the form's POST, the server's 303 to the custom scheme, the tab gone and
        //    the caller reading RESULT_OK with the redirect URI.
        val before = events.size
        pressContinue()
        val ok = awaitResult("$RESULT_OK $SCHEME://done?code=1")
        note("custom scheme: the caller read '${resultLine()}'")
        assertTrue("the caller read RESULT_OK with the redirect URI", ok)
        SystemClock.sleep(1_200)
        shot("04-result-ok")
        beat()
        val heard = events.toList()
        note("session: the callback heard ${heard.joinToString(" ")}")
        assertTrue("the Auth Tab session's callback heard the page load", heard.contains("NAVIGATION_FINISHED"))
        assertTrue("the Auth Tab session's callback heard the tab shown", heard.contains("TAB_SHOWN"))
        assertTrue("the Auth Tab session's callback heard the tab hidden after the return", heard.drop(before).contains("TAB_HIDDEN"))

        // 5. The Auth Tab, dark: the same chrome in the dark scheme; then back out of it.
        showCaller(authTabIntent(dark = true, https = false))
        openAuthTab(SIGNIN_PATH)
        readChrome("dark")
        shot("05-dark")
        beat()
        openMenu()
        readMenu("dark")
        shot("06-menu-dark")
        beat()
        dismissSheet()
        back()
        val cancelled = awaitResult("$RESULT_CANCELED no data")
        note("back: the caller read '${resultLine()}'")
        assertTrue("back out of the Auth Tab read RESULT_CANCELED without data", cancelled)
        SystemClock.sleep(1_000)
        shot("07-result-cancelled")
        beat()

        // 6. The https redirect the caller cannot prove: claimed, never loaded, refused.
        showCaller(authTabIntent(dark = false, https = true))
        openAuthTab(HTTPS_SIGNIN_PATH)
        pressContinue()
        val refused = awaitResult("$RESULT_VERIFICATION_FAILED no data", timeoutMs = 20_000)
        note("https: the caller read '${resultLine()}'")
        assertTrue("an https redirect without the caller's proof read RESULT_VERIFICATION_FAILED without data", refused)
        SystemClock.sleep(1_200)
        shot("08-result-verification-failed")
        beat()

        note("done")
    }

    // --- what is read ----------------------------------------------------------------------------

    /** The Auth Tab's toolbar: the close control and the title; no Minimize, no Share. */
    private fun readChrome(scheme: String) {
        val close = findByLabel(CLOSE_LABEL) != null
        val minimize = findByLabel(MINIMIZE_LABEL) != null
        val share = findByLabel(SHARE_BUTTON_LABEL) != null
        val title = findNode { it == SIGNIN_TITLE } != null
        note("$scheme tab: close=$close minimize=$minimize share=$share title=$title")
        assertTrue("the $scheme Auth Tab has the close control", close)
        assertTrue("the $scheme Auth Tab has no Minimize (Chrome refuses it for an auth tab)", !minimize)
        assertTrue("the $scheme Auth Tab has no Share in the toolbar's slot", !share)
        assertTrue("the $scheme Auth Tab shows the page's title", title)
    }

    /** The menu's rows and icon row under Chrome's Auth Tab rules. */
    private fun readMenu(scheme: String) {
        val present = listOf(COPY_LINK_LABEL, FIND_LABEL, DESKTOP_LABEL, FORWARD_LABEL, INFO_LABEL, RELOAD_LABEL).filter { findNode { t -> t == it } != null }
        val absent = listOf(SHARE_LABEL, ADD_HOME_LABEL, OPEN_IN_ZENIUM_LABEL, BOOKMARK_LABEL, DOWNLOAD_LABEL).filter { findNode { t -> t == it } != null }
        note("$scheme menu: present=$present absent-but-found=$absent")
        assertEquals("the $scheme Auth Tab's menu keeps the page actions", 6, present.size)
        assertTrue("the $scheme Auth Tab's menu has no way out of the tab: $absent", absent.isEmpty())
    }

    // --- the client side -------------------------------------------------------------------------

    /** Bind the provider's Custom Tabs service for its raw binder, as 1.9.0's client does under `CustomTabsClient`. */
    private fun bindService() {
        val latch = CountDownLatch(1)
        val c = object : ServiceConnection {
            override fun onServiceConnected(name: ComponentName, binder: IBinder) {
                service = binder
                latch.countDown()
            }

            override fun onServiceDisconnected(name: ComponentName) {
                service = null
            }
        }
        val intent = Intent(CustomTabsService.ACTION_CUSTOM_TABS_CONNECTION).setPackage(app.packageName)
        assertTrue("bindService(${app.packageName})", app.bindService(intent, c, Context.BIND_AUTO_CREATE or Context.BIND_WAIVE_PRIORITY))
        assertTrue("the Custom Tabs service connected", latch.await(15, TimeUnit.SECONDS))
        connection = c
    }

    /**
     * `ICustomTabsService.newAuthTabSession(callback, extras)` as androidx.browser 1.9.0's proxy
     * writes it: the interface token, the callback binder, a typed bundle (1 and the bundle); the
     * reply a no-exception header and a boolean int.
     */
    private fun newAuthTabSession() {
        val binder = service ?: error("no service binder")
        val data = Parcel.obtain()
        val reply = Parcel.obtain()
        try {
            data.writeInterfaceToken(SERVICE_DESCRIPTOR)
            data.writeStrongBinder(callback)
            data.writeInt(1)
            Bundle().writeToParcel(data, 0)
            assertTrue("newAuthTabSession went through", binder.transact(TRANSACTION_NEW_AUTH_TAB_SESSION, data, reply, 0))
            reply.readException()
            val registered = reply.readInt() != 0
            note("newAuthTabSession: ${if (registered) "true" else "false"}")
            assertTrue("the provider registered the Auth Tab session", registered)
        } finally {
            data.recycle()
            reply.recycle()
        }
    }

    /**
     * What `AuthTabIntent.Builder.build(redirectScheme)` / `build(host, path)` writes: `ACTION_VIEW`,
     * the launch flag, the redirect, the session binder under the custom tab's `EXTRA_SESSION`,
     * the colour scheme – aimed at the provider.
     */
    private fun authTabIntent(dark: Boolean, https: Boolean): Intent {
        val url = if (https) "http://$HOST:$PORT$HTTPS_SIGNIN_PATH" else "http://$HOST:$PORT$SIGNIN_PATH"
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url))
        val extras = Bundle()
        extras.putBinder(CustomTabsIntent.EXTRA_SESSION, callback)
        intent.putExtras(extras)
        intent.putExtra(EXTRA_LAUNCH_AUTH_TAB, true)
        if (https) {
            intent.putExtra(EXTRA_HTTPS_REDIRECT_HOST, HOST)
            intent.putExtra(EXTRA_HTTPS_REDIRECT_PATH, HTTPS_DONE_PATH)
        } else {
            intent.putExtra(EXTRA_REDIRECT_SCHEME, SCHEME)
        }
        intent.putExtra(CustomTabsIntent.EXTRA_COLOR_SCHEME, if (dark) CustomTabsIntent.COLOR_SCHEME_DARK else CustomTabsIntent.COLOR_SCHEME_LIGHT)
        if (!dark) intent.putExtra(CustomTabsIntent.EXTRA_TOOLBAR_COLOR, TOOLBAR)
        intent.setPackage(app.packageName)
        return intent
    }

    // --- the caller ------------------------------------------------------------------------------

    /** Bring Nimbus News up (or forward) holding the Auth Tab intent for its button, to start for a result. */
    private fun showCaller(launch: Intent) {
        val intent = Intent()
            .setClassName(callerPackage, CALLER_ACTIVITY)
            .putExtra(CustomTabCallerActivity.EXTRA_LAUNCH, launch)
            .putExtra(CustomTabCallerActivity.EXTRA_BROWSER, app.packageName)
            .putExtra(CustomTabCallerActivity.EXTRA_FOR_RESULT, true)
            .putExtra(CustomTabCallerActivity.EXTRA_BUTTON, SIGN_IN_LABEL)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        app.startActivity(intent)
        assertTrue("the caller app came up", waitForWindow(callerPackage, 15_000))
        SystemClock.sleep(2_000)
    }

    /** Press the caller's button and wait for the Auth Tab and its page. */
    private fun openAuthTab(path: String) {
        assertTrue("the caller's button is on screen", clickByLabel(SIGN_IN_LABEL))
        assertTrue("the Auth Tab came up", waitForWindow(app.packageName, 15_000))
        assertTrue("the Auth Tab's toolbar is up", waitFor(CLOSE_LABEL, 10_000) != null)
        waitForPath(path)
        SystemClock.sleep(2_000)
    }

    /** The sign-in form's Continue under a finger. */
    private fun pressContinue() {
        val page = customTab()?.page ?: error("no Auth Tab page")
        val point = buttonPoint(page) ?: error("the Continue button's point came back empty")
        Finger().tap(point.x, point.y)
    }

    /** The caller's status line after a result, `Auth result <code> <data>`, once it reads `expected`. */
    private fun awaitResult(expected: String, timeoutMs: Long = 12_000): Boolean {
        val want = CustomTabCallerActivity.RESULT_PREFIX + expected
        val back = waitForWindow(callerPackage, timeoutMs)
        if (!back) {
            Log.w(tag, "the caller never came back; top is ${topPackage()}")
            return false
        }
        return awaitTrue(timeoutMs) { resultLine() == want }
    }

    private fun resultLine(): String? =
        findNodes { it.startsWith(CustomTabCallerActivity.RESULT_PREFIX) }.firstOrNull()?.let { node ->
            node.text?.toString() ?: node.contentDescription?.toString()
        }

    // --- moves -----------------------------------------------------------------------------------

    private fun openMenu() {
        assertTrue("the menu button is on screen", clickByLabel(MENU_LABEL))
        assertTrue("the menu sheet came up", waitFor(FIND_LABEL, 6_000) != null)
        SystemClock.sleep(1_200)
    }

    private fun dismissSheet() {
        if (findByLabel(FIND_LABEL) != null) {
            back()
            SystemClock.sleep(1_200)
        }
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

    private fun customTab(): CustomTabActivity? {
        var found: CustomTabActivity? = null
        instrumentation.runOnMainSync {
            found = ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(Stage.RESUMED).filterIsInstance<CustomTabActivity>().firstOrNull()
        }
        return found
    }

    private fun waitForPath(path: String) {
        val deadline = SystemClock.uptimeMillis() + 20_000
        while (SystemClock.uptimeMillis() < deadline) {
            val page = customTab()?.page
            val state = if (page != null) evalJs(page, "location.pathname + ':' + document.readyState") else null
            if (state == "$path:complete") return
            SystemClock.sleep(400)
        }
        Log.w(tag, "the page never reported $path complete")
    }

    private fun buttonPoint(page: TabWebView): PointF? {
        val text = evalJs(page, BUTTON_POINT_JS) ?: return null
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

    private fun note(line: String) {
        Log.i(tag, line)
        if (::findings.isInitialized) findings.appendText(line + "\n")
    }

    override fun noteLine(line: String) = note(line)

    // --- the pages -------------------------------------------------------------------------------

    private fun routes(): Map<String, Pair<String, ByteArray>> = mapOf(
        SIGNIN_PATH to (HTML to page(APPROVE_PATH).toByteArray()),
        HTTPS_SIGNIN_PATH to (HTML to page(HTTPS_APPROVE_PATH).toByteArray()),
        HTTPS_DONE_PATH to (HTML to "<!doctype html><title>never loaded</title><p>The redirect was loaded, not returned.</p>".toByteArray())
    )

    /** A sign-in form whose Continue POSTs to `action`, which the server answers with a 303 to the redirect. */
    private fun page(action: String): String = """
        <!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
        <title>$SIGNIN_TITLE</title>
        <style>body{margin:0;padding:28px 20px;font:17px/1.5 system-ui,sans-serif;color:#1d1d2c;background:#fff}
        h1{font-size:24px;line-height:1.2;margin:0 0 6px}p{margin:0 0 20px;color:#555}
        label{display:block;font-size:13px;color:#555;margin:14px 0 4px}
        input{width:100%;box-sizing:border-box;padding:12px 14px;border:1px solid #c9cdd6;border-radius:10px;font:inherit}
        button{display:block;width:100%;margin-top:26px;padding:16px;border:0;border-radius:12px;background:#2e5bff;color:#fff;font:inherit;font-weight:600}</style></head>
        <body><h1>Welcome back</h1><p>Sign in with your Nimbus ID to continue to Nimbus News</p>
        <form id="f" method="post" action="$action">
        <label>Email</label><input value="reader@example.com" readonly>
        <label>Password</label><input type="password" value="••••••••" readonly>
        <button id="go" type="submit">Continue</button></form>
        </body></html>
    """.trimIndent()

    companion object {
        private const val CALLER_ACTIVITY = "app.zen.chromium.CustomTabCallerActivity"
        private const val HOST = "127.0.0.1"
        private const val PORT = 8151
        private const val HTML = "text/html; charset=utf-8"
        private const val SIGNIN_PATH = "/signin.html"
        private const val APPROVE_PATH = "/approve"
        private const val HTTPS_SIGNIN_PATH = "/signin-https.html"
        private const val HTTPS_APPROVE_PATH = "/approve-https"
        private const val HTTPS_DONE_PATH = "/auth/done"
        private const val SIGNIN_TITLE = "Sign in to Nimbus ID"
        private const val SCHEME = "zeniumtest"
        private const val TOOLBAR = 0xFF2E5BFF.toInt()

        /** androidx.browser 1.9.0's `AuthTabIntent` extras, by their strings (the test APK carries 1.8.0). */
        private const val EXTRA_LAUNCH_AUTH_TAB = "androidx.browser.auth.extra.LAUNCH_AUTH_TAB"
        private const val EXTRA_REDIRECT_SCHEME = "androidx.browser.auth.extra.REDIRECT_SCHEME"
        private const val EXTRA_HTTPS_REDIRECT_HOST = "androidx.browser.auth.extra.HTTPS_REDIRECT_HOST"
        private const val EXTRA_HTTPS_REDIRECT_PATH = "androidx.browser.auth.extra.HTTPS_REDIRECT_PATH"
        private const val SERVICE_DESCRIPTOR = "android.support.customtabs.ICustomTabsService"
        private const val CALLBACK_DESCRIPTOR = "android.support.customtabs.IAuthTabCallback"
        private const val TRANSACTION_NEW_AUTH_TAB_SESSION = IBinder.FIRST_CALL_TRANSACTION + 17
        private const val TRANSACTION_ON_NAVIGATION_EVENT = IBinder.FIRST_CALL_TRANSACTION + 1
        /** `AuthTabIntent`'s result codes: the platform's two and the verification's two. */
        private const val RESULT_OK = -1
        private const val RESULT_CANCELED = 0
        private const val RESULT_VERIFICATION_FAILED = 2

        private const val SIGN_IN_LABEL = "Sign in"
        private const val CLOSE_LABEL = "Close"
        private const val MINIMIZE_LABEL = "Minimize"
        private const val MENU_LABEL = "Menu"
        private const val SHARE_BUTTON_LABEL = "Share"
        private const val SHARE_LABEL = "Share…"
        private const val COPY_LINK_LABEL = "Copy Link"
        private const val FIND_LABEL = "Find in Page"
        private const val ADD_HOME_LABEL = "Add to Home Screen"
        private const val DESKTOP_LABEL = "Desktop Site"
        private const val OPEN_IN_ZENIUM_LABEL = "Open in Zenium"
        private const val FORWARD_LABEL = "Forward"
        private const val BOOKMARK_LABEL = "Bookmark"
        private const val DOWNLOAD_LABEL = "Download Page"
        private const val INFO_LABEL = "Page Info"
        private const val RELOAD_LABEL = "Reload"

        /** The Continue button's centre in device pixels relative to the WebView. */
        private val BUTTON_POINT_JS = """
            (function () {
              var b = document.getElementById('go');
              if (!b) return null;
              b.scrollIntoView({block: 'center'});
              var vv = window.visualViewport;
              var scale = (vv ? vv.scale : 1) * (window.devicePixelRatio || 1);
              var r = b.getBoundingClientRect();
              return JSON.stringify({
                x: (r.left + r.width / 2 - (vv ? vv.offsetLeft : 0)) * scale,
                y: (r.top + r.height / 2 - (vv ? vv.offsetTop : 0)) * scale
              });
            })()
        """.trimIndent()
    }
}
