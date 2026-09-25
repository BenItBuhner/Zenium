package app.zen.chromium

import android.app.Application
import android.util.Log
import android.webkit.WebView
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewOutcomeReceiver
import androidx.webkit.WebViewStartUpConfig
import androidx.webkit.WebViewStartUpResult
import androidx.webkit.WebViewStartupException
import java.util.concurrent.Executors

class ZenApplication : Application() {
    @androidx.annotation.OptIn(WebViewCompat.ExperimentalAsyncStartUp::class)
    override fun onCreate() {
        super.onCreate()
        // WebView's start-up, asynchronously (OS-27): the provider's loading – its APK's class
        // loader and native library, the part of Chromium's browser-process start that needs no
        // UI thread – on a thread of its own, from here, while the icon's trampoline and the
        // activity's own creation go on; the UI-thread part follows as posted tasks. Before this
        // the first static WebView call (now inside onResult) did the whole of it, synchronously,
        // here on the main thread. Two paths lie behind the one call: the provider's own
        // asynchronous start-up where the installed WebView has it, which accounts for the UI
        // thread's share (`webviewUi`, `webviewTask` on the boot marks line: the total and the
        // longest task, ms), and the library's fallback for a provider without it, which returns
        // no accounting – the `webview start-up:` line names the path that ran.
        val config = WebViewStartUpConfig.Builder(Executors.newSingleThreadExecutor { r -> Thread(r, "zen-webview-startup") })
            .setShouldRunUiThreadStartUpTasks(true)
            .build()
        WebViewCompat.startUpWebView(this, config, object : WebViewOutcomeReceiver<WebViewStartUpResult, WebViewStartupException> {
            override fun onResult(result: WebViewStartUpResult) {
                // Debug builds can be inspected from desktop Chrome (chrome://inspect) – the
                // chrome WebView shows the browser core's console, each tab WebView the page.
                // The flag is global and takes effect on views already made.
                WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
                val ui = result.totalTimeInUiThreadMillis
                val task = result.maxTimePerTaskInUiThreadMillis
                ui?.let { BootMarks.note("webviewUi", it) }
                task?.let { BootMarks.note("webviewTask", it) }
                Log.i(
                    StartupSplash.TAG,
                    if (ui != null) "webview start-up: the provider's asynchronous start-up (ui $ui ms, longest task ${task ?: "-"} ms)"
                    else "webview start-up: the library's fallback (the provider has no asynchronous start-up; no UI-thread accounting)"
                )
                val blocking = result.uiThreadBlockingStartUpLocations
                if (!blocking.isNullOrEmpty()) {
                    // Something started WebView on the UI thread before this finished: where from.
                    Log.w(StartupSplash.TAG, "webview started up on the UI thread ahead of the async start-up, ${blocking.size} time(s)", blocking[0].stackInformation)
                }
            }

            override fun onError(error: WebViewStartupException) {
                // No WebView to start (none installed, or disabled): the first view's constructor
                // will say so, as before; the debug flag is set all the same.
                Log.w(StartupSplash.TAG, "webview start-up failed", error)
                runCatching { WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG) }
            }
        })
        BootMarks.mark("app")
    }
}
