package app.zen.chromium

import android.content.Intent
import android.graphics.PointF
import android.graphics.Rect
import android.os.SystemClock
import android.provider.Settings
import android.util.Base64
import android.view.accessibility.AccessibilityNodeInfo
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONObject
import org.junit.runner.RunWith
import java.io.File
import java.util.Locale
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Records the UI half of the sync-history package on the phone – "Tabs from other devices"
 * (ID-28) and "Send to your devices" (ID-27), `pages/settings/sync.tsx` and
 * `phone/SendTabSheet.tsx` – against the real engine and a real document tree, and the device
 * scene the Android nod on #302 (`WebNotifications.kt`) left to this half: a tab another device
 * sent arriving as a document in the folder, the notification posted under the app's Sharing
 * channel, its tap opening the URL in a regular tab from the FOREGROUND (here) and from a COLD
 * START (the shell's half of the same run, `android-sync-history-cold-start.sh`: this process
 * gone, the second card still on the shade, a tap from the shade, the profile's `state.json`
 * read for the tab), and the channel visible beside the sites' group in the app's notification
 * settings.
 *
 * Built on [SyncDemoBase] (the sequence [SyncDemo] records as is): the same Settings › Sync
 * entry, the folder granted through the system's picker with a finger, the passphrase sheet, the
 * Open tabs toggle, the shell as the other
 * devices' sync client ([SyncPeer]: the folder's salt, the same passphrase, AES-GCM under the
 * shared key). Two other devices this time – the picker is for two or more (one device, and the
 * menu names it) – each with a device file and an `open-tabs` document (W4-3's `.zenpage`), so
 * the Tabs from other devices row reads "5 tabs on 2 devices" and the picker lists both.
 *
 * The sequence: the app menu as the frame baseline; Settings › Sync set up; the two devices
 * publish and Sync now lands them; the Tabs from other devices sheet as a frame scene (a finger on
 * its row, settled, a back) and then for real – a finger on a tab of the laptop's, the sheet
 * goes and that page opens as a new tab in front; the Send to your devices picker as a frame scene
 * (a finger on the menu's Send to Your Devices…, the menu leaving as the picker rises, a back)
 * and then for real – a finger on the laptop's row, the sheet goes, the engine's toast, the
 * laptop's inbox document in the tree (decrypted here under the shared key: the page's URL, this
 * device as the sender); the laptop sends a page back: its document in the tree, Sync now, the
 * document consumed, the Sharing card on the shade (`dumpsys notification`), the shade opened,
 * the card tapped with a finger, the URL open as a regular tab of the default container; the
 * app's notification settings with the Sharing channel and the Sites group (the demo page posted
 * one notification of its own off camera, under a seeded permission, so the group exists); and
 * the laptop sends once more – the second card posted and left on the shade for the shell's
 * cold-start tap, its title and URL written to `cold-start.json` for the shell to read.
 *
 * The rule in [DemoHarness] (#194's audit, #198): every control inside a sheet – the menu's rows,
 * the picker's, the tab rows of the remote list, the shade's card – is a real injected touch whose
 * effect is asserted against the core's state, the tree or the shade; a touch that did not take
 * is a [touchFault] the run fails on at its end. Frames: every sheet of this PR is a scene of
 * [traceFrames] (`open` kind: the finger, then the motion's time; the chrome's Chromium trace
 * around it), read against the app menu's same two scenes, a sheet main had before this PR.
 */
@RunWith(AndroidJUnit4::class)
class SyncHistoryDemo : SyncDemoBase("sync-demo-state.json", "services-sync-history-ui-android", "sync-history-demo") {
    override val tag: String = "SyncHistoryDemo"
    /** The claims that failed (a finding, not a touch fault); the run fails on them at the end. */
    private val failures = ArrayList<String>()
    /** The folder's key, derived once (scrypt takes its seconds on the device); the other devices share it. */
    private var peerKey: ByteArray? = null

    /**
     * The demo page's notification permission, granted ahead of the run (`permissions.json`: the
     * core's own store, one decision per `origin|permission`): the page posts one notification off
     * camera in the warm-up so the site's channel and the Sites group exist beside Sharing in the
     * app's notification settings – the nod asks for the channel beside the sites' group.
     */
    override fun seedMore(zen: File) {
        File(zen, "permissions.json").writeText(
            JSONObject().put("version", 1)
                .put("decisions", JSONObject().put("$DEMO_ORIGIN|notifications", "allow"))
                .toString()
        )
    }

    override fun warmUp() {
        super.warmUp()
        postSiteNotification()
    }

    override fun demo() {
        // 0. The frame baseline: the app menu, a sheet main had before this PR, opened with a
        //    finger and closed with a back, the two `open` scenes the PR's sheets are read against.
        note("\n0. the frame baseline: the app menu")
        menuBaseline()

        // 1. Settings › Sync set up: the folder, the passphrase, Open tabs on.
        note("\n1. Settings › Sync")
        openSyncSettings()
        grantFolder()
        turnOnSync(firstTime = true)
        flipOpenTabs()
        snap("settings-connected")
        note("  ${describeSync()}")

        // 2. Two other devices publish their files and their open tabs; Sync now lands them.
        note("\n2. the other devices")
        seedPeers()
        syncOnce("the other devices' files")
        assertDevicesListed()
        revealRow(REMOTE_TABS_LABEL)
        SystemClock.sleep(800)
        snap("settings-other-devices")

        // 3. Tabs from other devices: the sheet as a frame scene, then a tab opened from it.
        note("\n3. Tabs from other devices (ID-28)")
        remoteTabsScene()
        openRemoteTab()

        // 4. Send to your devices: the picker as a frame scene, then a send to the laptop.
        note("\n4. Send to your devices (ID-27)")
        sendTabScene()
        sendToLaptop()

        // 5. The device scene: a page the laptop sent arrives, the Sharing card, the tap from the foreground.
        note("\n5. a tab from the laptop: the notification, tapped from the foreground")
        val arrived = inboxArrives(SEND_ID, SENT_URL, SENT_TITLE)
        tapNotificationInForeground(arrived)

        // 6. The channel beside the sites' group in the app's notification settings.
        note("\n6. the Sharing channel in the app's notification settings")
        notificationSettings()

        // 7. A second page from the laptop, its card left on the shade for the shell's cold start.
        note("\n7. a second tab from the laptop, staged for the cold start")
        stageColdStart()

        noteFrameScenes()
        note("\n${if (failures.isEmpty()) "all claims held" else "${failures.size} claim(s) FAILED: ${failures.joinToString("; ")}"}")
        note("done in ${(SystemClock.uptimeMillis() - startedAt) / 1000} s")
        if (failures.isNotEmpty()) throw AssertionError("${failures.size} claim(s) failed: ${failures.joinToString("; ")}")
    }

    // --- 0. the baseline -------------------------------------------------------------------------

    /** The app menu under a finger on the bar's Menu button, then a back: the two baseline scenes. */
    private fun menuBaseline() {
        ensureForeground()
        if (sheetCount() != 0) closeSheets()
        val button = findByLabel(MENU_LABEL)
        traceFrames(SCENE_MENU_OPEN, JankBudget.Kind.OPEN) {
            if (button != null) Finger().tap(button.exactCenterX(), button.exactCenterY()) else tapMenuButton()
            SystemClock.sleep(MOTION_MS)
        }
        val up = waitFor(MENU_HANDLE_LABEL, 6_000) != null
        note("  the app menu ${if (up) "opened under the finger" else "did NOT show its handle on the tree"}")
        if (!up) touchFault("the bar's Menu button did not open the app menu")
        traceFrames(SCENE_MENU_CLOSE, JankBudget.Kind.OPEN) {
            back()
            SystemClock.sleep(MOTION_MS)
        }
        awaitNoSheet()
        recoverUrlField("the app menu")
    }

    // --- 2. the other devices --------------------------------------------------------------------

    /**
     * Two other Zeniums' files into the tree by the shell, as their sync clients would upload them:
     * each a device file (an empty record set: nothing of theirs enters this device's spaces, so
     * every tab of the remote list is one this device does not hold) and an `open-tabs` document,
     * the laptop's the newer. The key is derived once from the folder's salt (read off this
     * device's own file) and the passphrase, and kept for the documents that follow.
     */
    private fun seedPeers() {
        val key = sharedKey()
        val salt = peerSalt ?: error("no salt")
        val now = System.currentTimeMillis()
        writeDevice(PEER_ID, PEER_NAME, now, key, salt, laptopTabs(now))
        writeDevice(PEER2_ID, PEER2_NAME, now - 5 * 60_000, key, salt, tabletTabs(now))
        note("  tree: ${treeListing()}")
    }

    private fun writeDevice(id: String, name: String, at: Long, key: ByteArray, salt: String, tabs: List<JSONObject>) {
        val dir = "$FOLDER_PATH/${SyncPeer.DIR_NAME}"
        val file = SyncPeer.deviceFile(id, name, at, SyncPeer.encrypt(key, salt, SyncPeer.payload(emptyList())))
        writeTree("$dir/${SyncPeer.deviceFileName(id)}", file)
        val document = SyncPeer.document("open-tabs", id, name, at, SyncPeer.encrypt(key, salt, SyncPeer.openTabsPayload(tabs)))
        writeTree("$dir/${SyncPeer.openTabsName(id)}", document)
        note("  '$name' wrote its device file and its open tabs (${tabs.size}: ${tabs.joinToString { it.getString("title") }})")
    }

    private fun laptopTabs(now: Long): List<JSONObject> = listOf(
        SyncPeer.remoteTab(LAPTOP_TAB_ID, LAPTOP_TAB_URL, LAPTOP_TAB_TITLE, now - 2 * 60_000),
        SyncPeer.remoteTab("tab_worklaptop_2", "https://github.com/BenItBuhner/Zenium", "Zenium on GitHub", now - 40 * 60_000),
        SyncPeer.remoteTab("tab_worklaptop_3", "https://developer.mozilla.org/en-US/docs/Web/API/Push_API", "Push API - Web APIs | MDN", now - 3 * 3_600_000)
    )

    private fun tabletTabs(now: Long): List<JSONObject> = listOf(
        SyncPeer.remoteTab("tab_kitchentablet_1", "https://example.com/recipes/weeknight-pasta", "Weeknight pasta", now - 26 * 3_600_000),
        SyncPeer.remoteTab("tab_kitchentablet_2", "https://www.bbc.com/weather", "BBC Weather", now - 2 * 86_400_000)
    )

    /** The key the other devices encrypt under: the folder's salt off this device's file, the passphrase, scrypt once. */
    private fun sharedKey(): ByteArray {
        peerKey?.let { return it }
        val dir = "$FOLDER_PATH/${SyncPeer.DIR_NAME}"
        val mine = SyncPeer.deviceFileName(syncStatus().getString("deviceId"))
        val mineText = shell("cat $dir/$mine")
        val salt = runCatching { SyncPeer.saltOf(mineText) }.getOrElse {
            note("  this device's file could not be read: ${mineText.take(120)}")
            error("no salt to derive the other devices' key from")
        }
        peerSalt = salt
        val started = SystemClock.uptimeMillis()
        val key = SyncPeer.deriveKey(PASSPHRASE, salt)
        note("  key derived on the device in ${SystemClock.uptimeMillis() - started} ms from the folder's salt $salt")
        peerKey = key
        return key
    }

    /** A file into the tree through the shell (the app has no leave to write the device's storage itself); read back to be sure. */
    private fun writeTree(path: String, text: String) {
        val encoded = Base64.encodeToString(text.toByteArray(), Base64.NO_WRAP)
        shell("mkdir -p ${path.substringBeforeLast('/')}; echo $encoded | base64 -d > $path")
        val back = shell("cat $path")
        if (back != text) {
            note("  the tree did not keep ${path.substringAfterLast('/')} as written (${back.length} of ${text.length} bytes)")
            error("a document did not land in the tree")
        }
    }

    /** A finger on Sync now; the sync it starts must finish (`lastSyncAt` moves). The Settings › Sync page must be up. */
    private fun syncOnce(why: String) {
        val before = syncStatus().optLong("lastSyncAt", 0)
        if (!tapRow(SYNC_NOW_LABEL, "sync-now") { syncStatus().getBoolean("syncing") || syncStatus().optLong("lastSyncAt", 0) > before }) {
            touchFault("the Sync now row did not start a sync under a finger ($why)")
            coreInvoke("sync.now")
        }
        if (!awaitSettled({ syncStatus().optLong("lastSyncAt", 0) > before }, 30_000)) note("  the sync did not finish: ${describeSync()}")
        else note("  synced ($why): ${syncNowRowText()}")
        SystemClock.sleep(600)
    }

    /** Both devices in the core's list and on the page; the remote list holds their five tabs. */
    private fun assertDevicesListed() {
        val devices = syncStatus().getJSONArray("devices").let { d -> (0 until d.length()).map { d.getJSONObject(it).optString("name") } }
        note("  device list: $devices")
        check(PEER_NAME in devices && PEER2_NAME in devices, "the two other devices are not both in the list: $devices")
        val lists = JSONObject("""{"devices":${coreInvoke("sync.tabsFromDevices")}}""").getJSONArray("devices")
        val summary = (0 until lists.length()).map { lists.getJSONObject(it) }
            .map { "${it.optString("deviceName")} ${it.optJSONArray("tabs")?.length() ?: 0}" }
        note("  sync.tabsFromDevices: $summary")
        check(lists.length() == 2, "the core does not list two devices' tabs: $summary")
        val read = awaitRowReads(REMOTE_TABS_LABEL, "sync-remote-tabs", REMOTE_TABS_SUMMARY, 10_000)
        if (read == null) {
            fail("the Tabs from other devices row does not read '$REMOTE_TABS_SUMMARY': ${rowText(REMOTE_TABS_LABEL)}; the chrome's document: ${describeChromeRow("sync-remote-tabs")}")
        } else {
            note("  the row reads: $read")
        }
    }

    // --- 3. Tabs from other devices --------------------------------------------------------------

    /**
     * The sheet as a frame scene: the row's touch point read before the clock starts (its bounds
     * inside the page's band, [pageBand]), the finger and the sheet's rise inside the `open`
     * scene, the title awaited after it; then a back as the `close` scene.
     */
    private fun remoteTabsScene() {
        val point = pageRowPoint(REMOTE_TABS_LABEL) ?: run {
            fail("no Tabs from other devices row inside the page's band to touch")
            return
        }
        traceFrames(SCENE_REMOTE_OPEN, JankBudget.Kind.OPEN, baseline = SCENE_MENU_OPEN) {
            Finger().tap(point.x, point.y)
            SystemClock.sleep(MOTION_MS)
        }
        if (waitFor(REMOTE_TABS_LABEL, 6_000) == null || sheetCount() == 0) {
            touchFault("the touch on the Tabs from other devices row did not open its sheet")
            recoverUrlField("the Tabs from other devices row")
            return
        }
        note("  the sheet is up: ${sheetRowsNoted()}")
        snap("remote-tabs-sheet")
        traceFrames(SCENE_REMOTE_CLOSE, JankBudget.Kind.OPEN, baseline = SCENE_MENU_CLOSE) {
            back()
            SystemClock.sleep(MOTION_MS)
        }
        if (!awaitSettled({ sheetCount() == 0 }, 8_000)) {
            note("  the sheet did not go on a back")
            closeSheets()
        }
        SystemClock.sleep(600)
    }

    /**
     * For real: the row's sheet, a finger on the laptop's newest tab (its title reads first in
     * the laptop's group), and the claim – the sheet gone, a NEW tab with that URL active in the
     * default container (this device held no tab of that id, so the row created one).
     */
    private fun openRemoteTab() {
        val tabsBefore = coreState().getJSONObject("tabs").length()
        if (!tapRow(REMOTE_TABS_LABEL, "sync-remote-tabs", timeoutMs = 10_000) { sheetCount() > 0 && findByLabel(REMOTE_TABS_LABEL) != null }) {
            fail("the Tabs from other devices row did not open its sheet")
            return
        }
        SystemClock.sleep(1_000)
        val laptop = findNode { it == PEER_NAME }
        note("  the laptop's group heading ${if (laptop != null) "is on the tree" else "is NOT on the tree"}")
        val took = touchTapLabelExpecting(LAPTOP_TAB_TITLE, "a new tab with the laptop's page is active", prefix = true, timeoutMs = 10_000) {
            activeCoreTab()?.optString("url") == LAPTOP_TAB_URL
        }
        if (!took) {
            note("  the row did not take; opening the page through the core so the demo goes on")
            closeSheets()
            coreInvoke("tab.create", """{"url":${JSONObject.quote(LAPTOP_TAB_URL)},"active":true}""")
            awaitSettled({ activeCoreTab()?.optString("url") == LAPTOP_TAB_URL }, 8_000)
        }
        awaitNoSheet()
        val tab = activeCoreTab()
        val tabsAfter = coreState().getJSONObject("tabs").length()
        check(tab?.optString("url") == LAPTOP_TAB_URL, "the active tab is not the laptop's page: ${tab?.optString("url")}")
        check(tab?.optString("containerId", "default") != PRIVATE_CONTAINER, "the laptop's page opened in the private container")
        check(tabsAfter == tabsBefore + 1, "the row did not open exactly one new tab ($tabsBefore -> $tabsAfter)")
        note("  active tab: '${tab?.optString("title")}' ${tab?.optString("url")} container=${tab?.optString("containerId", "default")}; tabs $tabsBefore -> $tabsAfter")
        SystemClock.sleep(2_000)
        snap("remote-tab-opened")
        recoverUrlField("the remote tab's row")
    }

    // --- 4. Send to your devices -----------------------------------------------------------------

    /**
     * The picker as a frame scene from the demo page: the menu pulled up with a finger and its
     * Send to Your Devices… row's point read before the clock starts; inside the `open` scene the
     * finger, the menu leaving and the picker rising in its place; then a back as the `close`.
     */
    private fun sendTabScene() {
        ensureDemoTab()
        val point = menuRowPoint(SEND_LABEL) ?: run {
            fail("no '$SEND_LABEL' row in the app menu to touch")
            closeSheets()
            return
        }
        traceFrames(SCENE_PICKER_OPEN, JankBudget.Kind.OPEN, baseline = SCENE_MENU_OPEN) {
            Finger().tap(point.x, point.y)
            SystemClock.sleep(MOTION_MS)
        }
        if (waitFor(PICKER_TITLE, 6_000) == null) {
            touchFault("the touch on '$SEND_LABEL' did not open the picker")
            closeSheets()
            return
        }
        note("  the picker is up: ${sheetRowsNoted()}")
        snap("send-picker")
        traceFrames(SCENE_PICKER_CLOSE, JankBudget.Kind.OPEN, baseline = SCENE_MENU_CLOSE) {
            back()
            SystemClock.sleep(MOTION_MS)
        }
        if (!awaitSettled({ sheetCount() == 0 }, 8_000)) {
            note("  the picker did not go on a back")
            closeSheets()
        }
        val gone = waitForGone(PICKER_TITLE, 6_000)
        note("  the picker ${if (gone) "left the tree" else "is STILL on the tree"} after the back")
        SystemClock.sleep(600)
    }

    /**
     * For real: the picker once more, a finger on the laptop's row, and the claims – the sheet
     * gone, the engine's toast, the laptop's inbox document in the tree, and under the shared key
     * the page's URL with this device as the sender.
     */
    private fun sendToLaptop() {
        ensureDemoTab()
        watchToasts()
        val point = menuRowPoint(SEND_LABEL) ?: run {
            fail("no '$SEND_LABEL' row in the app menu to touch (second time)")
            closeSheets()
            return
        }
        Finger().tap(point.x, point.y)
        if (waitFor(PICKER_TITLE, 8_000) == null) {
            touchFault("the touch on '$SEND_LABEL' did not open the picker (second time)")
            closeSheets()
            return
        }
        SystemClock.sleep(1_000)
        val before = inboxFiles(PEER_ID)
        val myId = syncStatus().getString("deviceId")
        val took = touchTapLabelExpecting("$PEER_NAME, Last active", "the laptop's inbox document is in the tree", prefix = true, timeoutMs = 15_000) {
            inboxFiles(PEER_ID).size > before.size
        }
        if (!took) {
            note("  the picker's row did not take; sending through the core so the demo goes on")
            closeSheets()
            coreInvoke("sync.sendTab", """{"deviceId":"$PEER_ID","url":${JSONObject.quote(DEMO_URL)},"tabId":"$DEMO_TAB"}""")
            awaitSettled({ inboxFiles(PEER_ID).size > before.size }, 15_000)
        }
        val toast = awaitToastSeen("Sent to $PEER_NAME", 8_000)
        note("  toast 'Sent to $PEER_NAME': ${if (toast) "seen" else "NOT seen"}")
        if (!toast) fail("no 'Sent to $PEER_NAME' toast")
        snap("sent")
        awaitNoSheet()
        val files = inboxFiles(PEER_ID) - before
        check(files.size == 1, "the send left ${files.size} inbox documents for the laptop: $files")
        val name = files.firstOrNull() ?: return
        val text = shell("cat $FOLDER_PATH/${SyncPeer.DIR_NAME}/$name")
        val document = runCatching { JSONObject(text) }.getOrNull()
        check(document?.optString("kind") == "send-tab", "$name is not a send-tab document: ${text.take(160)}")
        check(document?.optString("deviceId") == myId, "$name names ${document?.optString("deviceId")} as the sender, not this device $myId")
        val plain = runCatching { JSONObject(SyncPeer.decrypt(sharedKey(), document!!.getJSONObject("envelope"))) }.getOrNull()
        note("  $name under the shared key: ${plain?.toString()?.take(240)}")
        check(plain?.optString("url") == DEMO_URL, "the sent page is ${plain?.optString("url")}, not $DEMO_URL")
        check(plain?.optJSONObject("from")?.optString("id") == myId, "the document's from.id is not this device")
        check(plain?.optJSONObject("from")?.optString("name") == syncStatus().optString("deviceName"), "the document's from.name is not this device's name")
        recoverUrlField("the picker's row")
    }

    // --- 5. the device scene: a tab from the laptop ----------------------------------------------

    /** What the driver knows of a card it expects on the shade. */
    private class Arrival(val title: String, val body: String, val url: String, val tabsBefore: Int)

    /**
     * The laptop sends this device a page: its document into the tree by the shell
     * (`<thisDevice>.inbox.<sendId>.zenpage`), Sync now with a finger on Settings › Sync, and the
     * claims – the document consumed (gone from the tree), NO tab opened by the sync itself, the
     * card on the shade under the Sharing channel (`dumpsys notification`, the app's package and
     * `zenium.sharing` and the title in one record).
     */
    private fun inboxArrives(sendId: String, url: String, title: String): Arrival {
        val myId = syncStatus().getString("deviceId")
        val key = sharedKey()
        val salt = peerSalt ?: error("no salt")
        val now = System.currentTimeMillis()
        val name = SyncPeer.inboxName(myId, sendId)
        val document = SyncPeer.document(
            "send-tab", PEER_ID, PEER_NAME, now,
            SyncPeer.encrypt(key, salt, SyncPeer.sendTabPayload(sendId, url, title, now, PEER_ID, PEER_NAME))
        )
        writeTree("$FOLDER_PATH/${SyncPeer.DIR_NAME}/$name", document)
        note("  '$PEER_NAME' sent '$title' ($url) as $name; tree: ${treeListing()}")
        toSyncSettings()
        val tabsBefore = coreState().getJSONObject("tabs").length()
        syncOnce("the laptop's sent tab")
        val consumed = awaitSettled({ !treeListing().contains(name) }, 10_000)
        note("  the document ${if (consumed) "is gone from" else "is STILL in"} the tree after the sync")
        if (!consumed) fail("the sent tab's document was not consumed")
        val tabsAfter = coreState().getJSONObject("tabs").length()
        check(tabsAfter == tabsBefore, "the sync itself opened a tab ($tabsBefore -> $tabsAfter); the card should have carried it")
        val cardTitle = "Tab from $PEER_NAME"
        val posted = awaitSettled({ sharingCardPosted(cardTitle) }, 10_000)
        note("  the shade: ${describeSharingCards()}")
        if (!posted) fail("no Sharing card reading '$cardTitle' in dumpsys notification")
        return Arrival(cardTitle, title, url, tabsBefore)
    }

    /**
     * The shade opened (the accessibility global action: the same swipe from the top), the card
     * found by its title in SystemUI's window, a still, and a finger on it: MainActivity gets the
     * tap's intent (`WebNotifications.onOpenIntent` → `notification.event` `click` with the URL),
     * and the core – which never showed this card itself – opens the URL as a tab in front. The
     * claims: a new tab, active, the URL, the default container (regular, not private), the card
     * gone from the shade (auto-cancel).
     */
    private fun tapNotificationInForeground(arrival: Arrival) {
        ensureForeground()
        val card = openShadeAndFind(arrival.title)
        snap("notification-shade")
        if (card == null) {
            fail("the card '${arrival.title}' is not on the shade")
            dismissShade()
            return
        }
        val bounds = Rect().also(card::getBoundsInScreen)
        note("  the card on the shade: ${describeNode(card)}")
        Finger().tap(bounds.exactCenterX(), bounds.exactCenterY())
        val opened = awaitSettled({ activeCoreTab()?.optString("url") == arrival.url }, 12_000)
        if (!opened) {
            touchFault("the finger on the shade's card did not open ${arrival.url}: active tab ${activeCoreTab()?.optString("url")}")
            dismissShade()
            return
        }
        awaitSurface(up = true, timeoutMs = 6_000)
        SystemClock.sleep(1_500)
        val tab = activeCoreTab()
        val tabs = coreState().getJSONObject("tabs").length()
        check(tab?.optString("containerId", "default") != PRIVATE_CONTAINER, "the sent tab opened in the private container")
        check(tabs == arrival.tabsBefore + 1, "the tap did not open exactly one new tab (${arrival.tabsBefore} -> $tabs)")
        val gone = awaitSettled({ !sharingCardPosted(arrival.title) }, 6_000)
        note("  the tap took: active tab '${tab?.optString("title")}' ${tab?.optString("url")} container=${tab?.optString("containerId", "default")}; tabs ${arrival.tabsBefore} -> $tabs; the card ${if (gone) "left the shade" else "is STILL on the shade"}")
        if (!gone) fail("the tapped card stayed on the shade")
        snap("notification-opened")
    }

    /** The shade opened and polled for a SystemUI node reading `title`; null when none shows within the time. */
    private fun openShadeAndFind(title: String): AccessibilityNodeInfo? {
        ui.performGlobalAction(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_NOTIFICATIONS)
        val deadline = SystemClock.uptimeMillis() + 8_000
        while (SystemClock.uptimeMillis() < deadline) {
            findInWindows(SYSTEM_UI) { it == title }?.let {
                SystemClock.sleep(1_200)
                return findInWindows(SYSTEM_UI) { text -> text == title } ?: it
            }
            SystemClock.sleep(300)
        }
        return null
    }

    private fun dismissShade() {
        ui.performGlobalAction(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_DISMISS_NOTIFICATION_SHADE)
        SystemClock.sleep(1_000)
        ensureForeground()
    }

    /** Whether `dumpsys notification` lists a card of the app's under the Sharing channel whose title reads `title`. */
    private fun sharingCardPosted(title: String): Boolean =
        sharingRecords().any { it.contains(SHARING_CHANNEL) && it.contains(title) }

    /** The app's notification records out of the dump (each `NotificationRecord(` block up to the next). */
    private fun sharingRecords(): List<String> {
        val dump = shell("dumpsys notification --noredact 2>/dev/null")
        return dump.split("NotificationRecord(").drop(1).filter { it.contains("pkg=${app.packageName}") }
    }

    private fun describeSharingCards(): String {
        val records = sharingRecords()
        if (records.isEmpty()) return "no notification of ${app.packageName}"
        return records.joinToString("; ") { record ->
            val channel = Regex("""mId='([^']+)'""").find(record)?.groupValues?.get(1)
                ?: Regex("""channel(?:Id)?=([\w.:;-]+)""").find(record)?.groupValues?.get(1) ?: "?"
            val title = Regex("""android\.title=String \(([^)]*)\)""").find(record)?.groupValues?.get(1) ?: "?"
            val text = Regex("""android\.text=String \(([^)]*)\)""").find(record)?.groupValues?.get(1) ?: "?"
            "channel $channel title '$title' text '$text'"
        }
    }

    // --- 6. the channel in the app's notification settings ---------------------------------------

    /**
     * The system's page for the app's notifications (`ACTION_APP_NOTIFICATION_SETTINGS`), where
     * the Sharing channel must be listed and – the demo page having posted once – the Sites group
     * with the page's site under it. A still, the findings, and a back to the app.
     */
    private fun notificationSettings() {
        val intent = Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
            .putExtra(Settings.EXTRA_APP_PACKAGE, app.packageName)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        instrumentation.runOnMainSync { activity.startActivity(intent) }
        val settingsUp = awaitSettled({ ui.rootInActiveWindow?.packageName?.toString() == SETTINGS_APP }, 10_000)
        note("  the system's notification settings ${if (settingsUp) "are up" else "did NOT come up (top: ${ui.rootInActiveWindow?.packageName})"}")
        SystemClock.sleep(2_000)
        val sharing = awaitSettled({ findInWindows(SETTINGS_APP) { it == SharingChannel.NAME } != null }, 8_000)
        val sites = findInWindows(SETTINGS_APP) { it == SITES_GROUP } != null
        val site = findInWindows(SETTINGS_APP) { it == DEMO_SITE } != null
        if (!sharing) revealInSettings(SharingChannel.NAME)
        snap("notification-settings")
        note("  channels on the page: Sharing ${if (sharing) "listed" else "NOT listed"}; the '$SITES_GROUP' group ${if (sites) "listed" else "not seen"}; the page's site '$DEMO_SITE' ${if (site) "listed" else "not seen"}")
        if (!sharing) {
            dumpNames("the app's notification settings", setOf(SETTINGS_APP))
            fail("the Sharing channel is not listed in the app's notification settings")
        }
        if (!sites && !site) note("  (the Sites group did not show on the first screen of the page; the channels' order is the system's)")
        val channels = shell("dumpsys notification --noredact 2>/dev/null").let { dump ->
            val ids = Regex("""NotificationChannel\{mId='([^']+)'""").findAll(dump).map { it.groupValues[1] }.toSet()
            ids.filter { it.startsWith("zenium.") }.sorted()
        }
        note("  the app's channels the system knows: $channels")
        check(SHARING_CHANNEL in channels, "the system does not know the $SHARING_CHANNEL channel")
        // Back to the app: the Settings task closed, our activity in front again.
        repeat(3) {
            if (ui.rootInActiveWindow?.packageName?.toString() == app.packageName) return@repeat
            back()
            SystemClock.sleep(1_000)
        }
        ensureForeground()
        awaitSurface(up = true, timeoutMs = 8_000)
        SystemClock.sleep(800)
    }

    /** Scroll the settings page's list until a row reads `label` (the tree's own scroll action), up to a few pages. */
    private fun revealInSettings(label: String) {
        repeat(4) {
            if (findInWindows(SETTINGS_APP) { it == label } != null) return
            val list = findNodeWhere { it.packageName?.toString() == SETTINGS_APP && it.isScrollable } ?: return
            list.performAction(AccessibilityNodeInfo.ACTION_SCROLL_FORWARD)
            SystemClock.sleep(900)
        }
    }

    // --- 7. the cold start, staged ---------------------------------------------------------------

    /**
     * The laptop sends a second page; Sync now posts its card, which is LEFT on the shade: the
     * shell's half of the run finds this process gone (the instrumentation's exit takes it), the
     * card still there, taps it from the shade and reads the profile's `state.json` for the tab
     * (`android-sync-history-cold-start.sh`). What the shell needs goes to `cold-start.json`.
     */
    private fun stageColdStart() {
        val arrival = inboxArrives(COLD_SEND_ID, COLD_URL, COLD_TITLE)
        val tabs = coreState().getJSONObject("tabs").keys().asSequence().toList()
        File(out, "cold-start.json").writeText(
            JSONObject()
                .put("package", app.packageName)
                .put("channel", SHARING_CHANNEL)
                .put("title", arrival.title)
                .put("body", arrival.body)
                .put("url", arrival.url)
                .put("sendId", COLD_SEND_ID)
                .put("tabsBefore", arrival.tabsBefore)
                .put("tabIdsBefore", org.json.JSONArray(tabs))
                .put("deviceId", syncStatus().getString("deviceId"))
                .toString(2)
        )
        note("  staged: the card '${arrival.title}' / '${arrival.body}' stays on the shade for the shell's cold-start tap; ${arrival.tabsBefore} tabs held now")
        ensureDemoTab()
        SystemClock.sleep(1_500)
        snap("cold-start-staged")
    }

    // --- the demo page's own notification --------------------------------------------------------

    /**
     * One notification of the demo page's own, off camera, so the site's channel and the Sites
     * group exist: the page's `Notification` (the polyfill in `shared/notificationScript.ts`)
     * under the seeded permission, closed by the page a moment later. A page's doing, not a
     * finger's: nothing on the chrome is claimed here.
     */
    private fun postSiteNotification() {
        // The seeded decision (permissions.json) did not reach the page's polyfill in 35681463729
        // (it read `denied`: the polyfill asks once, at its install, and the answer it kept was the
        // one from before the tab stood in the core). The decision is set again through the core's
        // own command – Settings › Site settings' path – whose change the core pushes to the open
        // pages of the site, and the page asks once more itself.
        val before = pageJs("Notification.permission")
        val set = coreInvoke("permissions.set", """{"origin":"$DEMO_ORIGIN","permission":"notifications","decision":"allow"}""")
        if (set.startsWith("ERR:")) {
            note("warm-up: permissions.set for the demo page's notifications failed ($set); its Notification.permission reads $before; no site channel")
            return
        }
        // With the decision stored, the page's own request settles without a prompt (`decide`
        // answers from the store); a prompt sheet all the same is closed, and noted.
        pageJs("(function(){try{Notification.requestPermission(function(s){window.__siteAsked=s})}catch(e){window.__siteAsked='threw '+e}return 'asked'})()")
        val granted = awaitSettled({ pageJs("Notification.permission") == "\"granted\"" }, 8_000)
        if (sheetCount() != 0) {
            note("warm-up: the page's own notification request brought a prompt up although the decision was stored; closed")
            closeSheets()
        }
        if (!granted) {
            note("warm-up: the demo page's Notification.permission reads ${pageJs("Notification.permission")} (was $before at the seed; its own request answered ${pageJs("window.__siteAsked||''")}), not granted; no site channel")
            return
        }
        note("warm-up: the demo page's Notification.permission reads granted (was $before at the seed)")
        pageJs(
            "(function(){try{var n=new Notification('Sync demo',{body:'A notification of the demo page, so its channel exists'});" +
                "n.onshow=function(){window.__siteNote='shown'};n.onerror=function(){window.__siteNote='error'};" +
                "setTimeout(function(){try{n.close()}catch(e){}},2500);return 'asked'}catch(e){return 'threw '+e}})()"
        )
        val shown = awaitSettled({ pageJs("window.__siteNote||''") == "\"shown\"" }, 8_000)
        val channel = awaitSettled({ shell("dumpsys notification --noredact 2>/dev/null").contains("${SitesChannels.PREFIX}$DEMO_ORIGIN;") }, 6_000)
        note("warm-up: the demo page posted a notification (${if (shown) "shown" else "no onshow: ${pageJs("window.__siteNote||''")}"}); its site channel ${if (channel) "exists" else "was NOT made"}")
        // The page's card is closed by the page; whatever is left on the shade goes, so the Sharing card is the shade's only one later.
        SystemClock.sleep(3_000)
        shell("cmd notification cancel_all 2>/dev/null || true")
    }

    /** Evaluate in the demo page's WebView; the raw JSON-encoded result ("" when it never answered). */
    private fun pageJs(code: String): String {
        var result = ""
        val latch = CountDownLatch(1)
        instrumentation.runOnMainSync {
            val view = host.tabs.get(DEMO_TAB)
            if (view == null) latch.countDown()
            else view.evaluateJavascript(code) { value ->
                result = value ?: ""
                latch.countDown()
            }
        }
        latch.await(5, TimeUnit.SECONDS)
        return result
    }

    // --- rows, menus and points ------------------------------------------------------------------

    /** Where a finger lands on the page row reading `label`: its steady bounds' part inside the page's band. */
    private fun pageRowPoint(label: String): PointF? {
        if (rowBounds(label, 8_000) == null) return null
        SystemClock.sleep(400)
        val node = awaitNode(4_000) { it == label || it.startsWith(label) } ?: return null
        val bounds = steadyBounds(node) ?: return null
        val reach = Rect(bounds)
        if (bounds.isEmpty || !reach.intersect(pageBand())) return null
        return PointF(reach.exactCenterX(), reach.exactCenterY())
    }

    /**
     * The app menu opened and pulled to its full height (as [openMenuItem] does), and the point of
     * its row reading `label` once its bounds hold still – for a scene that wants the finger alone
     * inside the clock. Null, the menu left up, when the menu never opened or has no such row.
     */
    private fun menuRowPoint(label: String): PointF? {
        tapMenuButton()
        if (waitFor(MENU_HANDLE_LABEL, 6_000) == null) {
            touchFault("the bar's Menu button did not open the app menu")
            return null
        }
        SystemClock.sleep(1_200)
        findByLabel(MENU_HANDLE_LABEL)?.let { handle ->
            Finger().apply {
                down(handle.exactCenterX(), handle.exactCenterY())
                moveBy(0f, -0.4f * height, 130)
                up()
            }
            SystemClock.sleep(2_000)
        }
        if (reveal(label) == null) {
            note("  no '$label' in the app menu; on screen: ${menuLabels()}")
            return null
        }
        val node = awaitNode(4_000) { it == label } ?: return null
        val bounds = steadyBounds(node) ?: return null
        return touchPoint(bounds)
    }

    private fun menuLabels(): String =
        findNodes { it.isNotEmpty() }.mapNotNull { (it.text ?: it.contentDescription)?.toString()?.trim() }.distinct().take(40).joinToString(" | ")

    /** The sheet's rows as the tree reads them, for the notes. */
    private fun sheetRowsNoted(): String {
        val raw = chromeJs(
            "(function(){var s=document.querySelector('.zen-sheet');if(!s)return '';" +
                "return Array.prototype.map.call(s.querySelectorAll('button, [role=\"button\"], h2, h3'),function(e){return (e.getAttribute('aria-label')||e.textContent||'').replace(/\\s+/g,' ').trim()}).filter(Boolean).join(' | ')})()"
        )
        return runCatching { org.json.JSONTokener(raw).nextValue() as? String }.getOrNull()?.take(400) ?: ""
    }

    /** The inbox documents addressed to `deviceId` in the tree. */
    private fun inboxFiles(deviceId: String): Set<String> =
        shell("ls $FOLDER_PATH/${SyncPeer.DIR_NAME} 2>/dev/null").lines().map(String::trim)
            .filter { it.startsWith("${SyncPeer.safeId(deviceId)}.inbox.") && it.endsWith(SyncPeer.DOCUMENT_EXT) }.toSet()

    /** Settings › Sync in front (the tab exists from step 1; `page.open` brings it back). */
    private fun toSyncSettings() {
        if (activeCoreTab()?.optString("url") != SECTION_URL) {
            coreInvoke("page.open", """{"id":"settings","section":"sync"}""")
            awaitPage(SECTION_URL, 12_000)
        }
        awaitSurface(up = true, timeoutMs = 6_000)
        rowBounds(SYNC_NOW_LABEL, 8_000)
        SystemClock.sleep(600)
    }

    // --- claims and the frame table --------------------------------------------------------------

    private fun check(condition: Boolean, message: String) {
        if (!condition) fail(message)
    }

    private fun fail(message: String) {
        note("  CLAIM FAILED: $message")
        failures += message
    }

    /** The scenes as one table at the end of the notes: the app menu is the before, the PR's sheets the after. */
    private fun noteFrameScenes() {
        note(
            "\nframe stats (DemoHarness.traceFrames: dumpsys gfxinfo ${app.packageName} reset before each scene and read after it, the chrome WebView's trace around it; " +
                "the sheet scenes read against the app menu's, a sheet main had before this PR; janky is HWUI's count of frames past their deadline, 100 % by construction on the software GPU – the verdict reads the trace columns and the ratios)"
        )
        note("  %-26s %-7s %6s %14s %5s %5s %5s %5s  %s".format(Locale.US, "scene", "kind", "frames", "janky", "p50", "p90", "p95", "p99", "verdict"))
        for (scene in frameScenes) {
            val s = scene.summary
            if (s == null) {
                note("  %-26s %-7s %s".format(Locale.US, scene.name, scene.kind.key, "not measured"))
                continue
            }
            note(
                "  %-26s %-7s %6d %14s %5d %5d %5d %5d  %s%s".format(
                    Locale.US, scene.name, scene.kind.key, s.frames, "${s.janky} (${"%.0f".format(Locale.US, s.jankyShare * 100)} %)",
                    s.p50Ms, s.p90Ms, s.p95Ms, s.p99Ms, if (scene.verdict.within) "within" else "over",
                    scene.ratio?.let { " (${it.describe()})" } ?: ""
                )
            )
            scene.trace?.let { note("  %-26s %s".format(Locale.US, "", it.describe())) }
        }
    }

    companion object {
        private const val DEMO_ORIGIN = "http://127.0.0.1:18151"
        private const val DEMO_URL = "$DEMO_ORIGIN/"
        /** How the page's site reads on its channel (`SitesChannels.displayName`). */
        private const val DEMO_SITE = "127.0.0.1:18151"
        private const val PEER2_ID = "device_kitchentablet"
        private const val PEER2_NAME = "Kitchen tablet"
        private const val LAPTOP_TAB_ID = "tab_worklaptop_notes"
        private const val LAPTOP_TAB_URL = "https://example.com/sync-design-notes"
        private const val LAPTOP_TAB_TITLE = "Sync design notes"
        private const val REMOTE_TABS_SUMMARY = "5 tabs on 2 devices"
        private const val SEND_ID = "send_demo_1"
        private const val SENT_URL = "https://example.com/from-the-laptop"
        private const val SENT_TITLE = "Release checklist"
        private const val COLD_SEND_ID = "send_demo_cold"
        private const val COLD_URL = "https://example.com/from-the-laptop-later"
        private const val COLD_TITLE = "Sync roadmap"
        private const val PRIVATE_CONTAINER = "private"
        private const val SHARING_CHANNEL = SharingChannel.ID
        private const val SITES_GROUP = SitesChannels.GROUP_NAME
        private const val SYSTEM_UI = "com.android.systemui"
        private const val SETTINGS_APP = "com.android.settings"
        // The chrome's words (`SYNC_COPY` in lib/syncSetup.ts, the menu template in core/menus.ts, SendTabSheet.tsx).
        private const val REMOTE_TABS_LABEL = "Tabs from other devices"
        private const val SEND_LABEL = "Send to Your Devices\u2026"
        private const val PICKER_TITLE = "Send to your devices"
        // The frame scenes' names, stable across runs (`<what>-<where>`).
        private const val SCENE_MENU_OPEN = "menu-sheet-open"
        private const val SCENE_MENU_CLOSE = "menu-sheet-close"
        private const val SCENE_REMOTE_OPEN = "remote-tabs-sheet-open"
        private const val SCENE_REMOTE_CLOSE = "remote-tabs-sheet-close"
        private const val SCENE_PICKER_OPEN = "send-tab-picker-open"
        private const val SCENE_PICKER_CLOSE = "send-tab-picker-close"
        /** A sheet's rise or fall lands within this; the scene's clock runs the finger and this long. */
        private const val MOTION_MS = 3_000L
    }
}
