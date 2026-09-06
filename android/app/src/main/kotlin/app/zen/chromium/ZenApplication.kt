package app.zen.chromium

import android.app.Application
import android.webkit.WebView

class ZenApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        // Debug builds can be inspected from desktop Chrome (chrome://inspect) – the chrome WebView
        // shows the browser core's console, each tab WebView the page.
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
    }
}
