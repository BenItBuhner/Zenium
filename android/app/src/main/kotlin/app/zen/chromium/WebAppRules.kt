package app.zen.chromium

import java.net.URI

/**
 * The rules of an installed web app's window (PWA-07), pure so they have a JVM test: which
 * display mode a manifest word names and how it shows on a phone, whether a URL is inside the
 * app's scope, the task each app lives in, and the display-mode answer the page's `matchMedia`
 * gives inside the window.
 *
 * Chrome's poses, read from chromium main (`WebappIntentDataProvider`, `WebappVerifier`,
 * `CustomTabDelegateFactory.getDisplayMode`, `WebappLauncherActivity`): `minimal-ui` on a phone
 * shows no toolbar and reports `standalone` to the page (`WebappDisplayModeTest.testMinimalUi`
 * asserts the toolbar hidden; the minimal-ui header exists only for WebAPKs on Android 15 desktop
 * windowing); `fullscreen` is the same window with the system bars hidden; a page outside the
 * manifest scope gets the browser's controls and reads as `browser`.
 */
object WebAppRules {
    /** The manifest's `display` as the install stored it; `browser` for anything else. */
    enum class Display(val manifestWord: String) {
        FULLSCREEN("fullscreen"),
        STANDALONE("standalone"),
        MINIMAL_UI("minimal-ui"),
        BROWSER("browser");

        companion object {
            fun parse(word: String?): Display = entries.firstOrNull { it.manifestWord == word?.trim()?.lowercase() } ?: BROWSER
        }
    }

    /** Whether an app of this display mode opens in a window of its own rather than a tab. */
    fun ownWindow(display: Display): Boolean = display != Display.BROWSER

    /** Whether the window hides the system bars (`display: fullscreen`, Chrome's `ImmersiveMode`). */
    fun immersive(display: Display): Boolean = display == Display.FULLSCREEN

    /**
     * The W3C rule the core applies too (`shared/webApp.ts` `isWithinScope`): same origin and a
     * path that starts with the scope's. A URL that does not parse is outside every scope.
     */
    fun inScope(url: String?, scope: String): Boolean {
        val u = parse(url) ?: return false
        val s = parse(scope) ?: return false
        if (!originOf(u).equals(originOf(s), ignoreCase = true)) return false
        return (u.rawPath.ifEmpty { "/" }).startsWith(s.rawPath.ifEmpty { "/" })
    }

    /**
     * The mode the page's `matchMedia('(display-mode: …)')` should answer, as Chrome's
     * `CustomTabDelegateFactory.getDisplayMode`: `fullscreen` while the bars are hidden,
     * `browser` on a page out of scope (the browser's controls are up), `standalone` for a
     * `minimal-ui` whose controls are not rendered (a phone), else the manifest's word.
     */
    fun reportedDisplay(display: Display, inScope: Boolean, barsHidden: Boolean): Display = when {
        !inScope -> Display.BROWSER
        barsHidden -> Display.FULLSCREEN
        display == Display.MINIMAL_UI -> Display.STANDALONE
        else -> display
    }

    /**
     * The intent `data` that names an app's task: `documentLaunchMode="intoExisting"` reuses the
     * task whose root intent has the same data, so one launch per app lands in one task (Chrome's
     * `webapp://<id>`, `WebappLauncherActivity`). The shortcut id, not the app id, since manifest
     * ids are URLs and the launcher already stores the hashed form.
     */
    fun taskUri(shortcutId: String): String = "$TASK_SCHEME://$shortcutId"

    /**
     * The document-start script that makes `window.matchMedia('(display-mode: …)')` answer the
     * app's mode (`__zenDisplayMode`, kept current by the window through [displayModeUpdate]):
     * queries naming `display-mode` get a list of their own whose `matches`, listeners and
     * `onchange` follow the mode; every other query is the platform's. Only the JS API is
     * covered: stylesheet `@media (display-mode: …)` rules still see the WebView's own answer.
     */
    fun displayModeScript(initial: Display): String = """
        (function () {
          if (window.__zenDisplayModeInstalled) return;
          window.__zenDisplayModeInstalled = true;
          window.__zenDisplayMode = '${initial.manifestWord}';
          var native = window.matchMedia.bind(window);
          var lists = [];
          function current(mode) { return window.__zenDisplayMode === mode; }
          window.matchMedia = function (query) {
            var q = String(query);
            var m = /\(\s*display-mode\s*:\s*([a-z-]+)\s*\)/i.exec(q);
            if (!m) return native(q);
            var mode = m[1].toLowerCase();
            var listeners = [];
            var list = {
              media: q,
              matches: current(mode),
              onchange: null,
              addListener: function (fn) { if (fn) listeners.push(fn); },
              removeListener: function (fn) { listeners = listeners.filter(function (l) { return l !== fn; }); },
              addEventListener: function (type, fn) { if (type === 'change' && fn) listeners.push(fn); },
              removeEventListener: function (type, fn) { if (type === 'change') listeners = listeners.filter(function (l) { return l !== fn; }); },
              dispatchEvent: function () { return true; }
            };
            list.__zenUpdate = function () {
              var now = current(mode);
              if (now === list.matches) return;
              list.matches = now;
              var event = { type: 'change', media: q, matches: now, target: list, currentTarget: list };
              if (typeof list.onchange === 'function') { try { list.onchange(event); } catch (e) {} }
              listeners.slice().forEach(function (fn) {
                try { if (typeof fn === 'function') fn(event); else if (fn && typeof fn.handleEvent === 'function') fn.handleEvent(event); } catch (e) {}
              });
            };
            lists.push(list);
            return list;
          };
          window.__zenSetDisplayMode = function (mode) {
            if (window.__zenDisplayMode === mode) return;
            window.__zenDisplayMode = mode;
            lists.slice().forEach(function (l) { l.__zenUpdate(); });
          };
        })();
    """.trimIndent()

    /** The statement that tells a live page its mode changed (a scope crossing, the bars hidden). */
    fun displayModeUpdate(display: Display): String =
        "window.__zenSetDisplayMode && window.__zenSetDisplayMode('${display.manifestWord}');"

    private fun parse(url: String?): URI? = runCatching { URI(url ?: return null) }.getOrNull()?.takeIf { it.scheme != null && it.host != null }

    private fun originOf(uri: URI): String {
        val scheme = uri.scheme.lowercase()
        val port = when {
            uri.port == -1 -> ""
            scheme == "https" && uri.port == 443 -> ""
            scheme == "http" && uri.port == 80 -> ""
            else -> ":" + uri.port
        }
        return "$scheme://${uri.host.lowercase()}$port"
    }

    const val TASK_SCHEME = "zen-webapp"
}
