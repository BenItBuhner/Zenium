package app.zen.chromium

import android.accessibilityservice.AccessibilityServiceInfo
import android.app.UiAutomation
import android.content.Intent
import android.graphics.Rect
import android.os.Build
import android.os.SystemClock
import android.provider.Settings
import android.util.Log
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityManager
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityNodeInfo.AccessibilityAction
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.io.FileInputStream

/**
 * Records what a screen reader finds in the phone chrome's address pill (design language v2
 * §9.22): the address field and every chip in it – the site icon and the lock – are buttons with
 * a label of their own that open the site-information sheet and say whether it is up. Driven by
 * the `android-a11y-pill-chips-demo` workflow. See [DemoHarness].
 *
 * TalkBack is switched on for the run when the system image has it (the Google APIs image does;
 * the driver says so in its dump either way), so the run is what a TalkBack user gets: TalkBack
 * speaks every focus change and window below. The navigation itself goes through the
 * accessibility API rather than TalkBack's touch gestures, because touches injected through
 * UiAutomation bypass the explore-by-touch input filter and would reach the pill as its own
 * swipes. Moving the accessibility focus to a node (`ACTION_ACCESSIBILITY_FOCUS`) is what
 * TalkBack does for a swipe right, clicking the focused node (`ACTION_CLICK`) what it does for a
 * double-tap. Speech cannot be recorded (the emulator has no audio), so the driver writes down
 * what the tree says about each node – the label, class (role), popup flag and expand/collapse
 * actions TalkBack composes its announcement from – as `a11y-pill-chips-tree-*.txt`, and the
 * recording shows the focus ring travelling and the sheet opening on activation.
 */
@RunWith(AndroidJUnit4::class)
class PillChipsA11yDemo : DemoHarness(
    "a11y-pill-chips-demo-state.json",
    "a11y-pill-chips",
    "a11y-pill-chips-demo",
    UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES
) {
    override val tag = "PillChipsA11yDemo"
    /** What the run cannot do without; the instrumentation fails with these at the end. */
    private val failures = ArrayList<String>()
    /** What this Chromium exposes differently from what the chrome asks for; written down, not fatal. */
    private val notes = ArrayList<String>()
    private val events = StringBuilder()
    private var talkBack = "not checked"

    @Test
    fun record() {
        runDemo()
        if (failures.isNotEmpty()) throw AssertionError(failures.joinToString("\n"))
    }

    /**
     * TalkBack on before the app starts, so its first-run tutorial (it opens one) ends up under
     * the browser rather than over it. The accessibility focus ring is drawn by the system only
     * while touch exploration is on, so without TalkBack the driver requests that mode itself.
     */
    override fun beforeLaunch() {
        ui.setOnAccessibilityEventListener { event -> noteEvent(event) }
        talkBack = enableTalkBack()
        val info = ui.serviceInfo
        info.flags = info.flags or AccessibilityServiceInfo.FLAG_REQUEST_TOUCH_EXPLORATION_MODE
        ui.serviceInfo = info
        SystemClock.sleep(1_500)
        val manager = app.getSystemService(AccessibilityManager::class.java)
        Log.i(
            tag,
            "TalkBack: $talkBack; accessibility ${manager.isEnabled}, touch exploration " +
                "${manager.isTouchExplorationEnabled}, services ${enabledServices()}"
        )
    }

    override fun warmUp() {
        bringToFront()
        // example.com is small; give the page and the pill's label a moment all the same.
        SystemClock.sleep(3_000)
        Log.i(tag, "warm-up done, front window ${ui.rootInActiveWindow?.packageName}")
    }

    override fun demo() {
        File(out, "a11y-pill-chips-dumpsys.txt").writeText(shell("dumpsys accessibility"))

        // 1. The pill at rest: the field, then each chip, every one a button with its label; the
        //    chips can open a popup and report it closed.
        val group = pillGroup() ?: run {
            fail("no node labelled '$PILL_LABEL' (the address pill group) in the accessibility tree")
            return
        }
        dump("01-collapsed", group)
        shot("01-rest")
        checkField()
        checkChip(SITE_INFO_LABEL, expanded = false)
        checkChip(LOCK_LABEL, expanded = false)

        // 2. Swipe right, swipe right, …: the accessibility focus goes to the field, the site
        //    icon, the lock, then on to the bar's next button; swipe left brings it back.
        val stops = speakable(group).map { label(it) } + listOfNotNull(nextControl(group)?.let { label(it) })
        Log.i(tag, "linear navigation order: $stops")
        if (stops.size < 3) fail("expected the field and two chips in the pill, found $stops")
        stops.forEachIndexed { i, label ->
            focus(label)
            shot("%02d-focus-%s".format(i + 2, slug(label)))
        }
        if (stops.size >= 2) {
            focus(stops[stops.size - 2])
            shot("%02d-focus-back-%s".format(stops.size + 2, slug(stops[stops.size - 2])))
        }

        // 3. Double-tap on the site icon: the sheet opens and both chips report it expanded.
        focus(SITE_INFO_LABEL)
        activate(SITE_INFO_LABEL)
        if (waitForSheet()) {
            SystemClock.sleep(1_500)
            shot("20-site-info-open")
            pillGroup()?.let { dump("02-expanded", it) }
            checkChip(SITE_INFO_LABEL, expanded = true)
            checkChip(LOCK_LABEL, expanded = true)
        } else {
            fail("activating '$SITE_INFO_LABEL' did not open the site information sheet")
            shot("20-site-info-not-open")
        }
        back()
        if (!waitForSheetGone()) fail("the site information sheet did not close on back")
        SystemClock.sleep(1_000)
        shot("21-site-info-closed")
        pillGroup()?.let { dump("03-collapsed-again", it) }
        checkChip(SITE_INFO_LABEL, expanded = false)

        // 4. The lock opens the same sheet.
        focus(LOCK_LABEL)
        activate(LOCK_LABEL)
        if (waitForSheet()) {
            SystemClock.sleep(1_500)
            shot("22-lock-open")
        } else {
            fail("activating '$LOCK_LABEL' did not open the site information sheet")
            shot("22-lock-not-open")
        }
        back()
        waitForSheetGone()
        SystemClock.sleep(1_000)
        shot("23-end")

        synchronized(events) { File(out, "a11y-pill-chips-events.txt").writeText(events.toString()) }
        File(out, "a11y-pill-chips-verdict.txt").writeText(
            if (failures.isEmpty()) "OK\n" else failures.joinToString("\n", postfix = "\n")
        )
    }

    // --- TalkBack ------------------------------------------------------------------------------

    /** Turn TalkBack on through the shell (UiAutomation runs it as shell); what happened, for the dump. */
    private fun enableTalkBack(): String {
        val installed = shell("pm list packages $TALKBACK_PACKAGE").lines().any { it.trim() == "package:$TALKBACK_PACKAGE" }
        if (!installed) {
            Log.w(tag, "TalkBack is not on this system image")
            return "not installed on this system image"
        }
        val version = shell("dumpsys package $TALKBACK_PACKAGE").lines()
            .firstOrNull { it.trim().startsWith("versionName=") }?.trim()?.removePrefix("versionName=") ?: "?"
        shell("settings put secure enabled_accessibility_services $TALKBACK_SERVICE")
        shell("settings put secure accessibility_enabled 1")
        val deadline = SystemClock.uptimeMillis() + 20_000
        var running = false
        while (SystemClock.uptimeMillis() < deadline) {
            running = enabledServices().any { it.startsWith(TALKBACK_PACKAGE) }
            if (running) break
            SystemClock.sleep(500)
        }
        // Its first start brings up the TalkBack tutorial; let it come so the app launches over it.
        val tutorialDeadline = SystemClock.uptimeMillis() + 8_000
        while (SystemClock.uptimeMillis() < tutorialDeadline) {
            if (ui.rootInActiveWindow?.packageName?.toString() == TALKBACK_PACKAGE) break
            SystemClock.sleep(500)
        }
        SystemClock.sleep(2_000)
        val front = ui.rootInActiveWindow?.packageName
        Log.i(tag, "TalkBack $version ${if (running) "running" else "enabled, not reported running"}; front window $front")
        return "$version ${if (running) "running" else "enabled but not reported as running"}"
    }

    private fun enabledServices(): List<String> =
        app.getSystemService(AccessibilityManager::class.java)
            .getEnabledAccessibilityServiceList(AccessibilityServiceInfo.FEEDBACK_ALL_MASK)
            .map { it.id }

    /** The tutorial (or anything else) in front: the browser is singleTask, starting it brings it back. */
    private fun bringToFront() {
        repeat(3) {
            val top = ui.rootInActiveWindow?.packageName?.toString()
            if (top == null || top == app.packageName) return
            Log.w(tag, "window of $top is in front; bringing the browser back")
            val intent = Intent(app, MainActivity::class.java).setAction(Intent.ACTION_MAIN)
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            app.startActivity(intent)
            SystemClock.sleep(3_000)
        }
    }

    // --- what TalkBack does for a swipe and a double-tap ------------------------------------------

    private fun focus(label: String) {
        val node = findLabelled(label) ?: run {
            fail("no node labelled '$label' to move the accessibility focus to")
            return
        }
        val ok = node.performAction(AccessibilityNodeInfo.ACTION_ACCESSIBILITY_FOCUS)
        SystemClock.sleep(2_200)
        val focused = findLabelled(label)?.isAccessibilityFocused == true
        Log.i(tag, "accessibility focus -> '$label': action $ok, focused $focused")
        if (!ok) fail("ACTION_ACCESSIBILITY_FOCUS on '$label' was refused")
    }

    private fun activate(label: String) {
        val node = findLabelled(label) ?: run {
            fail("no node labelled '$label' to activate")
            return
        }
        val ok = node.performAction(AccessibilityNodeInfo.ACTION_CLICK)
        Log.i(tag, "click -> '$label': $ok")
        if (!ok) fail("ACTION_CLICK on '$label' was refused")
    }

    // --- the tree ------------------------------------------------------------------------------

    /** The pill: the group labelled exactly `Address` (the field inside it says `Address, host`). */
    private fun pillGroup(): AccessibilityNodeInfo? = findNode { it == PILL_LABEL }

    /** A clickable node in the pill with this label, or the label with the address after it. */
    private fun findLabelled(label: String): AccessibilityNodeInfo? {
        val group = pillGroup()
        val inPill = group?.let { speakable(it).firstOrNull { node -> label(node) == label } }
        return inPill ?: findNode { it == label }?.takeIf { it.isClickable } ?: findNode { it == label }
    }

    private fun label(node: AccessibilityNodeInfo): String =
        node.contentDescription?.toString()?.takeIf { it.isNotBlank() } ?: node.text?.toString().orEmpty()

    /**
     * The nodes TalkBack stops at inside `root`, in its linear order (depth first): the clickable
     * ones with a label; their descendants are spoken as part of them, not separately.
     */
    private fun speakable(root: AccessibilityNodeInfo): List<AccessibilityNodeInfo> {
        val found = ArrayList<AccessibilityNodeInfo>()
        fun visit(node: AccessibilityNodeInfo) {
            if (node !== root && node.isClickable && label(node).isNotBlank()) {
                found += node
                return
            }
            for (i in 0 until node.childCount) node.getChild(i)?.let(::visit)
        }
        visit(root)
        return found
    }

    /** The first thing TalkBack would stop at after the pill: the bar's next button. */
    private fun nextControl(group: AccessibilityNodeInfo): AccessibilityNodeInfo? {
        var child: AccessibilityNodeInfo = group
        var parent: AccessibilityNodeInfo? = group.parent
        while (parent != null) {
            val container: AccessibilityNodeInfo = parent
            val siblings = (0 until container.childCount).mapNotNull { container.getChild(it) }
            val current = child
            val index = siblings.indexOfFirst { it == current }
            if (index >= 0) {
                for (sibling in siblings.drop(index + 1)) {
                    if (sibling.isClickable && label(sibling).isNotBlank()) return sibling
                    speakable(sibling).firstOrNull()?.let { return it }
                }
            }
            child = container
            parent = container.parent
        }
        return null
    }

    private fun waitForSheet(timeoutMs: Long = 8_000): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (sheetOpen()) return true
            SystemClock.sleep(250)
        }
        return false
    }

    private fun waitForSheetGone(timeoutMs: Long = 6_000): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (!sheetOpen()) return true
            SystemClock.sleep(250)
        }
        return false
    }

    /** The open sheet is a dialog carrying the site icon's label, as wide as the screen. */
    private fun sheetOpen(): Boolean {
        val root = ui.rootInActiveWindow ?: return false
        val queue = ArrayDeque<AccessibilityNodeInfo>()
        queue.add(root)
        var visited = 0
        while (queue.isNotEmpty() && visited < 6_000) {
            val node = queue.removeFirst()
            visited++
            if (label(node) == SITE_INFO_LABEL && !node.isClickable) {
                val bounds = Rect().also { node.getBoundsInScreen(it) }
                if (bounds.width() > width * 0.8) return true
            }
            for (i in 0 until node.childCount) node.getChild(i)?.let(queue::add)
        }
        return false
    }

    // --- checks and the dump -------------------------------------------------------------------

    private fun checkField() {
        val field = findNode { it.startsWith("$PILL_LABEL,") }
        if (field == null) {
            fail("no field labelled '$PILL_LABEL, <host>' in the pill")
            return
        }
        if (!field.isClickable) fail("the field '${label(field)}' is not clickable")
        Log.i(tag, "field: ${describe(field)}")
    }

    /**
     * A chip is a clickable button with its label that can open a popup and says whether the
     * popup is up (`ACTION_EXPAND` while closed, `ACTION_COLLAPSE` while open). The first two are
     * what the demo cannot do without; the popup flag and the expand state are what this Chromium
     * maps `aria-haspopup` and `aria-expanded` to, and are written down as seen.
     */
    private fun checkChip(label: String, expanded: Boolean) {
        val chip = findLabelled(label)
        if (chip == null) {
            fail("no chip labelled '$label' in the pill")
            return
        }
        if (!chip.isClickable) fail("the chip '$label' is not clickable")
        val className = chip.className?.toString().orEmpty()
        if (!className.endsWith("Button")) note("'$label' is exposed as $className, not a Button")
        if (!chip.canOpenPopup()) note("'$label' does not report canOpenPopup (aria-haspopup)")
        val actions = chip.actionList.map { it.id }
        val expectedAction = if (expanded) AccessibilityAction.ACTION_COLLAPSE.id else AccessibilityAction.ACTION_EXPAND.id
        val expectedName = if (expanded) "ACTION_COLLAPSE (aria-expanded=true)" else "ACTION_EXPAND (aria-expanded=false)"
        if (expectedAction !in actions) note("'$label' lacks $expectedName; actions ${actions.map(::actionName)}")
        Log.i(tag, "chip '$label' (${if (expanded) "expanded" else "collapsed"}): ${describe(chip)}")
    }

    private fun dump(name: String, group: AccessibilityNodeInfo) {
        val text = buildString {
            appendLine("# Address pill accessibility tree – $name")
            appendLine("# TalkBack: $talkBack")
            appendLine("# enabled_accessibility_services: ${Settings.Secure.getString(app.contentResolver, "enabled_accessibility_services")}")
            val manager = app.getSystemService(AccessibilityManager::class.java)
            appendLine("# touch exploration: ${manager.isTouchExplorationEnabled}; services: ${enabledServices()}")
            appendLine("# WebView: ${shell("dumpsys webviewupdate").lines().firstOrNull { it.contains("Current WebView package") }?.trim() ?: "?"}")
            appendLine()
            appendLine("## Nodes, depth first (the order TalkBack walks them)")
            fun visit(node: AccessibilityNodeInfo, depth: Int) {
                appendLine("  ".repeat(depth) + describe(node))
                for (i in 0 until node.childCount) node.getChild(i)?.let { visit(it, depth + 1) }
            }
            visit(group, 0)
            appendLine()
            appendLine("## What TalkBack stops at, and would say")
            for (node in speakable(group)) appendLine("- ${utterance(node)}")
            nextControl(group)?.let { appendLine("- (next, outside the pill) ${utterance(it)}") }
            appendLine()
            appendLine("## Notes so far")
            if (notes.isEmpty() && failures.isEmpty()) appendLine("none")
            notes.forEach { appendLine("note: $it") }
            failures.forEach { appendLine("FAIL: $it") }
        }
        File(out, "a11y-pill-chips-tree-$name.txt").writeText(text)
        Log.i(tag, text)
    }

    private fun describe(node: AccessibilityNodeInfo): String {
        val bounds = Rect().also { node.getBoundsInScreen(it) }
        return buildString {
            append(node.className ?: "?")
            append(" label=").append(quote(node.contentDescription))
            append(" text=").append(quote(node.text))
            roleDescription(node)?.let { append(" role=").append(quote(it)) }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) node.stateDescription?.let { append(" state=").append(quote(it)) }
            node.hintText?.let { append(" hint=").append(quote(it)) }
            append(" clickable=").append(node.isClickable)
            append(" focusable=").append(node.isFocusable)
            append(" focused=").append(node.isFocused)
            append(" a11yFocused=").append(node.isAccessibilityFocused)
            append(" canOpenPopup=").append(node.canOpenPopup())
            append(" visible=").append(node.isVisibleToUser)
            append(" actions=").append(node.actionList.map { actionName(it.id) })
            append(" bounds=").append(bounds.toShortString())
        }
    }

    /** Roughly TalkBack's announcement: label, role, expand state, and the activation hint. */
    private fun utterance(node: AccessibilityNodeInfo): String {
        val className = node.className?.toString().orEmpty()
        val role = roleDescription(node) ?: when {
            className.endsWith("Button") -> "button"
            className.endsWith("Spinner") -> "drop-down list"
            className.endsWith("EditText") -> "edit box"
            else -> null
        }
        val actions = node.actionList.map { it.id }
        val state = when {
            AccessibilityAction.ACTION_COLLAPSE.id in actions -> "expanded"
            AccessibilityAction.ACTION_EXPAND.id in actions -> "collapsed"
            else -> null
        }
        val popup = if (node.canOpenPopup()) "opens a popup" else null
        val hint = if (node.isClickable) "double-tap to activate" else null
        return listOfNotNull(label(node), role, state, popup, hint).joinToString(", ")
    }

    private fun roleDescription(node: AccessibilityNodeInfo): String? =
        node.extras.getCharSequence("AccessibilityNodeInfo.roleDescription")?.toString()

    private fun actionName(id: Int): String = when (id) {
        AccessibilityNodeInfo.ACTION_FOCUS -> "FOCUS"
        AccessibilityNodeInfo.ACTION_CLEAR_FOCUS -> "CLEAR_FOCUS"
        AccessibilityNodeInfo.ACTION_SELECT -> "SELECT"
        AccessibilityNodeInfo.ACTION_CLICK -> "CLICK"
        AccessibilityNodeInfo.ACTION_LONG_CLICK -> "LONG_CLICK"
        AccessibilityNodeInfo.ACTION_ACCESSIBILITY_FOCUS -> "ACCESSIBILITY_FOCUS"
        AccessibilityNodeInfo.ACTION_CLEAR_ACCESSIBILITY_FOCUS -> "CLEAR_ACCESSIBILITY_FOCUS"
        AccessibilityNodeInfo.ACTION_NEXT_AT_MOVEMENT_GRANULARITY -> "NEXT_AT_MOVEMENT_GRANULARITY"
        AccessibilityNodeInfo.ACTION_PREVIOUS_AT_MOVEMENT_GRANULARITY -> "PREVIOUS_AT_MOVEMENT_GRANULARITY"
        AccessibilityNodeInfo.ACTION_NEXT_HTML_ELEMENT -> "NEXT_HTML_ELEMENT"
        AccessibilityNodeInfo.ACTION_PREVIOUS_HTML_ELEMENT -> "PREVIOUS_HTML_ELEMENT"
        AccessibilityNodeInfo.ACTION_SCROLL_FORWARD -> "SCROLL_FORWARD"
        AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD -> "SCROLL_BACKWARD"
        AccessibilityNodeInfo.ACTION_EXPAND -> "EXPAND"
        AccessibilityNodeInfo.ACTION_COLLAPSE -> "COLLAPSE"
        AccessibilityNodeInfo.ACTION_SET_SELECTION -> "SET_SELECTION"
        AccessibilityNodeInfo.ACTION_SET_TEXT -> "SET_TEXT"
        AccessibilityAction.ACTION_SHOW_ON_SCREEN.id -> "SHOW_ON_SCREEN"
        AccessibilityAction.ACTION_CONTEXT_CLICK.id -> "CONTEXT_CLICK"
        else -> "0x${Integer.toHexString(id)}"
    }

    private fun noteEvent(event: AccessibilityEvent) {
        val interesting = event.eventType == AccessibilityEvent.TYPE_VIEW_ACCESSIBILITY_FOCUSED ||
            event.eventType == AccessibilityEvent.TYPE_VIEW_CLICKED ||
            event.eventType == AccessibilityEvent.TYPE_VIEW_FOCUSED ||
            event.eventType == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED ||
            event.eventType == AccessibilityEvent.TYPE_ANNOUNCEMENT
        if (!interesting) return
        val line = "${SystemClock.uptimeMillis()} ${AccessibilityEvent.eventTypeToString(event.eventType)} " +
            "pkg=${event.packageName} class=${event.className} desc=${quote(event.contentDescription)} " +
            "text=${event.text}"
        synchronized(events) { events.appendLine(line) }
    }

    private fun fail(message: String) {
        Log.e(tag, "FAIL: $message")
        failures += message
    }

    private fun note(message: String) {
        Log.w(tag, "note: $message")
        notes += message
    }

    private fun quote(value: CharSequence?): String = if (value == null) "null" else "\"$value\""

    private fun slug(label: String): String =
        label.lowercase().replace(Regex("[^a-z0-9]+"), "-").trim('-').take(32)

    private fun shell(command: String): String {
        val fd = ui.executeShellCommand(command)
        return FileInputStream(fd.fileDescriptor).use { it.readBytes().toString(Charsets.UTF_8) }.also { fd.close() }
    }

    private companion object {
        const val SITE_INFO_LABEL = "Site information"
        const val LOCK_LABEL = "Connection is secure"
        const val TALKBACK_PACKAGE = "com.google.android.marvin.talkback"
        const val TALKBACK_SERVICE = "$TALKBACK_PACKAGE/$TALKBACK_PACKAGE.TalkBackService"
    }
}
