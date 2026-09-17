package app.zen.chromium

import android.app.Activity
import android.app.PendingIntent
import android.app.UiAutomation
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Color
import android.net.Uri
import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import android.widget.ImageView
import androidx.browser.customtabs.CustomTabsClient
import androidx.browser.customtabs.CustomTabsIntent
import androidx.browser.customtabs.CustomTabsServiceConnection
import androidx.browser.customtabs.CustomTabsSession
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertNotNull
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * A real external-client launch against Zenium's provider service. It records both colour schemes,
 * navigation back, the native menu, adoption into the main browser, and closing to its caller.
 */
@RunWith(AndroidJUnit4::class)
class CustomTabsDemo {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val app = instrumentation.targetContext
    // Instrumentation's package context has no Application on this runner; the target context
    // still creates a real binder-backed CustomTabsSession against the debug provider.
    private val caller = app.applicationContext
    private val ui: UiAutomation = instrumentation.uiAutomation
    private val out = File(app.filesDir, "custom-tabs-demo")

    @Test
    fun record() {
        out.deleteRecursively()
        out.mkdirs()
        instrumentation.startActivitySync(
            Intent(app, MainActivity::class.java)
                .setAction(Intent.ACTION_MAIN)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
        )
        check(waitFor("Address", 30_000))
        handshake()
        recordScheme("light", CustomTabsIntent.COLOR_SCHEME_LIGHT, Color.rgb(63, 102, 154))
        recordScheme("dark", CustomTabsIntent.COLOR_SCHEME_DARK, Color.rgb(45, 62, 91))
        File(out, "done").writeText("done\n")
        SystemClock.sleep(4_000)
    }

    private fun recordScheme(name: String, scheme: Int, toolbarColor: Int) {
        launchCustomTab(scheme, toolbarColor)
        waitFor("More options", 15_000)
        val activity = currentCustomTab()
        val page = findWebView(activity.window.decorView)
        instrumentation.runOnMainSync {
            page.loadDataWithBaseURL(
                "https://zenium.invalid/$name/one",
                "<html><body><h1>First page</h1></body></html>",
                "text/html",
                "utf-8",
                null
            )
        }
        SystemClock.sleep(1_000)
        instrumentation.runOnMainSync {
            page.loadDataWithBaseURL(
                "https://zenium.invalid/$name/two",
                "<html><body><h1>Second page</h1></body></html>",
                "text/html",
                "utf-8",
                null
            )
        }
        SystemClock.sleep(1_000)
        shot("$name-toolbar")
        ui.performGlobalAction(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_BACK)
        SystemClock.sleep(1_000)
        shot("$name-back")
        click("More options")
        waitFor("Copy Link", 5_000)
        shot("$name-menu")
        click("Open in Zenium")
        waitFor("Address", 15_000)
        shot("$name-open-in-zenium")

        launchCustomTab(scheme, toolbarColor)
        waitFor("Close custom tab", 15_000)
        click("Close custom tab")
        waitFor("Address", 10_000)
        shot("$name-close")
    }

    private fun launchCustomTab(scheme: Int, toolbarColor: Int) {
        val session = bindSession()
        val actionIcon = Bitmap.createBitmap(20, 20, Bitmap.Config.ARGB_8888).apply { eraseColor(Color.WHITE) }
        val pending = PendingIntent.getActivity(
            caller,
            scheme,
            Intent(Intent.ACTION_VIEW, Uri.parse("https://example.com")),
            PendingIntent.FLAG_IMMUTABLE
        )
        val intent = CustomTabsIntent.Builder(session)
            .setColorScheme(scheme)
            .setToolbarColor(toolbarColor)
            .setShowTitle(true)
            .setCloseButtonPosition(CustomTabsIntent.CLOSE_BUTTON_POSITION_END)
            .setActionButton(actionIcon, "Caller action", pending)
            .addMenuItem("Caller Item", pending)
            .enableUrlBarHiding()
            .build()
            .intent
            .setData(Uri.parse("https://example.com"))
            .setPackage(app.packageName)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        caller.startActivity(intent)
    }

    private fun bindSession(): CustomTabsSession {
        val connected = CountDownLatch(1)
        var session: CustomTabsSession? = null
        val connection = object : CustomTabsServiceConnection() {
            override fun onCustomTabsServiceConnected(name: android.content.ComponentName, client: CustomTabsClient) {
                client.warmup(0)
                session = client.newSession(null)
                connected.countDown()
            }

            override fun onServiceDisconnected(name: android.content.ComponentName) = Unit
        }
        assertNotNull("Zenium must expose a Custom Tabs provider", connection)
        check(CustomTabsClient.bindCustomTabsService(caller, app.packageName, connection))
        check(connected.await(5, TimeUnit.SECONDS))
        return checkNotNull(session)
    }

    private fun currentCustomTab(): CustomTabActivity {
        val deadline = SystemClock.uptimeMillis() + 10_000
        while (SystemClock.uptimeMillis() < deadline) {
            val activities = androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry.getInstance()
                .getActivitiesInStage(androidx.test.runner.lifecycle.Stage.RESUMED)
            activities.filterIsInstance<CustomTabActivity>().firstOrNull()?.let { return it }
            SystemClock.sleep(100)
        }
        error("CustomTabActivity did not resume")
    }

    private fun findWebView(view: View): WebView {
        if (view is WebView) return view
        if (view is ViewGroup) {
            for (index in 0 until view.childCount) {
                runCatching { return findWebView(view.getChildAt(index)) }
            }
        }
        error("Custom tab page WebView was not found")
    }

    private fun handshake() {
        File(out, "record").writeText("ready\n")
        val deadline = SystemClock.uptimeMillis() + 30_000
        while (!File(out, "recording").exists() && SystemClock.uptimeMillis() < deadline) SystemClock.sleep(200)
        SystemClock.sleep(1_000)
    }

    private fun shot(name: String) {
        val bitmap = ui.takeScreenshot() ?: return
        File(out, "android-customtabs-design-$name.png").outputStream().use {
            bitmap.compress(Bitmap.CompressFormat.PNG, 100, it)
        }
        bitmap.recycle()
    }

    private fun waitFor(label: String, timeoutMs: Long): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (node(label) != null) return true
            SystemClock.sleep(100)
        }
        return false
    }

    private fun click(label: String) {
        var found = node(label) ?: error("$label was not visible")
        while (!found.isClickable) found = found.parent ?: error("$label had no clickable parent")
        check(found.performAction(android.view.accessibility.AccessibilityNodeInfo.ACTION_CLICK))
    }

    private fun node(label: String): android.view.accessibility.AccessibilityNodeInfo? {
        val root = ui.rootInActiveWindow ?: return null
        val queue = ArrayDeque<android.view.accessibility.AccessibilityNodeInfo>()
        queue.add(root)
        while (queue.isNotEmpty()) {
            val current = queue.removeFirst()
            if (current.contentDescription?.toString() == label || current.text?.toString() == label) return current
            for (index in 0 until current.childCount) current.getChild(index)?.let(queue::add)
        }
        return null
    }
}
