package app.zen.chromium

import android.accessibilityservice.AccessibilityService
import android.app.KeyguardManager
import android.app.Notification
import android.app.NotificationManager
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.PointF
import android.graphics.Rect
import android.media.AudioManager
import android.os.Build
import android.os.ParcelFileDescriptor
import android.os.PowerManager
import android.os.SystemClock
import android.provider.Settings
import android.service.notification.StatusBarNotification
import android.support.v4.media.MediaMetadataCompat
import android.util.Log
import android.view.InputDevice
import android.view.KeyCharacterMap
import android.view.KeyEvent
import android.view.WindowManager
import android.view.accessibility.AccessibilityNodeInfo
import android.webkit.WebView
import org.json.JSONObject
import org.json.JSONTokener
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.math.PI
import kotlin.math.pow
import kotlin.math.sin


/**
 * What the media demos share – the engine's ([MediaDemo]) and the in-app controls' ([MediaUiDemo]):
 * the loopback [DemoServer] with the demo page at four paths and the generated fixtures (the
 * two-minute track, the artwork, the WebM clip from the assets), the page read through its title
 * (`MD|kind:audio|state:playing|t:12|last:nexttrack`, which the driver takes from the core's
 * state), real fingers on a page's button, on a node in any window (the shade, the lock screen,
 * the picture-in-picture menu), the system's word on the notification, the session and the
 * audio focus, the app brought to the front through the shell, and the notes file next to the
 * stills. Every touch a step injects has an assertion on what it did (the rule in [DemoHarness]).
 */
abstract class MediaDemoBase(private val shotPrefix: String) : DemoHarness("media-demo-state.json", shotPrefix, "media-demo") {
    protected lateinit var server: DemoServer
    protected lateinit var notes: File
    protected val notificationManager: NotificationManager by lazy { app.getSystemService(NotificationManager::class.java) }
    protected val audioManager: AudioManager by lazy { app.getSystemService(AudioManager::class.java) }
    protected val host: Host get() = (activity as MainActivity).host

    /** The demo with the page server up around it: what each driver's `@Test` runs. */
    protected fun recordWithServer() {
        val page = "text/html; charset=utf-8" to readAsset("media-demo-page.html").toByteArray()
        server = DemoServer(
            PORT,
            mapOf(
                "/audio" to page,
                "/video" to page,
                "/notify" to page,
                "/private" to page,
                "/tone.wav" to ("audio/wav" to tone()),
                "/clip.webm" to ("video/webm" to readAssetBytes("media-demo-clip.webm")),
                "/art.png" to ("image/png" to art())
            )
        ).also { it.start() }
        try {
            runDemo()
        } finally {
            server.close()
        }
    }

    override fun warmUp() {
        notes = File(out, "$shotPrefix-notes.txt")
        notes.writeText("Zenium Android media demo ($shotPrefix)\n\n")
        note("demo server: ${server.selfCheck()}")
        val webView = runCatching { WebView.getCurrentWebViewPackage()?.let { "${it.packageName} ${it.versionName}" } }.getOrNull()
        note("webview: ${webView ?: "unknown"}; sdk ${Build.VERSION.SDK_INT}")
        note("profiles (WebViewFeature.MULTI_PROFILE): ${Profiles.supported}; picture-in-picture feature: ${host.media.pictureInPictureSupported}")
        val caps = coreState().getJSONObject("capabilities")
        note("capabilities: pictureInPicture=${caps.optBoolean("pictureInPicture")} privateTabs=${caps.optBoolean("privateTabs")}")
        note("notifications enabled: ${notificationManager.areNotificationsEnabled()}")
        waitTitle(TAB, 20_000) { it.startsWith("MD|") }
        note("seeded tab: ${describeTab(TAB)}")
        Log.i(tag, "warm-up done")
    }

    /** The track playing before a step that needs it so (a media key when it is not: the session's own route). */
    protected fun ensurePlaying() {
        if (field("state") == "playing") return
        mediaKeyExpecting(KeyEvent.KEYCODE_MEDIA_PLAY, "plays the page for the step") { field("state") == "playing" }
    }

    /** `adb shell` from inside the instrumentation (UiAutomation's shell): the command's output. */
    protected fun shell(command: String): String = runCatching {
        val fd = ui.executeShellCommand(command)
        ParcelFileDescriptor.AutoCloseInputStream(fd).use { it.readBytes().toString(Charsets.UTF_8) }
    }.getOrElse { "shell failed: $it" }

    /**
     * Who holds the system's audio focus, from `dumpsys audio`'s focus stack: the engine's
     * `AudioFocusDelegate` while a page plays (with its usage), nothing once the media stops.
     */
    protected fun audioFocus(): String {
        val dump = shell("dumpsys audio")
        val start = dump.indexOf("Audio Focus stack entries")
        if (start < 0) return "no focus stack in dumpsys audio"
        val entries = dump.substring(start).lineSequence().drop(1).takeWhile { it.isNotBlank() }
            .map { line ->
                val pack = Regex("pack: (\\S+)").find(line)?.groupValues?.get(1) ?: "?"
                val client = Regex("client: (\\S+)").find(line)?.groupValues?.get(1)?.let(::focusClient) ?: "?"
                val gain = Regex("gain: (\\S+)").find(line)?.groupValues?.get(1) ?: "?"
                val usage = Regex("usage=(\\S+)").find(line)?.groupValues?.get(1) ?: "?"
                "$pack $client $gain $usage"
            }.toList()
        return if (entries.isEmpty()) "held by nobody" else "held by ${entries.joinToString("; ")}"
    }

    /** The listener's class out of a focus client id (`android.media.AudioManager@<hex><listener class>@<hex>`). */
    protected fun focusClient(token: String): String {
        val parts = token.split('@')
        if (parts.size < 3) return token
        val glued = parts[parts.size - 2]
        val dot = glued.indexOf('.')
        if (dot < 0) return glued
        var from = dot
        while (from > 0 && glued[from - 1].isLetter()) from--
        return glued.substring(from)
    }

    /** A swipe up on the (insecure) keyguard; the activity asks for its dismissal when the swipe did not take. */
    protected fun unlock(keyguard: KeyguardManager) {
        Finger().apply {
            down(width / 2f, height * 0.85f)
            moveBy(0f, -height * 0.6f, 260)
            up()
        }
        if (poll(6_000) { !keyguard.isKeyguardLocked }) {
            note("  unlocked with a swipe")
            return
        }
        val latch = CountDownLatch(1)
        instrumentation.runOnMainSync {
            keyguard.requestDismissKeyguard(activity, object : KeyguardManager.KeyguardDismissCallback() {
                override fun onDismissSucceeded() = latch.countDown()
                override fun onDismissCancelled() = latch.countDown()
                override fun onDismissError() = latch.countDown()
            })
        }
        latch.await(8, TimeUnit.SECONDS)
        note("  unlocked through requestDismissKeyguard: locked=${keyguard.isKeyguardLocked}")
    }

    // --- the page -------------------------------------------------------------------------------

    /** The demo tab's title as the core has it ("" when the tab is gone). */
    protected fun title(tabId: String = TAB): String =
        coreState().getJSONObject("tabs").optJSONObject(tabId)?.optString("title").orEmpty()

    /** The `key:value` field of the page's title, or null. */
    protected fun field(key: String, tabId: String = TAB): String? =
        title(tabId).split('|').firstOrNull { it.startsWith("$key:") }?.substringAfter(':')

    protected fun describeTab(tabId: String): String {
        val tab = coreState().getJSONObject("tabs").optJSONObject(tabId) ?: return "tab $tabId gone"
        return "tab $tabId containerId=${tab.optString("containerId")} url=${tab.optString("url")} title=\"${tab.optString("title")}\""
    }

    /** Poll the tab's title until `accept`s it (and the tab is not loading); the title then, or the last seen. */
    protected fun waitTitle(tabId: String, timeoutMs: Long, accept: (String) -> Boolean): String {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        var last = ""
        while (SystemClock.uptimeMillis() < deadline) {
            val tab = coreState().getJSONObject("tabs").optJSONObject(tabId)
            last = tab?.optString("title").orEmpty()
            if (tab != null && accept(last) && !tab.optBoolean("loading")) {
                SystemClock.sleep(600)
                return last
            }
            SystemClock.sleep(400)
        }
        Log.w(tag, "the title of $tabId never satisfied the wait; last \"$last\"")
        return last
    }

    /** The core's media entry for the tab (`UIState.media`), or null. */
    protected fun mediaState(tabId: String): JSONObject? {
        val media = coreState().optJSONArray("media") ?: return null
        for (i in 0 until media.length()) {
            val entry = media.getJSONObject(i)
            if (entry.optString("tabId") == tabId) return entry
        }
        return null
    }

    protected fun prompt(): JSONObject? {
        val prompts = coreState().getJSONArray("permissionPrompts")
        for (i in 0 until prompts.length()) {
            val p = prompts.getJSONObject(i)
            if (p.optString("tabId") == TAB) return p
        }
        return null
    }

    protected fun privateTabs(): List<String> {
        val tabs = coreState().getJSONObject("tabs")
        return tabs.keys().asSequence().filter { tabs.getJSONObject(it).optString("containerId") == Profiles.PRIVATE_CONTAINER }.toList()
    }

    protected fun newPrivateTab(url: String): String? {
        val result = coreInvoke("tab.newPrivate", """{"url":"$url"}""")
        if (result == "null") return null
        val id = (JSONTokener(result).nextValue() as? String) ?: return null
        note("  tab.newPrivate -> $id containerId=${coreState().getJSONObject("tabs").optJSONObject(id)?.optString("containerId")}")
        return id
    }

    /** Evaluate in the demo tab's page; the raw JSON-encoded result ("" when it never answered). */
    protected fun pageJs(code: String, tabId: String = TAB): String {
        var result = ""
        val latch = CountDownLatch(1)
        instrumentation.runOnMainSync {
            val view = host.tabs.get(tabId)
            if (view == null) latch.countDown()
            else view.evaluateJavascript(code) { value ->
                result = value ?: ""
                latch.countDown()
            }
        }
        latch.await(10, TimeUnit.SECONDS)
        return result
    }

    /** Where the page's element `id` is on screen (its CSS box scaled to the view, offset by the view), or null. */
    protected fun pageElementRect(id: String, tabId: String = TAB): Rect? {
        val raw = pageJs("(function(){var e=document.getElementById(${JSONObject.quote(id)});if(!e)return null;var r=e.getBoundingClientRect();return JSON.stringify({x:r.left,y:r.top,w:r.width,h:r.height})})()", tabId)
        // "" is a page that did not answer (no view for the tab yet after a relaunch, or a renderer
        // that never replied): no element to touch, not a syntax error.
        if (raw.isEmpty()) return null
        val json = (JSONTokener(raw).nextValue() as? String)?.let { runCatching { JSONObject(it) }.getOrNull() } ?: return null
        var origin: IntArray? = null
        var scale = 0f
        instrumentation.runOnMainSync {
            val view = host.tabs.get(tabId) ?: return@runOnMainSync
            origin = IntArray(2).also { view.getLocationOnScreen(it) }
            @Suppress("DEPRECATION")
            scale = view.scale
        }
        val at = origin ?: return null
        if (scale <= 0f) scale = density
        return Rect(
            (at[0] + json.getDouble("x") * scale).toInt(),
            (at[1] + json.getDouble("y") * scale).toInt(),
            (at[0] + (json.getDouble("x") + json.getDouble("w")) * scale).toInt(),
            (at[1] + (json.getDouble("y") + json.getDouble("h")) * scale).toInt()
        )
    }

    /**
     * A real finger on the page's button `id` (labelled `label`), then up to `timeoutMs` for
     * `took` – the step's claim, named by `effect`. The element's own box on screen leads (its
     * `getBoundingClientRect` scaled into the view): the WebView's accessibility node for a page
     * button reports stale or offset bounds on the emulator's WebView, so it is only the fallback
     * when the page has no such element. A touch that went in and did nothing is a touch fault;
     * the recording goes on. A finger is a user gesture, so a play behind
     * `mediaPlaybackRequiresUserGesture` starts here.
     */
    protected fun tapPageButton(id: String, label: String, effect: String, timeoutMs: Long, took: () -> Boolean): Boolean {
        var point = pageElementRect(id)?.let { touchPoint(it) }?.also { Finger().tap(it.x, it.y) }
        if (point == null) {
            val node = awaitNode(4_000) { it == label } ?: run {
                note("  no '$label' to touch: the page has no element '$id' and nothing in the tree reads it")
                return false
            }
            point = touchTapPoint(node) ?: run {
                note("  '$label' has no bounds a finger can reach")
                return false
            }
        }
        if (poll(timeoutMs, took)) {
            note("  finger on '$label' at ${point.x.toInt()},${point.y.toInt()}: $effect")
            return true
        }
        touchFault("a touch on the page's '$label' did not take: not $effect within $timeoutMs ms (page: ${title()})")
        note("  TOUCH FAULT: '$label' did not $effect (page: ${title()})")
        return false
    }

    // --- notifications and the shade ------------------------------------------------------------

    protected fun activeNotification(id: Int, match: (StatusBarNotification) -> Boolean = { true }): StatusBarNotification? =
        runCatching { notificationManager.activeNotifications.firstOrNull { it.id == id && match(it) } }.getOrNull()

    protected fun awaitNotification(id: Int, timeoutMs: Long, match: (StatusBarNotification) -> Boolean = { true }): StatusBarNotification? {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            activeNotification(id, match)?.let { return it }
            SystemClock.sleep(250)
        }
        return null
    }

    protected fun describe(sbn: StatusBarNotification?): String {
        if (sbn == null) return "none"
        val n = sbn.notification
        val extras = n.extras
        val actions = n.actions?.map { it.title?.toString() ?: "?" } ?: emptyList()
        return "id=${sbn.id} tag=${sbn.tag} channel=${n.channelId} title=\"${extras.getCharSequence(Notification.EXTRA_TITLE)}\" " +
            "text=\"${extras.getCharSequence(Notification.EXTRA_TEXT)}\" actions=$actions ongoing=${n.flags and Notification.FLAG_ONGOING_EVENT != 0} " +
            "foregroundService=${n.flags and Notification.FLAG_FOREGROUND_SERVICE != 0} mediaSession=${extras.containsKey(Notification.EXTRA_MEDIA_SESSION)} " +
            "largeIcon=${n.getLargeIcon() != null}"
    }

    /** The session as the system sees it (through the session's own controller). */
    protected fun describeSession(): String = runCatching {
        val controller = host.media.controller
        val state = controller.playbackState
        val metadata = controller.metadata
        "state=${state?.state} position=${state?.position} rate=${state?.playbackSpeed} actions=0x${state?.actions?.toString(16)} " +
            "custom=${state?.customActions?.map { it.name }} title=\"${metadata?.getString(MediaMetadataCompat.METADATA_KEY_TITLE)}\" " +
            "artist=\"${metadata?.getString(MediaMetadataCompat.METADATA_KEY_ARTIST)}\" album=\"${metadata?.getString(MediaMetadataCompat.METADATA_KEY_ALBUM)}\" " +
            "duration=${metadata?.getLong(MediaMetadataCompat.METADATA_KEY_DURATION)} art=${metadata?.getBitmap(MediaMetadataCompat.METADATA_KEY_ALBUM_ART) != null} " +
            "active=${controller.sessionToken != null}"
    }.getOrElse { "unreadable: $it" }

    protected fun sessionTitle(): String =
        runCatching { host.media.controller.metadata?.getString(MediaMetadataCompat.METADATA_KEY_TITLE) }.getOrNull().orEmpty()

    /** Pull the shade down and wait for a node in any window whose label `matches`. */
    protected fun openShade(timeoutMs: Long = 10_000, matches: (String) -> Boolean): Boolean {
        ui.performGlobalAction(AccessibilityService.GLOBAL_ACTION_NOTIFICATIONS)
        val node = awaitInWindows(timeoutMs, matches)
        if (node == null) {
            note("  the shade showed nothing that was looked for within $timeoutMs ms")
            dumpWindows("shade")
        }
        return node != null
    }

    protected fun closeShade() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            ui.performGlobalAction(AccessibilityService.GLOBAL_ACTION_DISMISS_NOTIFICATION_SHADE)
        } else {
            back()
        }
        SystemClock.sleep(1_500)
        ensureForeground()
    }

    /** Poll up to `timeoutMs` for a node in any window on screen whose label or text `matches`. */
    protected fun awaitInWindows(timeoutMs: Long, matches: (String) -> Boolean): AccessibilityNodeInfo? {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            findInWindows(matches)?.let { return it }
            SystemClock.sleep(250)
        }
        return null
    }

    /**
     * A real touch on the node in any window reading `label` (or whose label `matches`), then
     * up to `timeoutMs` for `took` – the step's claim, named by `effect`. The shape of a step on
     * the shade, the lock screen or the picture-in-picture menu: false and a touch fault when the
     * touch went in and nothing came of it; false and a note when there was nothing to touch.
     */
    protected fun touchInWindows(
        label: String,
        effect: String,
        timeoutMs: Long = 8_000,
        matches: (String) -> Boolean = { it == label },
        took: () -> Boolean
    ): Boolean {
        val node = awaitInWindows(6_000, matches) ?: run {
            note("  nothing in any window reads '$label'")
            dumpWindows("looking for '$label'")
            return false
        }
        val point = touchTapPoint(node) ?: run {
            note("  '$label' has no bounds a finger can reach")
            return false
        }
        if (poll(timeoutMs, took)) {
            note("  finger on '$label' at ${point.x.toInt()},${point.y.toInt()}: $effect")
            return true
        }
        touchFault("a touch on '$label' did not take: not $effect within $timeoutMs ms")
        note("  TOUCH FAULT: '$label' did not $effect (page: ${title()})")
        return false
    }

    protected fun label(node: AccessibilityNodeInfo): String = (node.contentDescription ?: node.text)?.toString().orEmpty()

    protected fun bounds(node: AccessibilityNodeInfo): Rect = Rect().also { node.getBoundsInScreen(it) }

    /** The labels on screen, window by window, into the notes (what the tree really says when a label is not found). */
    protected fun dumpWindows(why: String) {
        val lines = ArrayList<String>()
        for (window in ui.windows) {
            val root = window.root ?: continue
            val labels = ArrayList<String>()
            val queue = ArrayDeque<AccessibilityNodeInfo>()
            queue.add(root)
            var visited = 0
            while (queue.isNotEmpty() && visited < 1_500 && labels.size < 40) {
                val node = queue.removeFirst()
                visited++
                val text = (node.contentDescription ?: node.text)?.toString()?.trim()
                if (!text.isNullOrEmpty()) labels += text.take(60)
                for (i in 0 until node.childCount) node.getChild(i)?.let(queue::add)
            }
            lines += "    window type=${window.type} pkg=${root.packageName} pip=${window.isInPictureInPictureMode} labels=$labels"
        }
        note("  windows ($why):\n${lines.joinToString("\n")}")
    }

    // --- keys, picture-in-picture, the window ---------------------------------------------------

    /** A key press (down and up) through the input pipeline, the way `adb shell input keyevent` sends one. */
    protected fun key(keyCode: Int) {
        val downTime = SystemClock.uptimeMillis()
        for (action in intArrayOf(KeyEvent.ACTION_DOWN, KeyEvent.ACTION_UP)) {
            val event = KeyEvent(
                downTime, SystemClock.uptimeMillis(), action, keyCode, 0, 0,
                KeyCharacterMap.VIRTUAL_KEYBOARD, 0, KeyEvent.FLAG_FROM_SYSTEM, InputDevice.SOURCE_KEYBOARD
            )
            ui.injectInputEvent(event, true)
        }
    }

    /**
     * A media button (a headset's, a keyboard's) pressed: through the input pipeline first, the
     * way a wired headset's reaches the app, and when that did not take, through
     * `AudioManager.dispatchMediaKeyEvent`, the route a Bluetooth headset's takes into the
     * session service. Neither doing what the step claims fails the run.
     */
    protected fun mediaKeyExpecting(keyCode: Int, effect: String, took: () -> Boolean) {
        val name = KeyEvent.keyCodeToString(keyCode)
        key(keyCode)
        if (poll(5_000, took)) {
            note("    $name $effect (through the input pipeline)")
            return
        }
        val downTime = SystemClock.uptimeMillis()
        audioManager.dispatchMediaKeyEvent(KeyEvent(downTime, downTime, KeyEvent.ACTION_DOWN, keyCode, 0))
        audioManager.dispatchMediaKeyEvent(KeyEvent(downTime, SystemClock.uptimeMillis(), KeyEvent.ACTION_UP, keyCode, 0))
        if (poll(5_000, took)) {
            note("    $name $effect (through AudioManager.dispatchMediaKeyEvent; the injected key alone did not reach the session)")
            return
        }
        touchFault("the media key $name did not take: not $effect (page: ${title()})")
        note("    FAULT: $name did not $effect (page: ${title()})")
    }

    protected fun inPip(): Boolean {
        var value = false
        instrumentation.runOnMainSync { value = activity.isInPictureInPictureMode }
        return value
    }

    protected fun awaitPip(active: Boolean, timeoutMs: Long): Boolean = poll(timeoutMs) { inPip() == active }

    /**
     * The small window's menu (SystemUI's, over the window: the actions, Close and the expand
     * button) under a finger's tap on the window, and the node reading `label` in it. The menu
     * hides itself 3.5 seconds after it shows, so the look is at SystemUI's windows alone, every
     * 100 ms – the second run walked the app's own WebView tree first, a binder call a node, and
     * the menu had gone by the time the walk reached it – and the tap is tried twice; the windows
     * on screen go to the notes when the menu never showed the label.
     */
    protected fun openPipMenu(win: Rect, label: String): AccessibilityNodeInfo? {
        for (attempt in 1..2) {
            Finger().tap(win.exactCenterX(), win.exactCenterY())
            val deadline = SystemClock.uptimeMillis() + 3_000
            while (SystemClock.uptimeMillis() < deadline) {
                findInWindows(SYSTEM_UI) { it == label }?.let { return it }
                SystemClock.sleep(100)
            }
            if (attempt == 1) {
                dumpWindows("pip menu after tap $attempt, looking for '$label'")
                SystemClock.sleep(4_000)
            }
        }
        return null
    }

    /**
     * A real finger on the small window's menu button `label` (the menu opened by [openPipMenu]
     * and the button touched at once, before the menu hides itself), then up to `timeoutMs` for
     * `took`, the step's claim named by `effect`; `shotAfter` names a still of the menu right
     * after the touch – a touch keeps it up two more seconds, so the still shows the menu with
     * the button's new state, and no still comes between finding the button and touching it.
     */
    protected fun touchPipMenu(win: Rect, label: String, effect: String, timeoutMs: Long = 8_000, shotAfter: String? = null, took: () -> Boolean): Boolean {
        val node = openPipMenu(win, label) ?: run {
            note("  the small window's menu never showed '$label' (two taps on the window)")
            touchFault("the picture-in-picture window's menu never showed '$label'")
            return false
        }
        note("  pip menu: '$label' at ${bounds(node)}")
        val point = touchTapPoint(node) ?: run {
            note("  '$label' has no bounds a finger can reach")
            return false
        }
        if (shotAfter != null) shot(shotAfter)
        if (poll(timeoutMs, took)) {
            note("  finger on the small window's '$label' at ${point.x.toInt()},${point.y.toInt()}: $effect")
            return true
        }
        touchFault("a touch on the small window's '$label' did not take: not $effect within $timeoutMs ms")
        note("  TOUCH FAULT: the small window's '$label' did not $effect (page: ${title()})")
        return false
    }

    /** The app's window on screen (the small one while in picture-in-picture), or null. */
    protected fun appWindowBounds(): Rect? {
        for (window in ui.windows) {
            val root = window.root ?: continue
            if (root.packageName?.toString() != app.packageName) continue
            return Rect().also { window.getBoundsInScreen(it) }
        }
        return null
    }

    protected fun ratio(rect: Rect?): String {
        if (rect == null || rect.height() <= 0) return "no window"
        return "%.3f".format(rect.width().toDouble() / rect.height())
    }

    /** The app's task to the front: an activity in picture-in-picture expands, a stopped one comes back. */
    /**
     * The browser's task to the front, through the shell: an activity start from this process
     * while the app stands behind the launcher is a background start the system may refuse
     * (Android 10+); `am start` from the shell is not. The activity is `singleTask`, so the
     * running instance comes forward (and a picture-in-picture window expands).
     */
    protected fun bringToFront() {
        val started = shell(
            "am start -W -a android.intent.action.MAIN -f 0x20000000 -n ${app.packageName}/${MainActivity::class.java.name}"
        )
        if (!started.contains("Status: ok")) note("  am start: ${started.trim().lines().joinToString(" | ")}")
        SystemClock.sleep(1_500)
    }

    /**
     * The app in front before a step touches its page, whatever the last step left on the
     * screen: the launcher after Home, the shade, a lock screen. The harness's `ensureForeground`
     * only presses Back, which does nothing to a launcher; a touch on a page that is not on the
     * screen lands on whatever is (a run's "Ask and notify" once tapped the launcher's wallpaper).
     */
    protected fun frontApp() {
        if (ui.rootInActiveWindow?.packageName?.toString() == app.packageName && !inPip()) return
        closeShade()
        bringToFront()
        val front = poll(8_000) { ui.rootInActiveWindow?.packageName?.toString() == app.packageName && !inPip() }
        note("  the app brought to the front for the step: $front")
        SystemClock.sleep(1_000)
    }

    protected fun secure(): Boolean {
        var value = false
        instrumentation.runOnMainSync {
            value = (activity.window.attributes.flags and WindowManager.LayoutParams.FLAG_SECURE) != 0
        }
        return value
    }

    protected fun poll(timeoutMs: Long, condition: () -> Boolean): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (condition()) return true
            SystemClock.sleep(200)
        }
        return condition()
    }

    protected fun note(line: String) {
        Log.i(tag, line)
        notes.appendText(line + "\n")
    }

    protected fun readAssetBytes(name: String): ByteArray =
        instrumentation.context.assets.open(name).use { it.readBytes() }

    // --- the fixtures ---------------------------------------------------------------------------

    /** A two-minute 16 kHz mono PCM WAV: a pentatonic run, one note every half second, each fading out. */
    protected fun tone(): ByteArray {
        val rate = 16_000
        val seconds = 120
        val samples = rate * seconds
        val data = ByteArray(samples * 2)
        val scale = intArrayOf(0, 2, 4, 7, 9, 12, 9, 7, 4, 2)
        for (i in 0 until samples) {
            val t = i.toDouble() / rate
            val step = (t * 2).toInt()
            val semitone = scale[step % scale.size] + if ((step / scale.size) % 2 == 1) 5 else 0
            val f = 220.0 * 2.0.pow(semitone / 12.0)
            val envelope = 1.0 - (t * 2 - step)
            val v = (sin(2 * PI * f * t) * 0.5 + sin(2 * PI * f * 2 * t) * 0.15) * envelope * 0.6
            val s = (v * Short.MAX_VALUE).toInt().coerceIn(Short.MIN_VALUE.toInt(), Short.MAX_VALUE.toInt())
            data[i * 2] = (s and 0xff).toByte()
            data[i * 2 + 1] = ((s shr 8) and 0xff).toByte()
        }
        val out = ByteArrayOutputStream(44 + data.size)
        fun ascii(s: String) = out.write(s.toByteArray(Charsets.US_ASCII))
        fun int32(v: Int) { out.write(v and 0xff); out.write((v shr 8) and 0xff); out.write((v shr 16) and 0xff); out.write((v shr 24) and 0xff) }
        fun int16(v: Int) { out.write(v and 0xff); out.write((v shr 8) and 0xff) }
        ascii("RIFF"); int32(36 + data.size); ascii("WAVE")
        ascii("fmt "); int32(16); int16(1); int16(1); int32(rate); int32(rate * 2); int16(2); int16(16)
        ascii("data"); int32(data.size)
        out.write(data)
        return out.toByteArray()
    }

    /** The track's artwork: a 256 px square, the demo's colours, a letter. */
    protected fun art(): ByteArray {
        val bitmap = Bitmap.createBitmap(256, 256, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        canvas.drawColor(Color.rgb(0x1b, 0x43, 0x32))
        val paint = Paint(Paint.ANTI_ALIAS_FLAG)
        paint.color = Color.rgb(0xf4, 0xa2, 0x61)
        canvas.drawCircle(128f, 128f, 96f, paint)
        paint.color = Color.WHITE
        paint.textSize = 150f
        paint.textAlign = Paint.Align.CENTER
        paint.isFakeBoldText = true
        canvas.drawText("Z", 128f, 128f + 54f, paint)
        val out = ByteArrayOutputStream()
        bitmap.compress(Bitmap.CompressFormat.PNG, 100, out)
        bitmap.recycle()
        return out.toByteArray()
    }

    companion object {
        const val PORT = 18136
        const val TAB = "tab_demo"
        /** SystemUI, whose windows hold the shade, the lock screen and the picture-in-picture menu. */
        const val SYSTEM_UI = "com.android.systemui"
    }
}
