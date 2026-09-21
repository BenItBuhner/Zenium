package app.zen.chromium

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * The host's side of private browsing beyond the profile: the window's screenshot guard goes up
 * exactly while the chrome says the surface is private (a recording is let in only when asked,
 * which [PrivateBrowsing.guard] allows in debug builds alone), and the launcher's static shortcut
 * reaches `MainActivity` – through `LauncherIconActivity`, the trampoline outside the browser's
 * task – with the action the activity turns into a private tab. The resource wiring is checked
 * from the files: a shortcut whose meta-data, id, action or target drifted would install and
 * never open anything.
 */
class PrivateBrowsingTest {
    private fun read(vararg candidates: String): String {
        val file = candidates.map(::File).firstOrNull { it.exists() }
        assertTrue("${candidates.first()} not found from ${File(".").absolutePath}", file != null)
        return file!!.readText()
    }

    @Test
    fun theGuardGoesUpOnThePrivateSurfaceAloneAndARecordingTakesItDown() {
        assertTrue(PrivateBrowsing.guardWanted(privateSurface = true, recording = false))
        assertFalse(PrivateBrowsing.guardWanted(privateSurface = false, recording = false))
        assertFalse(PrivateBrowsing.guardWanted(privateSurface = true, recording = true))
        assertFalse(PrivateBrowsing.guardWanted(privateSurface = false, recording = true))
        // The override is off until a recording driver turns it on.
        assertFalse(PrivateBrowsing.captureForRecording)
    }

    /**
     * INC-05: the lock cover is drawn on the private surface, so the chrome's word keeps the
     * guard up under it; the host's own hidden private views (the frames between the app's
     * return and the chrome's next report) keep it up on their own too. Neither reads whether
     * private tabs merely exist: a regular page with the private tabs locked behind it captures
     * as before, and a recording is let in as before.
     */
    @Test
    fun theGuardStaysUpUnderTheLockCover() {
        assertTrue(PrivateBrowsing.guardWanted(privateSurface = true, recording = false, lockedContent = true))
        assertTrue(PrivateBrowsing.guardWanted(privateSurface = false, recording = false, lockedContent = true))
        assertFalse(PrivateBrowsing.guardWanted(privateSurface = false, recording = false, lockedContent = false))
        assertFalse(PrivateBrowsing.guardWanted(privateSurface = true, recording = true, lockedContent = true))
    }

    /**
     * The guard has one owner: the chrome's `window.setSecure`, through [PrivateBrowsing.guard].
     * A second writer reading the page views' visibility (the private session's first cut) missed
     * the private new tab page, which has no page view, kept the overview's Tabs pane guarded
     * while private tabs existed, and wrote past the recording override; the flag is written in
     * the one file.
     */
    @Test
    fun theGuardHasOneOwner() {
        val sources = listOf("src/main/kotlin", "app/src/main/kotlin").map(::File).firstOrNull { it.isDirectory }
        assertTrue("src/main/kotlin not found from ${File(".").absolutePath}", sources != null)
        val writers = sources!!.walkTopDown()
            .filter { it.extension == "kt" && "LayoutParams.FLAG_SECURE" in it.readText() }
            .map { it.name }
            .toList()
        assertEquals(listOf("PrivateBrowsing.kt"), writers)
    }

    private fun shortcuts() = read(SHORTCUTS_TEMPLATE, "app/$SHORTCUTS_TEMPLATE")

    @Test
    fun theShortcutOpensAPrivateTabInTheBrowserActivityThroughTheTrampoline() {
        val shortcuts = shortcuts()
        val shortcut = shortcuts.substringAfter("<shortcut").substringBefore("</shortcut>")
        assertTrue("""android:shortcutId="${PrivateBrowsing.SHORTCUT_ID}"""" in shortcut)
        assertTrue("""android:enabled="true"""" in shortcut)
        assertTrue("""android:action="${PrivateBrowsing.ACTION_NEW_TAB}"""" in shortcut)
        // The system stamps a manifest shortcut's intent with FLAG_ACTIVITY_CLEAR_TASK: aimed at
        // MainActivity it would clear the browser's task; the trampoline in its own task relays
        // the action into the running window instead.
        assertTrue("""android:targetClass="app.zen.chromium.LauncherIconActivity"""" in shortcut)
        assertFalse("""android:targetClass="app.zen.chromium.MainActivity"""" in shortcut)
        val manifest = read("src/main/AndroidManifest.xml", "app/src/main/AndroidManifest.xml")
        val trampoline = manifest.substringAfter("android:name=\".LauncherIconActivity\"").substringBefore("/>")
        assertTrue("""android:taskAffinity=""""" in trampoline)
        assertTrue("""android:noHistory="true"""" in trampoline)
        // One shortcut: the launcher shows the app's own before any pinned web app.
        assertEquals(1, Regex("<shortcut\\s").findAll(shortcuts).count())
    }

    @Test
    fun theTrampolineForwardsTheShortcutsActionAndNothingElse() {
        assertEquals(PrivateBrowsing.ACTION_NEW_TAB, PrivateBrowsing.forwardedAction(PrivateBrowsing.ACTION_NEW_TAB))
        // A launcher tap on an icon alias, or any other start, is the launcher's plain start.
        assertEquals(null, PrivateBrowsing.forwardedAction("android.intent.action.MAIN"))
        assertEquals(null, PrivateBrowsing.forwardedAction("android.intent.action.VIEW"))
        assertEquals(null, PrivateBrowsing.forwardedAction(null))
    }

    /**
     * The system server reads the intent's targetPackage as a plain string with its own resources:
     * an @string reference of the app's installs a shortcut to "@<id>/MainActivity" that nothing
     * can start. So the file is a template the build writes per variant with the applicationId
     * spelt out (debug carries a suffix), and no copy of it sits in res/ to shadow the written one.
     */
    @Test
    fun theShortcutTargetsTheVariantsApplicationIdSpeltOut() {
        val shortcut = shortcuts().substringAfter("<shortcut").substringBefore("</shortcut>")
        assertTrue("""android:targetPackage="${'$'}{applicationId}"""" in shortcut)
        assertFalse("@string" in shortcut.substringAfter("<intent"))
        val build = read("build.gradle.kts", "app/build.gradle.kts")
        assertTrue("class WriteShortcuts" in build)
        assertTrue("""file("$SHORTCUTS_TEMPLATE")""" in build)
        assertTrue("""replace("\${'$'}{applicationId}", applicationId.get())""" in build)
        assertTrue("addGeneratedSourceDirectory(write, WriteShortcuts::outputDirectory)" in build)
        assertTrue("""resolve("xml/shortcuts.xml")""" in build)
        assertFalse(File("src/main/res/xml/shortcuts.xml").exists() || File("app/src/main/res/xml/shortcuts.xml").exists())
    }

    @Test
    fun theShortcutsLabelsAndIconExist() {
        val shortcuts = shortcuts()
        val strings = read("src/main/res/values/strings.xml", "app/src/main/res/values/strings.xml")
        for (name in listOf("shortcut_private_short", "shortcut_private_long")) {
            assertTrue("$name unused", """@string/$name"""" in shortcuts)
            assertTrue("$name undefined", """<string name="$name">""" in strings)
        }
        // Sentence case, following the platform (Chrome's "New incognito tab"), not the Title Case
        // of the menus inside the app (design language v2 9.1); one strings file, so every variant's
        // generated shortcuts.xml resolves the same labels.
        assertTrue("""<string name="shortcut_private_short">New private tab</string>""" in strings)
        assertTrue("""<string name="shortcut_private_long">New private tab in Zenium</string>""" in strings)
        assertTrue("""android:icon="@drawable/ic_shortcut_private"""" in shortcuts)
        val icon = read(
            "src/main/res/drawable/ic_shortcut_private.xml",
            "app/src/main/res/drawable/ic_shortcut_private.xml"
        )
        assertTrue("<adaptive-icon" in icon)
        assertTrue("@drawable/ic_shortcut_private_foreground" in icon)
        assertTrue("@color/shortcut_private_background" in icon)
    }

    @Test
    fun everyLauncherAliasDeclaresTheShortcuts() {
        val manifest = read("src/main/AndroidManifest.xml", "app/src/main/AndroidManifest.xml")
        val meta = """<meta-data android:name="android.app.shortcuts" android:resource="@xml/shortcuts" />"""
        val aliases = manifest.split("<activity-alias").drop(1)
        assertEquals(LauncherIconVariants.ALIASES.size, aliases.size)
        for (alias in aliases) {
            val body = alias.substringBefore("</activity-alias>")
            assertTrue("an alias without the shortcuts: ${body.lines().first()}", meta in body)
            assertTrue("android.intent.category.LAUNCHER" in body)
        }
        // The browser activity itself holds no launcher entry, so the meta-data would be dead there.
        val activity = manifest.substringAfter("android:name=\".MainActivity\"").substringBefore("</activity>")
        assertFalse("android.app.shortcuts" in activity)
    }

    private companion object {
        const val SHORTCUTS_TEMPLATE = "src/main/shortcuts/shortcuts.xml"
    }
}
