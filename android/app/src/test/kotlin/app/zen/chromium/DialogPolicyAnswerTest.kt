package app.zen.chromium

import app.zen.chromium.DialogPolicyAnswer.Decision
import app.zen.chromium.DialogPolicyAnswer.Entry
import app.zen.chromium.DialogPolicyAnswer.Policy
import app.zen.chromium.DialogPolicyAnswer.Report
import app.zen.chromium.DialogPolicyAnswer.Said
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * An agent's dialog policy on the phone (`DialogPolicyAnswer`, `browser_dialog_policy`): only a
 * dialog of a tab an agent drives hidden – not under a close the user started, not the tab in
 * front – is the policy's; it is answered from the kind's entry or its default and reported
 * with the rule that answered. Everything else is today's path.
 */
class DialogPolicyAnswerTest {
    private val url = "https://example.com/form"

    private fun decide(
        kind: PageDialogKind,
        policy: Policy?,
        agentDriven: Boolean = true,
        shown: Boolean = false,
        userUnload: Boolean = false,
        message: String? = "Sure?",
        defaultValue: String? = if (kind == PageDialogKind.PROMPT) "anon" else null
    ): Decision = DialogPolicyAnswer.decide(
        kind, policy, agentDriven, shown, userUnload, url, message, defaultValue
    )

    private fun answer(kind: PageDialogKind, policy: Policy?) =
        decide(kind, policy) as Decision.Answer

    private fun entry(answer: Any?, rule: String = "tab") = json("answer" to answer, "rule" to rule)

    private fun policy(vararg kinds: Pair<String, Any?>) = DialogPolicyAnswer.parse(json(*kinds))

    private val kinds = PageDialogKind.values().toList()

    // --- whose the dialog is ------------------------------------------------------------------

    @Test
    fun onlyAHiddenAgentDrivenTabOutsideAUsersUnloadIsThePolicys() {
        val full = policy(
            "confirm" to entry("accept"),
            "prompt" to entry("accept"),
            "beforeunload" to entry("stay")
        )
        for (kind in kinds) for (agent in listOf(true, false)) for (shown in listOf(true, false)) {
            for (unload in listOf(true, false)) for (p in listOf(full, null)) {
                val row = "$kind agent=$agent shown=$shown unload=$unload policy=${p != null}"
                val decision =
                    decide(kind, p, agentDriven = agent, shown = shown, userUnload = unload)
                val policys = agent && !shown && !unload
                assertEquals(row, policys, decision is Decision.Answer)
                assertEquals(row, !policys, decision == Decision.Today)
            }
        }
    }

    @Test
    fun theTabInFrontKeepsTodaysPathWhateverThePolicySays() {
        val p = policy("confirm" to entry("accept"))
        assertEquals(Decision.Today, decide(PageDialogKind.CONFIRM, p, shown = true))
        // The user's close is the user's: the unload check settles it, no sheet, no report.
        assertEquals(Decision.Today, decide(PageDialogKind.LEAVE, p, userUnload = true))
        // A tab no agent drives is the user's, policy object or not.
        assertEquals(Decision.Today, decide(PageDialogKind.ALERT, p, agentDriven = false))
    }

    // --- the answers --------------------------------------------------------------------------

    @Test
    fun anAlertIsAlwaysOkAndReportedUnderTheRulesThatStand() {
        val none = answer(PageDialogKind.ALERT, null)
        assertTrue(none.accepted)
        assertNull(none.text)
        assertEquals(Said.Accept, none.report.answer)
        assertEquals("default", none.report.rule)
        assertEquals("alert", none.report.kind)
        val session = policy("confirm" to entry("dismiss", "session"))
        assertEquals("session", answer(PageDialogKind.ALERT, session).report.rule)
        val tab = policy(
            "confirm" to entry("dismiss", "session"),
            "beforeunload" to entry("leave", "tab")
        )
        assertEquals("tab", answer(PageDialogKind.ALERT, tab).report.rule)
    }

    @Test
    fun aConfirmFollowsItsEntryOrIsCancelledByDefault() {
        val byDefault = answer(PageDialogKind.CONFIRM, null)
        assertFalse(byDefault.accepted)
        assertEquals(Said.Dismiss, byDefault.report.answer)
        assertEquals("default", byDefault.report.rule)
        val ok = answer(PageDialogKind.CONFIRM, policy("confirm" to entry("accept", "tab")))
        assertTrue(ok.accepted)
        assertEquals(Said.Accept, ok.report.answer)
        assertEquals("tab", ok.report.rule)
        val cancel =
            answer(PageDialogKind.CONFIRM, policy("confirm" to entry("dismiss", "session")))
        assertFalse(cancel.accepted)
        assertEquals("session", cancel.report.rule)
        // Another kind's entry is not a confirm's: the default stands, and says so.
        val other = answer(PageDialogKind.CONFIRM, policy("prompt" to entry("accept")))
        assertFalse(other.accepted)
        assertEquals("default", other.report.rule)
    }

    @Test
    fun aPromptFollowsItsEntryTheFieldsOwnTextOnAcceptAndIsCancelledByDefault() {
        val byDefault = answer(PageDialogKind.PROMPT, null)
        assertFalse(byDefault.accepted)
        assertNull(byDefault.text)
        assertEquals(Said.Dismiss, byDefault.report.answer)
        assertEquals("anon", byDefault.report.defaultValue)
        assertEquals("default", byDefault.report.rule)
        // OK with the page's own text: reported as that text, as the core reports its own.
        val ok = answer(PageDialogKind.PROMPT, policy("prompt" to entry("accept", "session")))
        assertTrue(ok.accepted)
        assertEquals("anon", ok.text)
        assertEquals(Said.Text("anon"), ok.report.answer)
        assertEquals("session", ok.report.rule)
        val zenium = policy("prompt" to entry(json("text" to "Zenium"), "tab"))
        val text = answer(PageDialogKind.PROMPT, zenium)
        assertTrue(text.accepted)
        assertEquals("Zenium", text.text)
        assertEquals(Said.Text("Zenium"), text.report.answer)
        assertEquals("tab", text.report.rule)
        val cancel = answer(PageDialogKind.PROMPT, policy("prompt" to entry("dismiss")))
        assertFalse(cancel.accepted)
        assertNull(cancel.text)
        // A WebView may hand no default at all: the report says the field was empty.
        val empty = decide(
            PageDialogKind.PROMPT, policy("prompt" to entry("accept")),
            message = "Name?", defaultValue = null
        ) as Decision.Answer
        assertEquals("", empty.text)
        assertEquals("", empty.report.defaultValue)
        assertEquals(Said.Text(""), empty.report.answer)
    }

    @Test
    fun aLeaveSiteQuestionLeavesByDefaultOrStaysAndCarriesChromesLine() {
        for (kind in listOf(PageDialogKind.LEAVE, PageDialogKind.RELOAD)) {
            val byDefault = answer(kind, null)
            assertTrue("$kind", byDefault.accepted)
            assertEquals("$kind", Said.Leave, byDefault.report.answer)
            assertEquals("$kind", "default", byDefault.report.rule)
            assertEquals("$kind", "beforeunload", byDefault.report.kind)
            // The page's own `beforeunload` text is never shown, nor reported: Chrome's line is.
            assertEquals("$kind", "Changes you made may not be saved.", byDefault.report.message)
            assertNull("$kind", byDefault.report.defaultValue)
            val stay = answer(kind, policy("beforeunload" to entry("stay", "tab")))
            assertFalse("$kind", stay.accepted)
            assertEquals("$kind", Said.Stay, stay.report.answer)
            assertEquals("$kind", "tab", stay.report.rule)
            val leave = answer(kind, policy("beforeunload" to entry("leave", "session")))
            assertTrue("$kind", leave.accepted)
            assertEquals("$kind", "session", leave.report.rule)
        }
        assertEquals("Changes you made may not be saved.", DialogPolicyAnswer.LEAVE_SITE_MESSAGE)
    }

    @Test
    fun theReportNamesTheDocumentAndCapsTheMessageWhereTheCoreQuotesIt() {
        val long = decide(PageDialogKind.ALERT, null, message = "x".repeat(700)) as Decision.Answer
        assertEquals(url, long.report.url)
        assertEquals("x".repeat(500), long.report.message)
        assertEquals(500, DialogPolicyAnswer.MESSAGE_CAP)
        // A page may confirm with nothing at all.
        val none = decide(PageDialogKind.CONFIRM, null, message = null) as Decision.Answer
        assertEquals("", none.report.message)
    }

    // --- the wire -----------------------------------------------------------------------------

    @Test
    fun theReportsJsonIsTheCoresPageDialogAnswered() {
        val prompt = Report("prompt", url, "Name?", "anon", Said.Text("Zenium"), "tab").toJson()
        assertEquals("prompt", prompt.getString("kind"))
        assertEquals(url, prompt.getString("url"))
        assertEquals("Name?", prompt.getString("message"))
        assertEquals("anon", prompt.getString("defaultValue"))
        assertEquals("Zenium", prompt.getJSONObject("answer").getString("text"))
        assertEquals("tab", prompt.getString("rule"))
        // Only a prompt carries a default; the other answers are the core's words.
        val confirm = Report("confirm", url, "Sure?", null, Said.Dismiss, "default").toJson()
        assertFalse(confirm.has("defaultValue"))
        assertEquals("dismiss", confirm.getString("answer"))
        fun wire(kind: String, said: Said, rule: String) =
            Report(kind, url, "", null, said, rule).toJson().getString("answer")
        assertEquals("accept", wire("alert", Said.Accept, "session"))
        assertEquals("leave", wire("beforeunload", Said.Leave, "default"))
        assertEquals("stay", wire("beforeunload", Said.Stay, "tab"))
    }

    // --- the policy as the core hands it ------------------------------------------------------

    @Test
    fun thePolicyIsReadKindByKindWithItsRule() {
        val read = policy(
            "confirm" to entry("accept", "tab"),
            "prompt" to entry(json("text" to "hi"), "session"),
            "beforeunload" to entry("stay", "session")
        )
        assertEquals(
            Policy(
                confirm = Entry(Said.Accept, "tab"),
                prompt = Entry(Said.Text("hi"), "session"),
                beforeunload = Entry(Said.Stay, "session")
            ),
            read
        )
        assertEquals(
            Policy(prompt = Entry(Said.Dismiss, "tab")),
            policy("prompt" to entry("dismiss", "tab"))
        )
    }

    @Test
    fun noPolicyAndNothingReadableAreNone() {
        assertNull(DialogPolicyAnswer.parse(null))
        assertNull(DialogPolicyAnswer.parse(JSONObject()))
        // An entry the host cannot read is dropped (its kind takes the default), never guessed.
        assertNull(policy("confirm" to entry("ok", "tab")))
        assertNull(policy("confirm" to entry("accept", "once")))
        assertNull(policy("beforeunload" to entry("accept", "tab")))
        assertNull(policy("prompt" to entry(json("txt" to "x"), "tab")))
        assertNull(policy("confirm" to "accept"))
        val half = policy("confirm" to entry("accept", "tab"), "prompt" to entry("yes", "tab"))
        assertEquals(Policy(confirm = Entry(Said.Accept, "tab")), half)
    }

    @Test
    fun anAlertsRuleIsTheTabsWhenAnyKindIsTheTabsElseTheSessionsElseNone() {
        assertEquals("default", Policy().alertRule)
        val session = Entry(Said.Dismiss, "session")
        val tab = Entry(Said.Stay, "tab")
        assertEquals("session", Policy(confirm = session).alertRule)
        assertEquals("tab", Policy(confirm = session, beforeunload = tab).alertRule)
    }
}
