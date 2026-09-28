package app.zen.chromium

import android.graphics.RectF
import android.os.SystemClock
import android.util.Log
import android.view.KeyEvent
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import kotlin.math.abs
import kotlin.math.roundToInt

/**
 * Drives the frame dialog host's TOAST LIFT on the TABLET chrome (v2 draft §9.33 as the lead
 * ruled for W8-F16; the tablet inherits it, §9.36) on a `pixel_tablet` AVD laid out at
 * 1280 x 800 dp, one px per dp (`DEMO_DISPLAY=1280x800@160`, as the tablet layout demo): a toast
 * a standing dialog's act raises rises above the dialog and its scrim, undimmed and in reach –
 * by a finger and by a keyboard's Tab (a DeX desk) – and lands back on the page frame when the
 * dialog closes, the same card on the same clock. Every claim is read off the chrome's own
 * document and stores (`window.__zenStores`) or the core's state (`app.getState`); the one
 * thing only the accessibility tree can say – that TalkBack would find the Undo while it is
 * lifted – is read off the tree with the harness's fresh reads. A claim that does not hold
 * fails the run at the end, the sequence running on so the recording shows the rest.
 *
 * The scene is Settings > Privacy and security > Safety check > Site permissions – the review
 * that lists the sites holding permissions and the block of sites the unused-sites sweep took
 * permissions from (PS-41), each with its Allow again, and Got it under them. On the tablet the
 * review is an item dialog in the frame dialog host (`DialogStack`, `pages/settings/dialogs.tsx`;
 * `data-dialog="item:safety-check:permissions"`), and the host holds the chrome and the frame
 * inert under its scrim (`holdChromeInert` / `holdFrameInert`, lib/portals.tsx). Allow again
 * regrants a site at once and raises Chrome's "Permissions allowed again for <host>" toast with
 * Undo on §9.33's 8 s Undo clock, the dialog standing for the sites left; Got it (with
 * `closesSheet` on the tablet, #668) leaves the dialog first and then acknowledges the list with
 * its own bulk toast. The seeded profile ([seedMore]) holds one granted site and two revoked
 * ones, and the Safety check is run through the core before the dialog opens, so the block has
 * something to show.
 *
 * The sequence:
 *  1. the review opens as a dialog over the Privacy section: the sidebar, the page and the
 *     message frame under `inert`, the host and its (empty, un-lifted) toast seat not;
 *  2. Allow again on the first revoked site lifts its toast: the card in the host's seat
 *     (`.zen-frame-toast-seat[data-lifted]`, over the dialogs' slot), `seat: 'frame'` in the ui
 *     store, `role="status"`, under no `inert`, its bottom 8 px inside the content frame's
 *     bottom edge and clear of the dialog's box (never inside it – §9.33's footer clause), the
 *     dialog still standing; the tree lists the Undo while it is lifted; the still `lifted`;
 *  3. the keyboard: Tab from the dialog reaches the Undo as the LAST stop of the dialog's cycle
 *     (§9.22, the lead's pick), one more Tab re-enters the dialog at its first control,
 *     Shift+Tab comes back to the Undo, and Enter undoes – the site's row is back in the block,
 *     the core's revoked list holds it again, the toast is gone and the focus is the dialog's;
 *  4. the finger: Allow again again, the lifted Undo under a touch – the block restored, the
 *     toast forgotten;
 *  5. the ORPHAN case: Allow again on the second revoked site, then the dialog closed under the
 *     toast by a touch on the scrim – the seat drops its lift and the SAME card (marked in the
 *     document before the close) stands on the page frame, not inert, still one `role="status"`,
 *     still 8 px inside the frame's bottom edge; its clock ran on through the re-seat – it leaves
 *     about 8 s after it was raised, not 8 s after the dialog closed; the still `orphan`. (The
 *     scrim, not Got it: the cards hold one live toast, and Got it's own toast would send the
 *     marked one off – the displacement is the cards' rule, not the lift's.)
 *  6. Got it, as the brief names it: on the tablet it leaves the dialog FIRST (#668's
 *     `closesSheet` gate) and its "Review complete" toast lands on the page frame – the frame's
 *     un-lifted seat, one `role="status"`, in reach – and its Undo restores the block. Once
 *     services drop the gate for the tablet, this step becomes a second lifted case.
 *
 * Same handshake as the other demos, under `files/tablet-settings-toast-demo/`; stills land
 * there as `tablet-settings-toast-<theme>-<step>.png`, the claims as `findings.txt`.
 */
@RunWith(AndroidJUnit4::class)
class TabletSettingsToastDemo : DemoHarness("tablet-settings-toast-demo-state.json", "tablet-settings-toast-$THEME", "tablet-settings-toast-demo") {
    override val tag = "TabletSettingsToastDemo"

    private lateinit var server: DemoServer
    private val findings = StringBuilder()
    private val failures = ArrayList<String>()

    /** CSS px of the chrome to screen px: `screen = offset + css * density`, read off the pill ([calibrate]). */
    private var offsetX = 0f
    private var offsetY = 0f

    @Test
    fun record() {
        server = DemoServer(PORT, mapOf("/" to DemoServer.page("Site permissions demo", PAGE_BODY))).also { it.start() }
        try {
            runDemo()
        } finally {
            server.close()
            File(out, "findings.txt").writeText(findings.toString())
            Log.i(tag, "findings:\n$findings")
        }
        assertTrue("claims that did not hold:\n" + failures.joinToString("\n"), failures.isEmpty())
    }

    // --- seed ------------------------------------------------------------------------------------

    override fun patchState(json: String): String =
        json.replace("\"colorScheme\": \"light\"", "\"colorScheme\": \"$THEME\"")

    /**
     * The permissions store the core reads at boot: one site holding two grants (the review's
     * "Sites with permissions you granted" list), and two sites the unused-sites sweep took
     * permissions from two days ago (PS-41's `revokedUnused` records, kept 30 days) – the
     * review's removed-permissions block, one row each with its Allow again, and Got it. The
     * grants carry no visit stamp, so the sweep at boot leaves them alone.
     */
    override fun seedMore(zen: File) {
        val now = System.currentTimeMillis()
        val decisions = JSONObject()
            .put("$GRANTED_ORIGIN|camera", "allow")
            .put("$GRANTED_ORIGIN|microphone", "allow")
        val revoked = JSONArray()
            .put(revokedRecord(FIRST_REVOKED, listOf("geolocation", "notifications"), now))
            .put(revokedRecord(SECOND_REVOKED, listOf("camera"), now - 3_600_000L))
        File(zen, "permissions.json").writeText(
            JSONObject().put("version", 1).put("decisions", decisions).put("revokedUnused", revoked).toString()
        )
    }

    private fun revokedRecord(origin: String, permissions: List<String>, revokedAt: Long): JSONObject = JSONObject()
        .put("origin", origin)
        .put("permissions", JSONArray(permissions))
        .put("revokedAt", revokedAt - 2 * 86_400_000L)
        .put("expiresAt", revokedAt + 28 * 86_400_000L)

    // --- warm-up ---------------------------------------------------------------------------------

    /**
     * Off camera: the colour scheme, the form factor, the Safety check run through the core (its
     * result is what the Privacy section's Results rows are built from), the Settings tab opened
     * at Privacy and security, the chrome's geometry calibrated, and the review opened and
     * closed once so its first layout is paid for.
     */
    override fun warmUp() {
        shellCommand("cmd uimode night ${if (THEME == "dark") "yes" else "no"}")
        SystemClock.sleep(2_500)
        ensureForeground()
        recordA11yEvents()
        finding("Zenium Android tablet dialog toast lift ($THEME, window ${width}x$height, density $density)")
        finding("demo server: ${server.selfCheck()}")
        check("the chrome laid the window out as the tablet", awaitFormFactor("tablet"), "form factor ${formFactor()}, viewport ${viewportText()}")
        val result = runCatching { JSONObject(coreInvoke("privacy.safetyCheck")) }.getOrNull()
        val permissions = result?.optJSONObject("permissions")
        finding(
            "safety check: permissions ${permissions?.optString("state")} '${permissions?.optString("summary")}', " +
                "granted sites ${permissions?.opt("grantedSites")}, revoked ${permissions?.optJSONArray("revoked")?.length()}; " +
                "core revoked list ${revokedOrigins()}"
        )
        check(
            "the seeded block is on the core's revoked list",
            revokedOrigins().containsAll(listOf(FIRST_REVOKED, SECOND_REVOKED)),
            "revoked ${revokedOrigins()}"
        )
        coreInvoke("page.open", "{\"id\":\"settings\",\"section\":\"privacy\"}")
        check("the Settings tab is up at Privacy and security in the two-pane layout", awaitDom(TWO_PANE, 15_000), "layout ${jsText("(document.querySelector('.zen-settings-page')||{dataset:{}}).dataset.layout")}")
        check("the Site permissions row is on the page", awaitDom(REVIEW_ROW, 8_000), "row text '${jsText("(document.querySelector('$REVIEW_ROW')||{textContent:''}).textContent.trim()")}'")
        calibrate()
        // The first dialog pays for its layout: open and close it off camera.
        if (openReview()) {
            SystemClock.sleep(800)
            closeReview()
        }
        SystemClock.sleep(1_200)
        finding("warm-up done: dialogs open ${jsText("window.__zenStores.ui.get().frameDialogsOpen")}, toasts ${toastsText()}")
    }

    override fun demo() {
        reviewOpens()
        allowAgainLifts()
        undoByKeyboard()
        undoByFinger()
        orphan()
        gotItLands()
    }

    // --- 1. the review as a dialog -------------------------------------------------------------

    private fun reviewOpens() {
        finding("\n1. The Site permissions review opens as a dialog in the frame dialog host")
        check("the review dialog is up", openReview(), "dialogs ${jsText("[...document.querySelectorAll('[data-dialog]')].map(function(d){return d.dataset.dialog})")}")
        SystemClock.sleep(600)
        check(
            "the removed-permissions block lists both seeded sites and Got it",
            domRect(revokedRow(FIRST_REVOKED)) != null && domRect(revokedRow(SECOND_REVOKED)) != null && domRect(GOT_IT) != null,
            "rows ${jsText("[...document.querySelectorAll('$DIALOG [data-row]')].map(function(r){return r.dataset.row})")}"
        )
        check(
            "the dialog holds the sidebar, the page and the message frame inert, and stands in reach itself",
            underInert(SIDEBAR) == true && underInert(CONTENT) == true && underInert(MESSAGE_FRAME) == true && underInert(DIALOG) == false && underInert(HOST) == false,
            "inert: sidebar ${underInert(SIDEBAR)}, content ${underInert(CONTENT)}, message frame ${underInert(MESSAGE_FRAME)}, dialog ${underInert(DIALOG)}, host ${underInert(HOST)}"
        )
        check(
            "the host's toast seat stands after the dialogs' slot, empty and not lifted",
            jsBoolean("(function(){var s=document.querySelector('$SEAT');var slot=document.querySelector('$SLOT');return !!s&&!!slot&&s.parentElement===slot.parentElement&&!!(slot.compareDocumentPosition(s)&Node.DOCUMENT_POSITION_FOLLOWING)&&!s.hasAttribute('data-lifted')&&!s.querySelector('.zen-message-toast')})()"),
            "seat ${jsText("(function(){var s=document.querySelector('$SEAT');return s?(s.hasAttribute('data-lifted')?'lifted':'down')+(s.hasAttribute('inert')?' inert':''):'none'})()")}"
        )
        framesSettled()
        shot("dialog")
    }

    // --- 2. Allow again lifts the toast --------------------------------------------------------

    private fun allowAgainLifts() {
        finding("\n2. Allow again raises a toast that rises above the standing dialog")
        watchToasts()
        val raisedAt = SystemClock.uptimeMillis()
        check("a finger on Allow again for ${hostOf(FIRST_REVOKED)}", tapDom(allowAgain(FIRST_REVOKED)), "")
        val lifted = awaitDom(LIFTED_CARD, 5_000)
        check("the toast's card stands in the host's seat, lifted over the dialogs' slot", lifted, "seat ${seatText()} after ${SystemClock.uptimeMillis() - raisedAt} ms")
        check("the toast reads the regrant", awaitToastSeen("Permissions allowed again for ${hostOf(FIRST_REVOKED)}", 3_000), "toasts ${toastsText()}")
        check("the dialog still stands under the lifted toast", domRect(DIALOG) != null && !jsBoolean("!!document.querySelector('$DIALOG[data-leaving]')"), "dialogs ${jsText("[...document.querySelectorAll('[data-dialog]')].map(function(d){return d.dataset.dialog+(d.hasAttribute('data-leaving')?' leaving':'')})")}")
        check("the ui store seats the toast on the frame", jsBoolean("window.__zenStores.ui.get().toasts.some(function(t){return t.seat==='frame'&&!t.leaving})"), "toasts ${toastsText()}")
        check(
            "the card is one role=status and its Undo is under no inert",
            jsBoolean("(function(){var c=document.querySelectorAll('$LIFTED_CARD');if(c.length!==1)return false;var card=c[0];var u=card.querySelector('$UNDO');return card.getAttribute('role')==='status'&&!!u&&!u.closest('[inert]')&&!u.closest('[aria-hidden=\"true\"]')})()"),
            "cards ${jsText("document.querySelectorAll('$LIFTED_CARD').length")}, undo ${jsText("(function(){var u=document.querySelector('$LIFTED_CARD $UNDO');return u?(u.closest('[inert]')?'under inert':'in reach'):'none'})()")}"
        )
        geometry("lifted")
        // What only the tree can say: TalkBack would find the Undo while it is lifted. The tree
        // trails the screen on the emulator's software GPU; the card lives 8 s, so the window is
        // what is left of them.
        val undoNode = awaitFresh(5_000, "the lifted Undo") { it == "Undo" }
        check("the accessibility tree lists the lifted Undo", undoNode != null, "node ${describeNode(undoNode)}; events since the lift: ${eventsSince(raisedAt)}")
        awaitChromePaint()
        shot("lifted")
    }

    // --- 3. Undo by the keyboard ---------------------------------------------------------------

    /**
     * The Tab cycle while the toast is lifted (§9.22, the lead's pick): the Undo is the dialog's
     * last stop – Tab from the dialog's last control lands on it, Tab from it re-enters the
     * dialog at its first control, Shift+Tab from that comes back to it – and Enter on it undoes.
     */
    private fun undoByKeyboard() {
        finding("\n3. The keyboard: Tab reaches the Undo as the dialog's last stop; Enter undoes")
        if (domRect(LIFTED_CARD) == null) {
            check("a lifted toast to reach (step 2's)", false, "no lifted card: ${seatText()}")
            return
        }
        val stops = ArrayList<String>()
        var reached = false
        var before = activeText()
        for (i in 1..MAX_TABS) {
            key(KeyEvent.KEYCODE_TAB)
            SystemClock.sleep(250)
            val now = activeText()
            stops += now
            if (activeIsUndo()) {
                reached = true
                check("the stop before the Undo was the dialog's", before.endsWith(IN_DIALOG), "before '$before', then '$now'")
                break
            }
            before = now
        }
        finding("  Tab stops: ${stops.joinToString(" → ")}")
        check("Tab from the dialog reaches the lifted Undo within $MAX_TABS presses", reached, "${stops.size} presses, active '${activeText()}'")
        if (!reached) return
        key(KeyEvent.KEYCODE_TAB)
        SystemClock.sleep(250)
        val first = activeText()
        check("Tab from the Undo re-enters the dialog at its first control", first.endsWith(IN_DIALOG) && jsBoolean("(function(){var d=document.querySelector('$DIALOG');var a=document.activeElement;if(!d||!a)return false;var all=d.querySelectorAll('$TABBABLE');return all.length>0&&all[0]===a})()"), "active '$first'")
        key(KeyEvent.KEYCODE_TAB, shift = true)
        SystemClock.sleep(250)
        check("Shift+Tab from the first control comes back to the Undo", activeIsUndo(), "active '${activeText()}'")
        if (!activeIsUndo()) {
            // Reach it again by Tab so the Enter below is the Undo's.
            for (i in 1..MAX_TABS) {
                key(KeyEvent.KEYCODE_TAB)
                SystemClock.sleep(250)
                if (activeIsUndo()) break
            }
        }
        val pressedAt = SystemClock.uptimeMillis()
        key(KeyEvent.KEYCODE_ENTER)
        check("Enter on the Undo puts ${hostOf(FIRST_REVOKED)} back in the removed-permissions block", awaitDom(revokedRow(FIRST_REVOKED), 6_000), "after ${SystemClock.uptimeMillis() - pressedAt} ms; block ${jsText("[...document.querySelectorAll('$DIALOG [data-row^=\"safety-check:permissions:revoked:\"]')].map(function(r){return r.dataset.row})")}")
        check("the core's revoked list holds it again", awaitTrue(4_000) { revokedOrigins().contains(FIRST_REVOKED) }, "revoked ${revokedOrigins()}")
        check("the toast is gone from the seat", awaitDomGone(LIVE_CARD, 4_000), "seat ${seatText()}")
        SystemClock.sleep(400)
        check("the focus is the dialog's again (§9.22)", activeText().endsWith(IN_DIALOG), "active '${activeText()}'")
        check("the dialog still stands", domRect(DIALOG) != null, "")
    }

    // --- 4. Undo by the finger -----------------------------------------------------------------

    private fun undoByFinger() {
        finding("\n4. The finger: the lifted Undo under a touch")
        if (domRect(revokedRow(FIRST_REVOKED)) == null) {
            check("the block holds ${hostOf(FIRST_REVOKED)} to allow again", false, "rows ${jsText("[...document.querySelectorAll('$DIALOG [data-row]')].map(function(r){return r.dataset.row})")}")
            return
        }
        watchToasts()
        check("a finger on Allow again for ${hostOf(FIRST_REVOKED)}", tapDom(allowAgain(FIRST_REVOKED)), "")
        check("the toast rises again", awaitDom(LIFTED_CARD, 5_000), "seat ${seatText()}")
        SystemClock.sleep(900)
        val pressedAt = SystemClock.uptimeMillis()
        check("a finger on the lifted Undo", tapDom("$LIFTED_CARD $UNDO"), "")
        check("the touch undid: ${hostOf(FIRST_REVOKED)} is back in the block", awaitDom(revokedRow(FIRST_REVOKED), 6_000), "after ${SystemClock.uptimeMillis() - pressedAt} ms")
        check("the core's revoked list holds it again", awaitTrue(4_000) { revokedOrigins().contains(FIRST_REVOKED) }, "revoked ${revokedOrigins()}")
        check("the toast is gone from the seat and the seat is down", awaitDomGone(LIVE_CARD, 4_000) && awaitTrue(3_000) { !jsBoolean("!!document.querySelector('$SEAT[data-lifted]')") }, "seat ${seatText()}")
        check("the dialog still stands", domRect(DIALOG) != null, "")
        SystemClock.sleep(600)
    }

    // --- 5. the orphan case ----------------------------------------------------------------------

    /**
     * The dialog closes while its toast is up – a touch on the scrim, the way a user leaves a
     * dialog that has done its work. The lifted card is marked in the document before the close,
     * so the card on the page frame after it is provably the same element – one announcement,
     * one clock – and its clock is read against the moment it was raised. Not Got it here: the
     * cards hold one live toast (lib/ui.ts `pushToast`), so Got it's own toast would send the
     * marked one off before it could be measured; Got it is step 6's.
     */
    private fun orphan() {
        finding("\n5. The orphan case: the dialog closes under the lifted toast")
        if (domRect(revokedRow(SECOND_REVOKED)) == null) {
            check("the block holds ${hostOf(SECOND_REVOKED)} to allow again", false, "rows ${jsText("[...document.querySelectorAll('$DIALOG [data-row]')].map(function(r){return r.dataset.row})")}")
            return
        }
        watchToasts()
        val raisedAt = SystemClock.uptimeMillis()
        check("a finger on Allow again for ${hostOf(SECOND_REVOKED)}", tapDom(allowAgain(SECOND_REVOKED)), "")
        check("the toast rises over the dialog", awaitDom(LIFTED_CARD, 5_000), "seat ${seatText()}")
        val marked = jsBoolean("(function(){var c=document.querySelector('$LIFTED_CARD');if(!c)return false;c.setAttribute('data-demo-mark','orphan');return true})()")
        check("the lifted card is marked for the identity check", marked, "")
        SystemClock.sleep(2_000)
        val closedAt = SystemClock.uptimeMillis()
        closeReview()
        check("the dialog leaves under a touch on its scrim", domRect(DIALOG) == null, "dialogs ${jsText("[...document.querySelectorAll('[data-dialog]')].map(function(d){return d.dataset.dialog})")} after ${SystemClock.uptimeMillis() - closedAt} ms")
        check("the seat drops its lift as the dialog goes", awaitTrue(4_000) { !jsBoolean("!!document.querySelector('$SEAT[data-lifted]')") }, "seat ${seatText()}")
        check(
            "the same card stands on the page frame, one role=status, under no inert, not leaving",
            jsBoolean("(function(){var cs=document.querySelectorAll('$MARKED');if(cs.length!==1)return false;var c=cs[0];return c.getAttribute('role')==='status'&&!c.closest('[inert]')&&!c.hasAttribute('data-leaving')&&!!c.closest('$SEAT')&&!c.closest('$SEAT[data-lifted]')})()"),
            "marked cards ${jsText("document.querySelectorAll('$MARKED').length")}; ${jsText("(function(){var c=document.querySelector('$MARKED');if(!c)return 'none';return (c.closest('[inert]')?'under inert':'in reach')+(c.hasAttribute('data-leaving')?', leaving':'')+', in '+(c.closest('$SEAT[data-lifted]')?'the lifted seat':c.closest('$SEAT')?'the seat, down':'elsewhere')})()")}; toasts ${toastsText()}"
        )
        check("the page frame is back in reach under it", awaitTrue(3_000) { underInert(CONTENT) == false && underInert(SIDEBAR) == false }, "inert: content ${underInert(CONTENT)}, sidebar ${underInert(SIDEBAR)}")
        geometry("orphan", card = MARKED, dialogUp = false)
        awaitChromePaint()
        shot("orphan")
        // The clock: raised at `raisedAt`, the card leaves about TOAST_UNDO_MS after – not that
        // long after the close, which would be a clock restarted by the re-seat.
        val gone = awaitTrue(raisedAt + UNDO_MS + 3_000 - SystemClock.uptimeMillis()) {
            jsBoolean("(function(){var c=document.querySelector('$MARKED');return !c||c.hasAttribute('data-leaving')})()")
        }
        val lived = SystemClock.uptimeMillis() - raisedAt
        val sinceClose = SystemClock.uptimeMillis() - closedAt
        check(
            "the card's clock ran on through the re-seat (gone about ${UNDO_MS / 1000} s after it was raised, not after the close)",
            gone && lived >= UNDO_MS - 1_500 && lived <= UNDO_MS + 3_000 && sinceClose < UNDO_MS - 500,
            "left ${lived} ms after it was raised, ${sinceClose} ms after the close"
        )
        check("${hostOf(SECOND_REVOKED)} stays allowed again – the Undo was not taken", awaitTrue(2_000) { !revokedOrigins().contains(SECOND_REVOKED) }, "revoked ${revokedOrigins()}")
        SystemClock.sleep(800)
    }

    // --- 6. Got it, as the brief names it ------------------------------------------------------

    /**
     * Got it on the tablet leaves the dialog first (#668's `closesSheet` gate, settingsRows.tsx)
     * and acknowledges the block after, so its "Review complete" toast is raised with no dialog
     * standing: the page frame's, in the frame's un-lifted seat. The step records that the toast
     * lands there in reach and that its Undo restores the block – and names the gate, so the
     * step is read as the lifted case once services drop it.
     */
    private fun gotItLands() {
        finding("\n6. Got it: the dialog leaves first on the tablet (#668), its toast lands on the page frame")
        check("the review opens again", openReview(), "dialogs ${jsText("[...document.querySelectorAll('[data-dialog]')].map(function(d){return d.dataset.dialog})")}")
        SystemClock.sleep(600)
        if (domRect(GOT_IT) == null) {
            check("Got it is on the dialog", false, "rows ${jsText("[...document.querySelectorAll('$DIALOG [data-row]')].map(function(r){return r.dataset.row})")}")
            return
        }
        val before = revokedOrigins()
        watchToasts()
        val pressedAt = SystemClock.uptimeMillis()
        check("a finger on Got it", tapDom("$GOT_IT button"), "")
        val left = awaitDomGone(DIALOG, 6_000)
        finding("  Got it: the dialog ${if (left) "left after ${SystemClock.uptimeMillis() - pressedAt} ms" else "still stands"} – #668's closesSheet gate holds it ${if (left) "closed first on the tablet" else "open"}")
        check("Got it's toast is raised", awaitToastSeen("Review complete for ${before.size} site${if (before.size == 1) "" else "s"}", 5_000), "toasts ${toastsText()}; block before ${before}")
        check("the core's revoked list is acknowledged (empty)", awaitTrue(3_000) { revokedOrigins().isEmpty() }, "revoked ${revokedOrigins()}")
        check("the seat is down once the dialog has gone", awaitTrue(4_000) { !jsBoolean("!!document.querySelector('$SEAT[data-lifted]')") }, "seat ${seatText()}")
        check(
            "the toast's card stands on the page frame, one role=status, its Undo under no inert",
            jsBoolean("(function(){var cs=document.querySelectorAll('$LIVE_CARD');if(cs.length!==1)return false;var c=cs[0];var u=c.querySelector('$UNDO');return c.getAttribute('role')==='status'&&!!u&&!u.closest('[inert]')&&!u.closest('[aria-hidden=\"true\"]')})()"),
            "seat ${seatText()}; undo ${jsText("(function(){var u=document.querySelector('$LIVE_CARD $UNDO');return u?(u.closest('[inert]')?'under inert':'in reach'):'none'})()")}"
        )
        geometry("got-it", card = LIVE_CARD, dialogUp = false)
        awaitChromePaint()
        shot("got-it")
        val undoAt = SystemClock.uptimeMillis()
        check("a finger on the toast's Undo", tapDom("$LIVE_CARD $UNDO"), "")
        check("the Undo restores the block on the core", awaitTrue(4_000) { revokedOrigins().containsAll(before) && before.isNotEmpty() }, "revoked ${revokedOrigins()} after ${SystemClock.uptimeMillis() - undoAt} ms")
        check("the toast is gone from the seat", awaitDomGone(LIVE_CARD, 4_000), "seat ${seatText()}")
        SystemClock.sleep(800)
        finding("end: toasts ${toastsText()}, revoked ${revokedOrigins()}, dialogs open ${jsText("window.__zenStores.ui.get().frameDialogsOpen")}")
    }

    // --- the geometry (§9.33: 8 px inside the frame's bottom edge, never inside the dialog box) ---

    /**
     * The card's box against the content frame's and the dialog's, in the chrome's CSS px: its
     * bottom edge [INSET] px above the frame's bottom (`--zen-message-inset`), its side edges
     * inside the frame's, and – while a dialog stands – no overlap with the dialog's box, the
     * clearance between the two on record.
     */
    private fun geometry(step: String, card: String = LIFTED_CARD, dialogUp: Boolean = true) {
        val frame = domRect(HOST)
        val cardRect = domRect(card)
        val dialog = domRect(DIALOG)
        if (frame == null || cardRect == null) {
            check("$step: the card and the frame have boxes to measure", false, "frame $frame, card $cardRect")
            return
        }
        val inset = frame.bottom - cardRect.bottom
        finding("  $step geometry (CSS px): frame $frame, card $cardRect, dialog $dialog; bottom inset ${fmt(inset)}, left inset ${fmt(cardRect.left - frame.left)}, right inset ${fmt(frame.right - cardRect.right)}")
        check("$step: the card's bottom edge stands $INSET px inside the content frame's bottom edge", abs(inset - INSET) <= 1f, "inset ${fmt(inset)}")
        check("$step: the card lies inside the frame's sides", cardRect.left >= frame.left - 0.5f && cardRect.right <= frame.right + 0.5f, "")
        if (dialogUp) {
            if (dialog == null) {
                check("$step: a dialog box to measure against", false, "no dialog")
                return
            }
            val clearance = cardRect.top - dialog.bottom
            check("$step: the card is not inside the dialog box (§9.33's footer clause)", !RectF.intersects(cardRect, dialog), "clearance under the dialog ${fmt(clearance)} px")
            finding("  $step: the actions band's clearance – the dialog's bottom edge to the card's top – ${fmt(clearance)} px")
        }
    }

    // --- the review's ways in and out -----------------------------------------------------------

    /** A finger on the Site permissions row; true once the dialog is up. */
    private fun openReview(): Boolean {
        if (domRect(DIALOG) != null) return true
        chromeJs("(function(){var r=document.querySelector('$REVIEW_ROW');if(r)r.scrollIntoView({block:'center',behavior:'instant'})})()")
        SystemClock.sleep(500)
        if (!tapDom(REVIEW_ROW)) return false
        return awaitDom(DIALOG, 6_000)
    }

    /** The dialog closed by a touch on its scrim (`onScrimPress`), the system back when that does not take. */
    private fun closeReview() {
        if (domRect(DIALOG) == null) return
        val host = screen(domRect(HOST))
        val dialog = screen(domRect(DIALOG))
        if (host != null && dialog != null) {
            // A point of the host's box beside the dialog, inside the touchable band.
            val x = if (dialog.left - host.left > 60f) host.left + 30f else host.right - 30f
            val y = (dialog.top + dialog.bottom) / 2f
            Finger().tap(x, y)
            if (awaitDomGone(DIALOG, 3_000)) return
        }
        back()
        awaitDomGone(DIALOG, 4_000)
    }

    // --- the keyboard --------------------------------------------------------------------------

    /** A key press (down and up), Shift held when `shift`, through the input dispatcher into the focused window. */
    private fun key(keyCode: Int, shift: Boolean = false) {
        val meta = if (shift) KeyEvent.META_SHIFT_ON or KeyEvent.META_SHIFT_LEFT_ON else 0
        val down = SystemClock.uptimeMillis()
        injectInput(KeyEvent(down, down, KeyEvent.ACTION_DOWN, keyCode, 0, meta), true)
        SystemClock.sleep(40)
        injectInput(KeyEvent(down, SystemClock.uptimeMillis(), KeyEvent.ACTION_UP, keyCode, 0, meta), true)
    }

    /** The document's active element as "name @where": its reader name or text, then the dialog, the seat, or its tag. */
    private fun activeText(): String = jsText(
        "(function(){var a=document.activeElement;if(!a||a===document.body)return 'body';" +
            "var n=(a.getAttribute('aria-label')||a.textContent||a.tagName).replace(/\\s+/g,' ').trim().slice(0,48);" +
            "var w=a.closest('[data-dialog]')?'$IN_DIALOG':a.closest('$SEAT')?'@seat':'@'+a.tagName.toLowerCase();return n+' '+w})()"
    )

    private fun activeIsUndo(): Boolean = jsBoolean("(function(){var a=document.activeElement;return !!a&&a.matches('$UNDO')&&!!a.closest('$SEAT')})()")

    // --- the chrome's geometry --------------------------------------------------------------------

    /**
     * Where the chrome's CSS px land on the screen: the toolbar's address pill read from the DOM
     * and from the accessibility tree, the difference the offset (the tablet layout demo's rule).
     */
    private fun calibrate() {
        val dom = domRect(ADDRESS_PILL)
        val tree = findByLabelPrefix(PILL_LABEL)
        if (dom == null || tree == null) {
            finding("calibration: pill DOM $dom, tree $tree; keeping offsets $offsetX/$offsetY")
            return
        }
        offsetX = tree.left - dom.left * density
        offsetY = tree.top - dom.top * density
        finding("calibration: pill DOM $dom x$density -> tree $tree; offsets ${offsetX.roundToInt()}/${offsetY.roundToInt()}, width ratio ${tree.width() / (dom.width() * density)}")
    }

    /** A CSS rect of the chrome as screen px. */
    private fun screen(r: RectF?): RectF? = r?.let {
        RectF(offsetX + it.left * density, offsetY + it.top * density, offsetX + it.right * density, offsetY + it.bottom * density)
    }

    /** The bounding rect (CSS px) of the first element `selector` matches; null when none. */
    private fun domRect(selector: String): RectF? {
        val raw = chromeJs(
            "(function(){var e=document.querySelector(${JSONObject.quote(selector)});if(!e)return null;" +
                "var b=e.getBoundingClientRect();return [b.left,b.top,b.width,b.height]})()"
        )
        if (raw.isEmpty() || raw == "null") return null
        val a = runCatching { JSONArray(raw) }.getOrNull() ?: return null
        val l = a.getDouble(0).toFloat()
        val t = a.getDouble(1).toFloat()
        return RectF(l, t, l + a.getDouble(2).toFloat(), t + a.getDouble(3).toFloat())
    }

    /** A real touch on the middle of the element `selector` matches; false (and a note) when there is none. */
    private fun tapDom(selector: String): Boolean {
        val target = screen(domRect(selector)) ?: run {
            finding("  no element for $selector to tap")
            return false
        }
        Finger().tap(target.centerX(), target.centerY())
        return true
    }

    private fun awaitDom(selector: String, timeoutMs: Long = 4_000): Boolean = awaitTrue(timeoutMs) { domRect(selector) != null }

    private fun awaitDomGone(selector: String, timeoutMs: Long = 4_000): Boolean = awaitTrue(timeoutMs) { domRect(selector) == null }

    /** Whether the first element `selector` matches stands under an `inert` (itself included); null when none matches. */
    private fun underInert(selector: String): Boolean? =
        jsText("(function(){var e=document.querySelector(${JSONObject.quote(selector)});return e?String(!!e.closest('[inert]')):'none'})()").toBooleanStrictOrNull()

    // --- the chrome's and the core's state -------------------------------------------------------

    private fun formFactor(): String = jsText("document.documentElement.dataset.formFactor")
    private fun viewportText(): String = jsText("(function(){var v=window.__zenStores.viewport.get();return v.width+'x'+v.height+' '+v.formFactor+(v.coarse?' coarse':'')})()")

    private fun awaitFormFactor(expected: String, timeoutMs: Long = 10_000): Boolean = awaitTrue(timeoutMs) { formFactor() == expected }

    /** The ui store's toasts: message, seat and whether leaving, one per line. */
    private fun toastsText(): String = jsText(
        "window.__zenStores.ui.get().toasts.map(function(t){return JSON.stringify(t.message)+(t.seat?' seat '+t.seat:' column')+(t.leaving?' leaving':'')}).join(' | ')"
    )

    /** The host's seat in a word: lifted or down, inert or not, and how many cards it holds. */
    private fun seatText(): String = jsText(
        "(function(){var s=document.querySelector('$SEAT');if(!s)return 'no seat';return (s.hasAttribute('data-lifted')?'lifted':'down')+(s.hasAttribute('inert')?', inert':'')+', '+s.querySelectorAll('.zen-message-toast').length+' card(s)'})()"
    )

    /** The origins on the core's revoked list (`revokedUnusedPermissions`). */
    private fun revokedOrigins(): List<String> {
        val list = coreState().optJSONArray("revokedUnusedPermissions") ?: return emptyList()
        return (0 until list.length()).mapNotNull { list.optJSONObject(it)?.optString("origin") }
    }

    private fun jsBoolean(code: String): Boolean = chromeJs("!!($code)") == "true"

    /** The value `code` evaluates to, as text (a string unquoted; anything else as its JSON). */
    private fun jsText(code: String): String {
        val raw = chromeJs("(function(){var v=($code);return v===undefined?'undefined':(typeof v==='string'?v:JSON.stringify(v))})()")
        if (raw.isEmpty()) return ""
        return runCatching { (JSONTokener(raw).nextValue() as? String) ?: raw }.getOrDefault(raw)
    }

    private fun fmt(value: Float): String = String.format("%.1f", value)

    private fun hostOf(origin: String): String = origin.removePrefix("https://").removePrefix("http://")

    // --- the record -------------------------------------------------------------------------------

    private fun framesSettled() {
        awaitShots()
        SystemClock.sleep(1_000)
    }

    override fun noteLine(line: String) {
        super.noteLine(line)
        findings.append(line).append('\n')
    }

    private fun finding(line: String) {
        Log.i(tag, line)
        findings.append(line).append('\n')
    }

    /** A claim of the sequence: written down either way; one that did not hold fails the run at the end. */
    private fun check(claim: String, held: Boolean, detail: String) {
        if (held) {
            finding("OK   $claim${if (detail.isNotEmpty()) " ($detail)" else ""}")
            return
        }
        finding("FAIL $claim ($detail)")
        Log.e(tag, "CLAIM FAILED: $claim ($detail)")
        failures += "$claim ($detail)"
    }

    companion object {
        private const val PORT = 18179
        private const val GRANTED_ORIGIN = "https://meet.example"
        private const val FIRST_REVOKED = "https://old-news.example"
        private const val SECOND_REVOKED = "https://weather.example"

        /** §9.33's Undo clock (`TOAST_UNDO_MS`, shared/toastCard.ts). */
        private const val UNDO_MS = 8_000L
        /** The frame's message inset (`--zen-message-inset`, main.css). */
        private const val INSET = 8f
        private const val MAX_TABS = 10
        private const val IN_DIALOG = "@dialog"

        private const val ADDRESS_PILL = ".zen-tablet-toolbar [data-address-pill]"
        private const val SIDEBAR = ".zen-tablet-sidebar"
        private const val CONTENT = ".zen-content-frame"
        private const val MESSAGE_FRAME = ".zen-tablet-message-frame"
        /** The frame dialog host on the content frame's box, its dialogs' slot and its toast seat (lib/portals.tsx). */
        private const val HOST = ".zen-frame-dialogs"
        private const val SLOT = ".zen-frame-dialogs-slot"
        private const val SEAT = ".zen-frame-toast-seat"
        private const val TWO_PANE = ".zen-settings-page[data-layout=\"two-pane\"]"
        private const val REVIEW_ROW = "[data-row=\"safety-check:permissions\"]"
        private const val DIALOG = "[data-dialog=\"item:safety-check:permissions\"]"
        private const val GOT_IT = "$DIALOG [data-row=\"safety-check:permissions:revoked:acknowledge\"]"
        private const val UNDO = ".zen-message-button"
        private const val LIFTED_CARD = "$SEAT[data-lifted] .zen-message-toast:not([data-leaving])"
        private const val LIVE_CARD = "$SEAT .zen-message-toast:not([data-leaving])"
        private const val MARKED = ".zen-message-toast[data-demo-mark=\"orphan\"]"
        private const val TABBABLE = "button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex=\"-1\"])"

        private fun revokedRow(origin: String) = "$DIALOG [data-row=\"safety-check:permissions:revoked:$origin\"]"
        private fun allowAgain(origin: String) = "${revokedRow(origin)} button"

        private val THEME = InstrumentationRegistry.getArguments().getString("theme").let {
            if (it == "dark") "dark" else "light"
        }

        private val PAGE_BODY = (1..12).joinToString("") {
            "<p>The Site permissions review on the tablet: paragraph $it of 12, so the page under the Settings tab has a body.</p>"
        }
    }
}
