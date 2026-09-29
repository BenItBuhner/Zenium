package app.zen.chromium

import android.accessibilityservice.AccessibilityService
import android.content.ClipboardManager
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.os.Build
import android.os.PowerManager
import android.os.SystemClock
import android.provider.Settings
import android.view.InputDevice
import android.view.KeyCharacterMap
import android.view.KeyEvent
import android.view.View
import android.view.WindowManager
import android.view.inputmethod.InputMethodManager
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONObject
import org.json.JSONTokener
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import java.io.ByteArrayOutputStream
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Three facts about the engine around [TabWebView], read on the phone (W6-S25-c):
 *
 * Act 1 – OS-30, the screen while media plays. WebView 113 keeps the screen on for a visibly
 * playing `<video>` through Blink's VideoWakeLock (`PowerSaveBlocker.applyBlock` sets
 * `keepScreenOn` on the WebView's container view, which the framework ORs into the window's
 * `FLAG_KEEP_SCREEN_ON` and the window manager holds a `WindowManager` wake lock for). The act
 * proves it with the display timeout at 15 s and `stayon` off: an inline clip playing – the
 * screen still interactive after 22 s; paused – the screen goes off; a track alone – off (Chrome
 * takes no display lock for audio); a tab switch, fullscreen, Home and a close of the playing
 * tab – where the flag goes each time (the tab view's, the fullscreen view's, the window's as
 * `dumpsys window` reports it, the `WindowManager` lock as `dumpsys power` lists it).
 * OS-14 rides along as facts in the warm-up: the tab view's `isAutoHandwritingEnabled` (the
 * framework's default is true; WebView's own `AndroidStylusWritingHandler` sets it false on a
 * T+ device whose default IME supports handwriting and starts handwriting itself), the global
 * setting, the input method manager's word.
 *
 * Act 2 – PUI-38, Copy Image into a page. The product's own path (`clipboard.writeImage`, the
 * bridge method behind the menu's Copy Image: the bytes into `cacheDir/clipboard/image-<ts>.png`,
 * a `content://` URI through the app's FileProvider on the clipboard) copies a JPEG and then a
 * PNG; a real finger focuses a `contenteditable`, the selection toolbar's Paste (Ctrl+V through
 * the input pipeline as the fallback) pastes; the page's `paste` event reports what arrived
 * (`clipboardData.types`, `items`, `files[0]`'s name, type, size and its first bytes) and what
 * the editor inserted; an `<input type=file>` focused by script takes a paste too.
 *
 * Every check goes to the notes; one that did not hold fails the run at its end. Every touch
 * injected has an assertion on what it did (the rule in [DemoHarness]).
 */
@RunWith(AndroidJUnit4::class)
class MediaScreenOnDemo : MediaDemoBase("w6-s25c-media-screen-on") {
    override val tag = "MediaScreenOnDemo"
    private var failures = 0
    private val power: PowerManager by lazy { app.getSystemService(PowerManager::class.java) }
    private var originalTimeout = "600000"
    private var powerTouched = false

    @Test
    fun record() {
        val media = "text/html; charset=utf-8" to readAsset("media-demo-page.html").toByteArray()
        val paste = "text/html; charset=utf-8" to readAsset("paste-demo-page.html").toByteArray()
        server = DemoServer(
            PORT,
            mapOf(
                "/audio" to media,
                "/video" to media,
                "/background" to media,
                "/paste" to paste,
                "/tone.wav" to ("audio/wav" to tone()),
                "/clip.webm" to ("video/webm" to readAssetBytes("media-demo-clip.webm")),
                "/art.png" to ("image/png" to art()),
                "/photo.jpg" to ("image/jpeg" to photo(Bitmap.CompressFormat.JPEG, Color.rgb(0xd9, 0x53, 0x2f))),
                "/photo.png" to ("image/png" to photo(Bitmap.CompressFormat.PNG, Color.rgb(0x2f, 0x7f, 0xd9)))
            )
        ).also { it.start() }
        try {
            runDemo()
        } finally {
            server.close()
            restorePower()
        }
        assertEquals("checks that did not hold (see w6-s25c-media-screen-on-notes.txt)", 0, failures)
    }

    override fun patchState(json: String): String {
        val state = JSONObject(json)
        val tabs = state.getJSONArray("tabs")
        for (i in 0 until tabs.length()) {
            val tab = tabs.getJSONObject(i)
            if (tab.optString("id") == TAB) {
                tab.put("url", VIDEO)
                tab.put("title", "Zenium screen-on demo")
            }
        }
        state.getJSONObject("settings").put("gestureHintDone", true)
        return state.toString()
    }

    override fun warmUp() {
        super.warmUp()
        shell("cmd uimode night no")
        poll(10_000) { pageJs("document.getElementById('media').videoWidth") != "0" }
        note("clip: ${pageJs("document.getElementById('media').videoWidth")}x${pageJs("document.getElementById('media').videoHeight")}; page ${title()}")
        originalTimeout = shell("settings get system screen_off_timeout").trim().ifEmpty { "600000" }
        note("power: screen_off_timeout=$originalTimeout interactive=${power.isInteractive}; ${powerSummary()}")
        stylusFacts()
    }

    override fun demo() {
        screenOnWhilePlaying()
        screenOffWhenPaused()
        audioAloneDoesNotHold()
        tabSwitchDropsTheHold()
        fullscreenHolds()
        homeReleasesTheLock()
        closingThePlayingTabDropsTheHold()
        restorePower()
        copyImagePaste()
        note("\nend: interactive=${power.isInteractive}; ${powerSummary()}")
    }

    // --- Act 1: OS-30 ------------------------------------------------------------------------------

    private fun screenOnWhilePlaying() {
        note("\n1. OS-30: an inline <video> playing keeps the screen on (timeout 15 s, stayon off)")
        onVideoPage()
        check("1: before play, nothing holds the screen: the tab view's keepScreenOn false, no KEEP_SCREEN_ON on the window, no WindowManager lock for the app", viewKeepsScreenOn() == false && !windowHolds() && !wmLockHeld())
        armTimeout()
        play()
        val held = poll(6_000) { viewKeepsScreenOn() == true }
        note("  playing: ${screenState()}")
        check("1: playing, the engine sets keepScreenOn on the tab's WebView (PowerSaveBlocker.applyBlock on the container view)", held)
        check("1: the window manager sees the flag on the app's window and holds its WindowManager wake lock", windowHolds() && wmLockHeld())
        shot("01-inline-playing")
        idle(22_000)
        note("  22 s idle while playing: ${screenState()}; page ${title()}")
        check("1: the screen is still interactive 22 s into a 15 s timeout while the clip plays", power.isInteractive && field("state") == "playing")
        shot("02-inline-still-on")
    }

    private fun screenOffWhenPaused() {
        note("\n2. OS-30: paused, the hold goes and the screen times out")
        pause()
        val released = poll(6_000) { viewKeepsScreenOn() == false && !windowHolds() }
        note("  paused: ${screenState()}")
        check("2: the pause clears the tab view's keepScreenOn and the window's flag (never left set)", released)
        val off = poll(24_000) { !power.isInteractive }
        note("  after the wait: ${screenState()}")
        check("2: the screen goes off within the 15 s timeout once nothing plays", off)
        shot("03-paused-screen-off")
        wake()
    }

    private fun audioAloneDoesNotHold() {
        note("\n3. OS-30 / Chrome parity: a track alone (no video) takes no display lock")
        frontApp()
        navigate(TAB, "$AUDIO?n=${SystemClock.uptimeMillis()}") { it.startsWith("MD|kind:audio") }
        armTimeout()
        tapPageButton("play", "Play track", "the track plays", 15_000) { field("state") == "playing" }
        SystemClock.sleep(1_500)
        note("  playing audio: ${screenState()}; session ${describeSession()}")
        check("3: audio playing, the tab view's keepScreenOn stays false and the window carries no flag (kPreventAppSuspension is a no-op on Android)", viewKeepsScreenOn() == false && !windowHolds())
        val off = poll(24_000) { !power.isInteractive }
        note("  after the wait: ${screenState()}; page ${title()}")
        check("3: the screen goes off while only audio plays – Chrome's rule (its wake lock is for video)", off)
        shot("04-audio-screen-off")
        wake()
        frontApp()
        if (field("state") == "playing") tapPageButton("play", "Pause track", "the track pauses", 10_000) { field("state") == "paused" }
    }

    private fun tabSwitchDropsTheHold() {
        note("\n4. OS-30: the playing tab goes to the background of the tab strip (another tab active)")
        restorePower()
        onVideoPage()
        play()
        poll(6_000) { viewKeepsScreenOn() == true }
        check("4: playing again, the hold is back", viewKeepsScreenOn() == true && windowHolds())
        val other = createTab(BLANK)
        val dropped = poll(8_000) { !windowHolds() }
        note("  other tab active ($other): tab view visibility=${viewVisibility()} keepScreenOn=${viewKeepsScreenOn()}; ${screenState()}; page ${title()}")
        check("4: with the tab's view gone from the screen, the window's KEEP_SCREEN_ON drops (the framework collects the flag from visible views only)", dropped)
        check("4: and the WindowManager lock with it", !wmLockHeld())
        coreInvoke("tab.activate", """{"tabId":${JSONObject.quote(TAB)}}""")
        poll(6_000) { viewVisibility() == "VISIBLE" }
        if (other != null) coreInvoke("tab.close", """{"tabId":${JSONObject.quote(other)}}""")
        SystemClock.sleep(1_500)
        note("  back on the tab: state ${field("state")}; ${screenState()}")
        note("  fact: on return the video ${if (field("state") == "playing") "PLAYS and the hold is ${if (windowHolds()) "back" else "NOT back"}" else "stays paused (the engine paused the hidden tab; the hold owes nothing to a paused clip)"}")
    }

    private fun fullscreenHolds() {
        note("\n5. OS-30: fullscreen video")
        onVideoPage()
        play()
        tapPageButton("fullscreen", "Play fullscreen", "the page goes fullscreen", 15_000) { field("fs") == "1" }
        SystemClock.sleep(2_000)
        val fullscreenView = fullscreenKeepsScreenOn()
        note("  fullscreen: fullscreen view keepScreenOn=$fullscreenView tab view keepScreenOn=${viewKeepsScreenOn()}; ${screenState()}")
        check("5: fullscreen, a view in the window holds the screen (the engine moves the hold to its fullscreen view) and the window manager sees it", (fullscreenView == true || viewKeepsScreenOn() == true) && windowHolds() && wmLockHeld())
        shot("05-fullscreen")
        back()
        val left = poll(8_000) { field("fs") == "0" }
        note("  Back: fullscreen left=$left; ${screenState()}; state ${field("state")}")
        if (!left) coreInvoke("tab.reload", """{"tabId":${JSONObject.quote(TAB)}}""")
    }

    private fun homeReleasesTheLock() {
        note("\n6. OS-30: Home while the clip plays")
        onVideoPage()
        play()
        poll(6_000) { viewKeepsScreenOn() == true }
        ui.performGlobalAction(AccessibilityService.GLOBAL_ACTION_HOME)
        val left = poll(8_000) { ui.rootInActiveWindow?.packageName?.toString() != app.packageName }
        val released = poll(8_000) { !wmLockHeld() }
        note("  Home: left=$left; tab view keepScreenOn=${viewKeepsScreenOn()}; ${screenState()}; page state ${field("state")}")
        check("6: behind the launcher the WindowManager lock for the app is gone (the hold is per window on screen)", released)
        bringToFront()
        frontApp()
        SystemClock.sleep(1_500)
        note("  back: state ${field("state")}; ${screenState()}")
    }

    private fun closingThePlayingTabDropsTheHold() {
        note("\n7. OS-30: the playing tab closed")
        onVideoPage()
        play()
        poll(6_000) { viewKeepsScreenOn() == true }
        val keeper = createTab(BLANK)
        coreInvoke("tab.activate", """{"tabId":${JSONObject.quote(TAB)}}""")
        poll(6_000) { viewVisibility() == "VISIBLE" }
        if (field("state") != "playing") play()
        poll(6_000) { windowHolds() }
        note("  before close: ${screenState()}")
        coreInvoke("tab.close", """{"tabId":${JSONObject.quote(TAB)}}""")
        val gone = poll(8_000) { tabGone(TAB) && !windowHolds() && !wmLockHeld() }
        note("  closed: tab gone=${tabGone(TAB)}; ${screenState()}")
        check("7: the tab closed, the window's flag and the WindowManager lock are gone", gone)
        shot("06-tab-closed")
        note("  the tab that keeps the window: $keeper")
    }

    // --- Act 2: PUI-38 ------------------------------------------------------------------------------

    private fun copyImagePaste() {
        note("\n8. PUI-38: Copy Image through the product (clipboard.writeImage -> Host.copyImage -> FileProvider content URI), pasted into a page")
        frontApp()
        val tab = createTab("$PASTE?n=${SystemClock.uptimeMillis()}") ?: run {
            check("8: a tab for the paste page", false)
            return
        }
        waitTitle(tab, 20_000) { it.startsWith("PP|") }
        note("  paste page: ${describeTab(tab)}")
        pasteRound(tab, PHOTO_JPG, "a JPEG", expectPastes = 1)
        pasteRound(tab, PHOTO_PNG, "a PNG", expectPastes = 2)
        fileInputRound(tab)
    }

    private fun pasteRound(tab: String, url: String, what: String, expectPastes: Int) {
        note("\n  Copy Image of $what ($url)")
        val copied = copyThroughTheProduct(url)
        val clip = describeClip()
        note("  clipboard.writeImage -> $copied; clipboard: $clip")
        check("8: Copy Image of $what puts a content:// URI clip on the clipboard through the app's FileProvider", copied == "true" && clip.contains("content://"))
        frontApp()
        pageJs("document.getElementById('ce').innerHTML='Paste here';document.getElementById('ce').blur();", tab)
        val rect = pageElementRect("ce", tab) ?: run {
            note("  the page has no #ce box to touch")
            check("8: the contenteditable is on screen", false)
            return
        }
        val point = touchPoint(rect) ?: run {
            check("8: the contenteditable has a point a finger can reach", false)
            return
        }
        Finger().tap(point.x, point.y)
        val focused = poll(5_000) { pageJs("document.activeElement&&document.activeElement.id", tab) == "\"ce\"" }
        if (focused) note("  finger on the contenteditable at ${point.x.toInt()},${point.y.toInt()}: it has the focus")
        else {
            touchFault("a touch on the paste page's contenteditable did not take: no focus (page: ${title(tab)})")
            note("  TOUCH FAULT: the contenteditable did not take the focus (page: ${title(tab)})")
        }
        SystemClock.sleep(600)
        val pasted = pasteInto(tab, expectPastes)
        val fields = pasteFields(tab)
        note("  after paste: pasted=$pasted ${title(tab)}")
        check("8: the paste of $what reaches the page's paste event", pasted)
        if (!pasted) return
        val files = fields["files"]?.toIntOrNull() ?: 0
        val magic = fields["magic"] ?: "-"
        val type = fields["type"] ?: "-"
        note("  FACT  PUI-38 ($what): clipboardData.types=${fields["types"]} items=${fields["items"]} files=$files file name=${fields["name"]} type=$type size=${fields["size"]} bytes=$magic; editor inserted ${fields["ce"]}; text/plain=${fields["text"]}")
        check("8: the paste of $what arrives in clipboardData.files as an image File", files >= 1 && type.startsWith("image~"))
        when (what) {
            "a JPEG" -> {
                val honest = magic == "png" && type == "image~png"
                note("  FACT  PUI-38 (JPEG): the pasted File is typed $type with $magic bytes – ${if (honest) "WebView re-encoded the JPEG to PNG (Chrome's behaviour)" else if (type == "image~png" && magic == "jpeg") "MISLABELLED: image/png with JPEG bytes (Host.copyImage names every copied image .png; FileProvider reports image/png; WebView's getPng() trusts ContentResolver.getType and hands the bytes over unchanged)" else "as recorded"}")
                shot("07-paste-jpeg")
            }
            else -> {
                check("8: the PNG control arrives as image/png with PNG bytes", magic == "png" && type == "image~png")
                shot("08-paste-png")
            }
        }
    }

    private fun fileInputRound(tab: String) {
        note("\n  <input type=file> focused by script, then a paste")
        frontApp()
        pageJs("document.getElementById('file').focus()", tab)
        val focused = poll(3_000) { pageJs("document.activeElement&&document.activeElement.id", tab) == "\"file\"" }
        note("  file input focused: $focused")
        val before = pasteFields(tab)["pastes"]?.toIntOrNull() ?: 0
        ctrlV()
        val heard = poll(5_000) { (pasteFields(tab)["pastes"]?.toIntOrNull() ?: 0) > before }
        val fields = pasteFields(tab)
        note("  FACT  PUI-38 (file input): paste event heard=$heard target=${fields["target"]} files in the event=${fields["files"]} input.files after=${fields["fileinput"]} (100+n = a change event fired; 0 = none)")
        note("  a paste never fills <input type=file> on the web platform (Chrome the same); the image is offered only through the paste event's clipboardData.files")
    }

    /** The product's own Copy Image: the bridge method the menu's row calls, with the URL. "true"/"false"/"timeout". */
    private fun copyThroughTheProduct(url: String): String {
        var result = "timeout"
        val latch = CountDownLatch(1)
        instrumentation.runOnMainSync {
            host.dispatch("clipboard.writeImage", JSONObject().put("url", url)) { reply ->
                result = reply.toString()
                latch.countDown()
            }
        }
        latch.await(15, TimeUnit.SECONDS)
        return result
    }

    /** What is on the clipboard as the system has it: mime types, the item's URI, the resolver's type for it, the first bytes. */
    private fun describeClip(): String {
        var out = "no clip"
        instrumentation.runOnMainSync {
            val cm = app.getSystemService(ClipboardManager::class.java)
            val clip = cm.primaryClip ?: return@runOnMainSync
            val description = clip.description
            val mimes = (0 until description.mimeTypeCount).map { description.getMimeType(it) }
            val item = clip.getItemAt(0)
            val uri = item.uri
            val resolverType = uri?.let { runCatching { app.contentResolver.getType(it) }.getOrNull() }
            val magic = uri?.let {
                runCatching {
                    app.contentResolver.openInputStream(it)?.use { s ->
                        val head = ByteArray(12)
                        val n = s.read(head)
                        when {
                            n >= 4 && head[0] == 0x89.toByte() && head[1] == 0x50.toByte() -> "png"
                            n >= 3 && head[0] == 0xff.toByte() && head[1] == 0xd8.toByte() -> "jpeg"
                            else -> "other"
                        }
                    }
                }.getOrNull()
            }
            out = "label=${description.label} items=${clip.itemCount} mimeTypes=$mimes uri=$uri resolverType=$resolverType bytes=$magic text=${item.text}"
        }
        return out
    }

    /**
     * The paste: the selection toolbar's Paste after a long press on the focused editor (a real
     * finger), Ctrl+V through the input pipeline when the toolbar offered none. True once the
     * page's paste count reaches `expectPastes`.
     */
    private fun pasteInto(tab: String, expectPastes: Int): Boolean {
        val took = { (pasteFields(tab)["pastes"]?.toIntOrNull() ?: 0) >= expectPastes }
        val rect = pageElementRect("ce", tab)
        val point = rect?.let { touchPoint(it) }
        if (point != null) {
            val finger = Finger()
            finger.press(point.x, point.y)
            finger.up()
            val menu = awaitInWindows(4_000) { it.equals("Paste", ignoreCase = true) }
            if (menu != null) {
                if (touchInWindows("Paste", "the page hears the paste", 8_000, { it.equals("Paste", ignoreCase = true) }, took)) return true
            } else {
                note("  the long press lifted no toolbar with Paste; Ctrl+V through the input pipeline")
                dumpWindows("after the long press on the editor")
            }
        }
        ctrlV()
        if (poll(5_000, took)) {
            note("  Ctrl+V: the page hears the paste")
            return true
        }
        return false
    }

    /** Ctrl+V the way a hardware keyboard sends it: the engine's paste command on the focused editor. */
    private fun ctrlV() {
        val downTime = SystemClock.uptimeMillis()
        val meta = KeyEvent.META_CTRL_ON or KeyEvent.META_CTRL_LEFT_ON
        for (action in intArrayOf(KeyEvent.ACTION_DOWN, KeyEvent.ACTION_UP)) {
            val event = KeyEvent(
                downTime, SystemClock.uptimeMillis(), action, KeyEvent.KEYCODE_V, 0, meta,
                KeyCharacterMap.VIRTUAL_KEYBOARD, 0, KeyEvent.FLAG_FROM_SYSTEM, InputDevice.SOURCE_KEYBOARD
            )
            ui.injectInputEvent(event, true)
        }
    }

    private fun pasteFields(tab: String): Map<String, String> =
        title(tab).split('|').drop(1).mapNotNull { part ->
            val at = part.indexOf(':')
            if (at <= 0) null else part.substring(0, at) to part.substring(at + 1)
        }.toMap()

    // --- OS-14 ---------------------------------------------------------------------------------------

    private fun stylusFacts() {
        var auto: Boolean? = null
        instrumentation.runOnMainSync {
            auto = if (Build.VERSION.SDK_INT >= 33) host.tabs.get(TAB)?.isAutoHandwritingEnabled else null
        }
        val imm = app.getSystemService(InputMethodManager::class.java)
        val available = if (Build.VERSION.SDK_INT >= 33) runCatching { imm.isStylusHandwritingAvailable }.getOrNull() else null
        val setting = shell("settings get global stylus_handwriting_enabled").trim()
        val ime = Settings.Secure.getString(app.contentResolver, Settings.Secure.DEFAULT_INPUT_METHOD)
        val supports = if (Build.VERSION.SDK_INT >= 33) imm.inputMethodList.firstOrNull { it.id == ime }?.supportsStylusHandwriting() else null
        note("OS-14 stylus: TabWebView.isAutoHandwritingEnabled=$auto (the framework's default is true; WebView 113's AndroidStylusWritingHandler sets it false on Android 13+ when stylus_handwriting_enabled=1 and the default IME supports handwriting, and starts handwriting itself); Settings.Global.stylus_handwriting_enabled=$setting; imm.isStylusHandwritingAvailable=$available; default IME $ime supportsStylusHandwriting=$supports")
        pageJs("document.getElementById('media').focus()")
        SystemClock.sleep(500)
        var afterFocus: Boolean? = null
        instrumentation.runOnMainSync {
            afterFocus = if (Build.VERSION.SDK_INT >= 33) host.tabs.get(TAB)?.isAutoHandwritingEnabled else null
        }
        note("OS-14 stylus: after a focus in the page isAutoHandwritingEnabled=$afterFocus")
    }

    // --- helpers -------------------------------------------------------------------------------------

    private fun onVideoPage() {
        frontApp()
        if (tabGone(TAB)) {
            note("  the demo tab is gone; the act needs it")
            return
        }
        if (field("kind") != "video" || field("fs") != "0") {
            navigate(TAB, "$VIDEO?n=${SystemClock.uptimeMillis()}") { it.startsWith("MD|kind:video") && "fs:0" in it }
            poll(10_000) { pageJs("document.getElementById('media').videoWidth") != "0" }
        }
        if (field("state") == "playing") pause()
        SystemClock.sleep(600)
    }

    private fun navigate(tab: String, url: String, accept: (String) -> Boolean) {
        coreInvoke("tab.navigate", """{"tabId":${JSONObject.quote(tab)},"input":${JSONObject.quote(url)}}""")
        waitTitle(tab, 20_000, accept)
        SystemClock.sleep(500)
    }

    private fun play() {
        if (field("state") == "playing") return
        tapPageButton("play", "Play video", "the clip plays", 15_000) { field("state") == "playing" }
        SystemClock.sleep(1_200)
    }

    private fun pause() {
        if (field("state") != "playing") return
        frontApp()
        tapPageButton("play", "Pause video", "the clip pauses", 10_000) { field("state") == "paused" }
    }

    private fun createTab(url: String): String? {
        val result = coreInvoke("tab.create", """{"url":${JSONObject.quote(url)},"active":true}""")
        val id = runCatching { JSONTokener(result).nextValue() as? String }.getOrNull()
        if (id == null) note("  tab.create -> $result")
        else poll(6_000) { coreState().getJSONObject("tabs").has(id) }
        return id
    }

    private fun tabGone(tab: String): Boolean = !coreState().getJSONObject("tabs").has(tab)

    /** The display timeout at 15 s with `stayon` off: the screen goes dark unless something holds it. */
    private fun armTimeout() {
        powerTouched = true
        shell("svc power stayon false")
        shell("settings put system screen_off_timeout 15000")
        // The setting is read on the next user activity; a wake-up key is one that changes nothing on screen.
        shell("input keyevent KEYCODE_WAKEUP")
        SystemClock.sleep(800)
    }

    private fun restorePower() {
        if (!powerTouched) return
        shell("settings put system screen_off_timeout $originalTimeout")
        shell("svc power stayon true")
        shell("input keyevent KEYCODE_WAKEUP")
        powerTouched = false
    }

    /** No input of any kind for `ms`: what the display timeout counts. */
    private fun idle(ms: Long) {
        val end = SystemClock.uptimeMillis() + ms
        while (SystemClock.uptimeMillis() < end) SystemClock.sleep(minOf(1_000, end - SystemClock.uptimeMillis()).coerceAtLeast(1))
    }

    private fun wake() {
        shell("input keyevent KEYCODE_WAKEUP")
        poll(5_000) { power.isInteractive }
        shell("wm dismiss-keyguard")
        SystemClock.sleep(800)
        note("  woken: interactive=${power.isInteractive}")
        frontApp()
    }

    private fun viewKeepsScreenOn(tab: String = TAB): Boolean? {
        var v: Boolean? = null
        instrumentation.runOnMainSync { v = host.tabs.get(tab)?.keepScreenOn }
        return v
    }

    private fun fullscreenKeepsScreenOn(): Boolean? {
        var v: Boolean? = null
        instrumentation.runOnMainSync { v = host.fullscreenView?.keepScreenOn }
        return v
    }

    private fun viewVisibility(tab: String = TAB): String {
        var v = "gone from the host"
        instrumentation.runOnMainSync {
            v = when (host.tabs.get(tab)?.visibility) {
                View.VISIBLE -> "VISIBLE"
                View.INVISIBLE -> "INVISIBLE"
                View.GONE -> "GONE"
                else -> v
            }
        }
        return v
    }

    /** The client's own window flag (what an extension's chrome.power would set); the view-derived one is the window manager's. */
    private fun clientWindowFlag(): Boolean {
        var v = false
        instrumentation.runOnMainSync { v = (activity.window.attributes.flags and WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON) != 0 }
        return v
    }

    /** The app's window line in `dumpsys window windows`, as the window manager sees it. */
    private fun appWindowDump(): String {
        val dump = shell("dumpsys window windows")
        val lines = dump.lines()
        val out = StringBuilder()
        var inApp = false
        for (line in lines) {
            if (line.contains("Window #") ) inApp = line.contains(app.packageName) && line.contains(MainActivity::class.java.name)
            if (inApp) out.append(line.trim()).append('\n')
        }
        return out.toString()
    }

    /** True when the window manager has the app's window flagged KEEP_SCREEN_ON (the view-derived flag ORed into the window's). */
    private fun windowHolds(): Boolean {
        val dump = appWindowDump()
        val flags = dump.lines().firstOrNull { it.contains("fl=") }
        return flags?.contains("KEEP_SCREEN_ON") == true
    }

    /** The `WindowManager` wake lock in `dumpsys power` naming the app's uid, or none. */
    private fun wmLockLine(): String? {
        val dump = shell("dumpsys power")
        val uid = app.applicationInfo.uid.toString()
        return dump.lines().map { it.trim() }.firstOrNull { it.contains("'WindowManager'") && (it.contains("uid=$uid") || it.contains("ws=WorkSource{$uid") || it.contains("WorkSource{$uid")) }
    }

    private fun wmLockHeld(): Boolean = wmLockLine() != null

    private fun powerSummary(): String {
        val dump = shell("dumpsys power")
        val hold = dump.lines().map { it.trim() }.filter { it.startsWith("mHoldingDisplaySuspendBlocker") || it.startsWith("mWakefulness=") || it.startsWith("mStayOn=") || it.contains("'WindowManager'") }
        return hold.joinToString("; ").ifEmpty { "dumpsys power: no matching lines" }
    }

    private fun screenState(): String =
        "interactive=${power.isInteractive} viewKeepScreenOn=${viewKeepsScreenOn()} clientWindowFlag=${clientWindowFlag()} wmWindowFlag=${windowHolds()} wmLock=${wmLockLine() ?: "none"}"

    private fun check(what: String, ok: Boolean) {
        if (!ok) failures++
        note("  ${if (ok) "PASS" else "FAIL"}  $what")
    }

    /** A 640x480 photo-like bitmap in `format`: a tinted field with a white disc, so a JPEG and a PNG copy both have a real image behind them. */
    private fun photo(format: Bitmap.CompressFormat, tint: Int): ByteArray {
        val bitmap = Bitmap.createBitmap(640, 480, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        canvas.drawColor(tint)
        val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.WHITE }
        canvas.drawCircle(320f, 240f, 150f, paint)
        paint.color = tint
        canvas.drawCircle(320f, 240f, 60f, paint)
        val out = ByteArrayOutputStream()
        bitmap.compress(format, 90, out)
        bitmap.recycle()
        return out.toByteArray()
    }

    companion object {
        private const val VIDEO = "http://127.0.0.1:$PORT/video"
        private const val AUDIO = "http://127.0.0.1:$PORT/audio"
        private const val PASTE = "http://127.0.0.1:$PORT/paste"
        private const val PHOTO_JPG = "http://127.0.0.1:$PORT/photo.jpg"
        private const val PHOTO_PNG = "http://127.0.0.1:$PORT/photo.png"
        private const val BLANK = "zen://blank"
    }
}
