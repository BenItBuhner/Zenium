package app.zen.chromium

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * The frame-owner protocol's host side ([ImageOwner]), every case of the interface document's
 * §7.2 on the JVM: the frames are identity-only stand-ins for `JavaScriptReplyProxy` (which has
 * no `equals` / `hashCode` of its own either), the clock is a hand-turned scheduler, the nonce
 * comes from pinned bytes, and what the host posts is caught rather than sent.
 */
class ImageOwnerTest {
    /** A frame document's reply proxy: told apart by identity alone, as the real one is. */
    private class Frame(private val name: String) {
        override fun toString(): String = name
    }

    private class Timer(val due: Long, val block: () -> Unit)

    /** The main looper stood in for: `postDelayed` and its cancel, turned by hand. */
    private class Clock {
        var now = 0L
        val pending = ArrayList<Timer>()

        fun schedule(delayMs: Long, block: () -> Unit): () -> Unit {
            val timer = Timer(now + delayMs, block)
            pending.add(timer)
            return { pending.remove(timer) }
        }

        fun advance(ms: Long) {
            val until = now + ms
            while (true) {
                val next = pending.filter { it.due <= until }.minByOrNull { it.due } ?: break
                pending.remove(next)
                now = next.due
                next.block()
            }
            now = until
        }
    }

    private class Harness(vararg nonceList: String) {
        val clock = Clock()
        val posted = ArrayList<Pair<Frame, JSONObject>>()
        val replies = ArrayList<String>()
        /** The nonces the requests draw, in order, the last one again after (the pinned vector's alone unless told). */
        private val nonces = ArrayDeque(if (nonceList.isEmpty()) listOf(NONCE) else nonceList.toList())
        val owner = ImageOwner<Frame>(
            schedule = clock::schedule,
            randomBytes = { count -> bytes(if (nonces.size > 1) nonces.removeFirst() else nonces.first()).copyOf(count) },
            post = { frame, json -> posted.add(frame to JSONObject(json)) }
        )
        val main = Frame("main")

        fun start(
            src: String = URL,
            mainFrame: Frame? = main,
            legacy: Boolean = false,
            maxBytes: Long = MAX_BYTES,
            quality: Double = 0.4
        ) = owner.start(src, BOUNDS, quality, maxBytes, mainFrame, legacy) { replies.add(it) }

        fun answer(frame: Frame, hashes: List<String>, nonce: String = NONCE, isMainFrame: Boolean = frame === main, v: Any = 1) =
            owner.onMessage(
                json("v" to v, "type" to "zen:image-owner", "nonce" to nonce, "hashes" to JSONArray(hashes), "truncated" to false),
                frame, isMainFrame
            )

        fun thumbnail(frame: Frame, result: JSONObject, nonce: String = NONCE, v: Any = 1) =
            owner.onMessage(json("v" to v, "type" to "zen:image-thumbnail", "nonce" to nonce, "result" to result), frame, frame === main)

        /** What went to [frame], in order. */
        fun postedTo(frame: Frame): List<JSONObject> = posted.filter { it.first === frame }.map { it.second }
    }

    // --- the broadcast ---------------------------------------------------------------------------

    @Test
    fun theQuestionReachesTheSubFramesFirstAndTheMainDocumentLast() {
        val h = Harness()
        val f1 = Frame("f1")
        val f2 = Frame("f2")
        h.owner.registerFrame(f1)
        h.owner.registerFrame(f2)
        h.start()
        assertEquals(listOf(f1, f2, h.main), h.posted.map { it.first })
        for ((_, question) in h.posted) {
            assertEquals(1, question.getInt("v"))
            assertEquals("zen:image-owner?", question.getString("type"))
            assertEquals(NONCE, question.getString("nonce"))
            assertEquals("sha256", question.getString("alg"))
            // Option B: the nonce goes down, never the hash (nor the URL).
            assertFalse(question.has("hash"))
            assertFalse(question.toString().contains("example.com"))
        }
        assertTrue(NONCE.matches(Regex("[0-9a-f]{32}")))
        assertTrue(h.owner.busy)
        assertTrue(h.replies.isEmpty())
    }

    @Test
    fun theSubFramesAreAskedInTheOrderTheySaidHelloAndOnceEach() {
        val h = Harness()
        val frames = List(5) { Frame("f$it") }
        for (f in frames) h.owner.registerFrame(f)
        // The same document's proxy again keeps its place; nothing is asked twice.
        h.owner.registerFrame(frames[1])
        h.owner.registerFrame(frames[0])
        assertEquals(5, h.owner.frameCount)
        h.start()
        assertEquals(frames + h.main, h.posted.map { it.first })
    }

    // --- who is owner ------------------------------------------------------------------------------

    @Test
    fun aHostileTopFramesForgedAnswerIsIgnoredAndTheSubFrameHoldingTheImageIsOwner() {
        val h = Harness()
        val f1 = Frame("f1")
        val f2 = Frame("f2")
        h.owner.registerFrame(f1)
        h.owner.registerFrame(f2)
        h.start()
        h.posted.clear()
        // The top page answers first, with the hashes of URLs it holds – not the hit-tested one,
        // whose URL it never saw (nothing but the nonce went down).
        h.answer(h.main, listOf(other("https://top.example/logo.png"), other("https://top.example/hero.jpg")))
        assertTrue(h.posted.isEmpty())
        assertTrue(h.replies.isEmpty())
        // The frame that holds the image names H among its hashes.
        h.answer(f1, listOf(other("https://frame.example/b.png"), HASH))
        assertEquals(listOf(f1), h.posted.map { it.first })
        val ask = h.posted.single().second
        assertEquals(1, ask.getInt("v"))
        assertEquals("zen:image-thumbnail", ask.getString("type"))
        assertEquals(NONCE, ask.getString("nonce"))
        assertEquals(HASH, ask.getString("hash"))
        assertEquals(1000, ask.getJSONObject("bounds").getInt("maxSide"))
        assertEquals(90_000, ask.getJSONObject("bounds").getInt("minArea"))
        assertEquals(0.4, ask.getDouble("quality"), 0.0)
        assertEquals(MAX_BYTES, ask.getLong("maxBytes"))
        assertFalse(ask.toString().contains("example.com"))
        // Still collecting nothing: a later match from another frame changes nothing.
        h.answer(f2, listOf(HASH))
        assertEquals(1, h.posted.size)
        // The owner's bytes go to the core as they came.
        val result = okResult("QUJD")
        h.thumbnail(f1, result)
        assertEquals(listOf(result.toString()), h.replies)
        assertFalse(h.owner.busy)
    }

    @Test
    fun aTopFrameAnswerContainingTheHashIsAcceptedTheTopDocumentMayHoldTheImage() {
        // Accepted, and documented so (§5 rule 2): a top page that knew the URL – because the
        // image is its own, or because it guessed right – is owner when it answers first.
        val h = Harness()
        val f1 = Frame("f1")
        h.owner.registerFrame(f1)
        h.start()
        h.posted.clear()
        h.answer(h.main, listOf(other("https://top.example/logo.png"), HASH))
        assertEquals(listOf(h.main), h.posted.map { it.first })
        assertEquals("zen:image-thumbnail", h.posted.single().second.getString("type"))
        h.answer(f1, listOf(HASH))
        assertEquals(1, h.posted.size)
        val result = okResult("QUJD")
        h.thumbnail(h.main, result)
        assertEquals(listOf(result.toString()), h.replies)
    }

    @Test
    fun theMatchIsContainsOverTheWholeListNotOneValuesEquality() {
        val h = Harness()
        val f1 = Frame("f1")
        h.owner.registerFrame(f1)
        h.start()
        h.posted.clear()
        // H deep in a long list is found; the first entry is not what is compared.
        val many = List(2047) { other("https://frame.example/$it.png") } + HASH
        assertEquals(ImageOwner.OWNER_MAX_HASHES, many.size)
        h.answer(f1, many)
        assertEquals(listOf(f1), h.posted.map { it.first })
    }

    @Test
    fun theHostReadsAtMostTheFramesCapOfHashes() {
        val h = Harness()
        val f1 = Frame("f1")
        h.owner.registerFrame(f1)
        h.start()
        h.posted.clear()
        // H past the 2048th entry of an answer that ignored the cap is not read: the answer counts
        // as one without it.
        val tooMany = List(ImageOwner.OWNER_MAX_HASHES) { other("https://frame.example/$it.png") } + HASH
        h.answer(f1, tooMany)
        assertTrue(h.posted.isEmpty())
        h.clock.advance(ImageOwner.OWNER_COLLECT_MS)
        assertEquals(listOf(failure("no-owner")), h.replies)
    }

    // --- the nonce's death -------------------------------------------------------------------------

    @Test
    fun anAnswerAfterNoOwnerIsDropped() {
        val h = Harness()
        val f1 = Frame("f1")
        h.owner.registerFrame(f1)
        h.start()
        h.posted.clear()
        h.clock.advance(ImageOwner.OWNER_COLLECT_MS)
        assertEquals(listOf(failure("no-owner")), h.replies)
        assertFalse(h.owner.busy)
        h.answer(f1, listOf(HASH))
        assertTrue(h.posted.isEmpty())
        assertEquals(1, h.replies.size)
    }

    @Test
    fun anAnswerAfterTheResultIsDropped() {
        val h = Harness()
        val f1 = Frame("f1")
        val f2 = Frame("f2")
        h.owner.registerFrame(f1)
        h.owner.registerFrame(f2)
        h.start()
        h.answer(f1, listOf(HASH))
        h.thumbnail(f1, okResult("QUJD"))
        assertEquals(1, h.replies.size)
        h.posted.clear()
        h.answer(f2, listOf(HASH))
        h.thumbnail(f1, okResult("REVG"))
        assertTrue(h.posted.isEmpty())
        assertEquals(1, h.replies.size)
    }

    @Test
    fun anAnswerAfterTheMainDocumentChangedIsDroppedAndTheFramesAreForgotten() {
        val h = Harness()
        val f1 = Frame("f1")
        h.owner.registerFrame(f1)
        h.start()
        h.posted.clear()
        // onPageStarted: the frames were the old document's, and so was the request.
        h.owner.documentStarted()
        assertEquals(listOf(failure("timeout")), h.replies)
        assertEquals(0, h.owner.frameCount)
        assertFalse(h.owner.busy)
        h.answer(f1, listOf(HASH))
        assertTrue(h.posted.isEmpty())
        assertEquals(1, h.replies.size)
        // Nothing fires later for the dead request.
        h.clock.advance(ImageOwner.OWNER_THUMBNAIL_MS)
        assertEquals(1, h.replies.size)
    }

    @Test
    fun theViewsEndKillsTheRequestAndForgetsTheFrames() {
        val h = Harness()
        h.owner.registerFrame(Frame("f1"))
        h.start()
        h.owner.destroy()
        assertEquals(listOf(failure("timeout")), h.replies)
        assertEquals(0, h.owner.frameCount)
        assertTrue(h.clock.pending.isEmpty())
    }

    @Test
    fun anUnknownNonceIsDropped() {
        val h = Harness()
        val f1 = Frame("f1")
        h.owner.registerFrame(f1)
        // Before any request: nothing is live.
        h.answer(f1, listOf(HASH))
        h.thumbnail(f1, okResult("QUJD"))
        assertTrue(h.posted.isEmpty())
        h.start()
        h.posted.clear()
        // A nonce never issued, with the right hash for it.
        val forged = "ffffffffffffffffffffffffffffffff"
        h.answer(f1, listOf(ImageOwner.hashFor(forged, URL)), nonce = forged)
        h.thumbnail(f1, okResult("QUJD"), nonce = forged)
        assertTrue(h.posted.isEmpty())
        assertTrue(h.replies.isEmpty())
        assertTrue(h.owner.busy)
    }

    @Test
    fun aSecondAnswerFromTheSameProxyIsDropped() {
        val h = Harness()
        val f1 = Frame("f1")
        val f2 = Frame("f2")
        h.owner.registerFrame(f1)
        h.owner.registerFrame(f2)
        h.start()
        h.posted.clear()
        h.answer(f1, emptyList())
        // Its second word – now with H – is not heard.
        h.answer(f1, listOf(HASH))
        assertTrue(h.posted.isEmpty())
        // Nor does it count as another frame answered: f2 and the main document are still owed.
        h.clock.advance(ImageOwner.OWNER_COLLECT_MS - 1)
        assertTrue(h.replies.isEmpty())
        h.clock.advance(1)
        assertEquals(listOf(failure("no-owner")), h.replies)
    }

    @Test
    fun aThumbnailFromANonOwnerProxyForTheLiveNonceIsDropped() {
        val h = Harness()
        val f1 = Frame("f1")
        val f2 = Frame("f2")
        h.owner.registerFrame(f1)
        h.owner.registerFrame(f2)
        h.start()
        // Before an owner is named, no thumbnail is taken from anyone.
        h.thumbnail(f1, okResult("QUJD"))
        assertTrue(h.replies.isEmpty())
        h.answer(f1, listOf(HASH))
        // The other sub-frame's and the top document's bytes for the live nonce are not the owner's.
        h.thumbnail(f2, okResult("REVG"))
        h.thumbnail(h.main, okResult("R0hJ"))
        assertTrue(h.replies.isEmpty())
        assertTrue(h.owner.busy)
        val result = okResult("QUJD")
        h.thumbnail(f1, result)
        assertEquals(listOf(result.toString()), h.replies)
    }

    // --- timing ------------------------------------------------------------------------------------

    @Test
    fun noMatchAndNotEveryFrameAnsweredIsNoOwnerWhenTheWindowEnds() {
        val h = Harness()
        val f1 = Frame("f1")
        val f2 = Frame("f2")
        h.owner.registerFrame(f1)
        h.owner.registerFrame(f2)
        h.start()
        h.answer(f1, listOf(other("https://frame.example/b.png")))
        h.clock.advance(ImageOwner.OWNER_COLLECT_MS - 1)
        assertTrue(h.replies.isEmpty())
        h.clock.advance(1)
        assertEquals(listOf(failure("no-owner")), h.replies)
        assertFalse(h.owner.busy)
        assertEquals(300L, ImageOwner.OWNER_COLLECT_MS)
    }

    @Test
    fun everyFrameAnsweredWithoutTheHashIsNoOwnerBeforeTheWindowEnds() {
        val h = Harness()
        val f1 = Frame("f1")
        val f2 = Frame("f2")
        h.owner.registerFrame(f1)
        h.owner.registerFrame(f2)
        h.start()
        h.clock.advance(10)
        h.answer(f1, emptyList())
        h.answer(f2, listOf(other("https://frame.example/b.png")))
        assertTrue(h.replies.isEmpty())
        h.answer(h.main, emptyList())
        assertEquals(listOf(failure("no-owner")), h.replies)
        assertEquals(10L, h.clock.now)
        // The window's timer is gone with the request.
        assertTrue(h.clock.pending.isEmpty())
        h.clock.advance(ImageOwner.OWNER_COLLECT_MS)
        assertEquals(1, h.replies.size)
    }

    @Test
    fun aSilentOwnerIsTimeoutAtTheDeadlineAndItsLateBytesAreDropped() {
        val h = Harness()
        val f1 = Frame("f1")
        h.owner.registerFrame(f1)
        h.start()
        h.clock.advance(100)
        h.answer(f1, listOf(HASH))
        // The collect window no longer ends the request: the owner is named.
        h.clock.advance(ImageOwner.OWNER_COLLECT_MS)
        assertTrue(h.replies.isEmpty())
        assertTrue(h.owner.busy)
        h.clock.advance(ImageOwner.OWNER_THUMBNAIL_MS - ImageOwner.OWNER_COLLECT_MS - 1)
        assertTrue(h.replies.isEmpty())
        h.clock.advance(1)
        assertEquals(listOf(failure("timeout")), h.replies)
        assertEquals(100L + ImageOwner.OWNER_THUMBNAIL_MS, h.clock.now)
        assertFalse(h.owner.busy)
        h.thumbnail(f1, okResult("QUJD"))
        assertEquals(1, h.replies.size)
        assertEquals(15_000L, ImageOwner.OWNER_THUMBNAIL_MS)
    }

    @Test
    fun theRegistryKeepsTheLastFramesAndDropsTheOldest() {
        val h = Harness()
        val frames = List(ImageOwner.OWNER_MAX_FRAMES + 1) { Frame("f$it") }
        for (f in frames) h.owner.registerFrame(f)
        assertEquals(ImageOwner.OWNER_MAX_FRAMES, h.owner.frameCount)
        assertEquals(256, ImageOwner.OWNER_MAX_FRAMES)
        h.start()
        val asked = h.posted.map { it.first }
        assertEquals(ImageOwner.OWNER_MAX_FRAMES + 1, asked.size)
        // The first registered is gone, the newest is there, the order is the hellos', main last.
        assertFalse(asked.any { it === frames[0] })
        assertEquals(frames.drop(1) + h.main, asked)
    }

    // --- the hash ------------------------------------------------------------------------------------

    @Test
    fun theHashIsThePinnedVectorOverTheNonceThenTheUrl() {
        // §2.5: sha256("0123456789abcdef0123456789abcdef" + "https://example.com/a.png"), the same
        // literal the shared TypeScript's test pins.
        assertEquals(HASH, ImageOwner.hashFor(NONCE, URL))
        assertEquals("5008d908d5e08c6645f6aa651b540491afe63dde85ea320e6774c2808abbd885", HASH)
        assertTrue(HASH.matches(Regex("[0-9a-f]{64}")))
        // No separator, no length prefix: a different split of the same bytes is the same hash.
        assertEquals(ImageOwner.hashFor(NONCE + "https://", "example.com/a.png"), HASH)
        // UTF-8, not the platform's default nor UTF-16.
        assertEquals(
            ImageOwner.hashFor(NONCE, "https://example.com/caf\u00e9.png"),
            hex(java.security.MessageDigest.getInstance("SHA-256").digest((NONCE + "https://example.com/caf\u00e9.png").toByteArray(Charsets.UTF_8)))
        )
    }

    @Test
    fun theFragmentIsCutAndNothingElseIsNormalised() {
        assertEquals(URL, ImageOwner.hashInput("$URL#icon"))
        assertEquals(URL, ImageOwner.hashInput("$URL#a#b"))
        assertEquals(URL, ImageOwner.hashInput(URL))
        assertEquals("https://Example.com/A.PNG?q=1", ImageOwner.hashInput("https://Example.com/A.PNG?q=1#x"))
        assertEquals("", ImageOwner.hashInput("#only"))
        // A request for the fragment-bearing hit-test URL matches the frame's hash of the bare one.
        val h = Harness()
        val f1 = Frame("f1")
        h.owner.registerFrame(f1)
        h.start(src = "$URL#icon")
        h.posted.clear()
        h.answer(f1, listOf(HASH))
        assertEquals(listOf(f1), h.posted.map { it.first })
        assertEquals(HASH, h.posted.single().second.getString("hash"))
    }

    // --- the verb's edges ----------------------------------------------------------------------------

    @Test
    fun theLegacyChannelIsUnsupportedAtOnce() {
        val h = Harness()
        h.owner.registerFrame(Frame("f1"))
        h.start(legacy = true)
        assertEquals(listOf(failure("unsupported")), h.replies)
        assertTrue(h.posted.isEmpty())
        assertFalse(h.owner.busy)
        assertTrue(h.clock.pending.isEmpty())
    }

    @Test
    fun noFrameToAskIsNoOwnerAtOnce() {
        val h = Harness()
        h.start(mainFrame = null)
        assertEquals(listOf(failure("no-owner")), h.replies)
        assertTrue(h.posted.isEmpty())
        assertFalse(h.owner.busy)
    }

    @Test
    fun aNewRequestKillsTheLiveOneWhosePendingReplyIsTimeout() {
        // Q5: one live nonce per tab.
        val second = "fedcba9876543210fedcba9876543210"
        val h = Harness(NONCE, second)
        val f1 = Frame("f1")
        h.owner.registerFrame(f1)
        h.start()
        assertEquals(NONCE, h.posted.first().second.getString("nonce"))
        h.posted.clear()
        h.start(src = "https://example.com/b.png")
        assertEquals(listOf(failure("timeout")), h.replies)
        assertEquals(listOf(f1, h.main), h.posted.map { it.first })
        assertTrue(h.posted.all { it.second.getString("nonce") == second })
        h.posted.clear()
        // The first nonce is dead: its hash for the first URL is no answer to anything.
        h.answer(f1, listOf(HASH))
        assertTrue(h.posted.isEmpty())
        // The second request runs on its own nonce and hash.
        val hash2 = ImageOwner.hashFor(second, "https://example.com/b.png")
        h.answer(f1, listOf(hash2), nonce = second)
        assertEquals(listOf(f1), h.posted.map { it.first })
        assertEquals(hash2, h.posted.single().second.getString("hash"))
        val result = okResult("QUJD")
        h.thumbnail(f1, result, nonce = second)
        assertEquals(listOf(failure("timeout"), result.toString()), h.replies)
        // Exactly one timer ever ran for the killed request: none is left over.
        h.clock.advance(ImageOwner.OWNER_THUMBNAIL_MS)
        assertEquals(2, h.replies.size)
    }

    @Test
    fun aKilledRequestRepliesOnceAndItsTimerIsGone() {
        val h = Harness(NONCE, "fedcba9876543210fedcba9876543210")
        h.owner.registerFrame(Frame("f1"))
        h.start()
        h.start()
        assertEquals(1, h.replies.size)
        assertEquals(1, h.clock.pending.size)
        h.clock.advance(ImageOwner.OWNER_COLLECT_MS)
        assertEquals(listOf(failure("timeout"), failure("no-owner")), h.replies)
    }

    @Test
    fun aResultPastTheBytesTheCoreAllowedIsTooLarge() {
        // base64.length ≤ 4/3 · maxBytes: 12 bytes encode to 16 characters; 17 is past it.
        val h = Harness()
        val f1 = Frame("f1")
        h.owner.registerFrame(f1)
        h.start(maxBytes = 12)
        h.answer(f1, listOf(HASH))
        h.thumbnail(f1, okResult("A".repeat(17)))
        assertEquals(listOf(failure("too-large")), h.replies)
        assertFalse(h.owner.busy)

        val fits = Harness()
        fits.owner.registerFrame(f1)
        fits.start(maxBytes = 12)
        fits.answer(f1, listOf(HASH))
        val result = okResult("A".repeat(16))
        fits.thumbnail(f1, result)
        assertEquals(listOf(result.toString()), fits.replies)
    }

    @Test
    fun theOwnersRefusalGoesToTheCoreAsItCame() {
        // Kotlin does not parse the result beyond its size: the core's parseImageFetchResult does.
        val h = Harness()
        val f1 = Frame("f1")
        h.owner.registerFrame(f1)
        h.start()
        h.answer(f1, listOf(HASH))
        val refusal = json("ok" to false, "reason" to "opaque")
        h.thumbnail(f1, refusal)
        assertEquals(listOf(refusal.toString()), h.replies)
        val odd = Harness()
        odd.owner.registerFrame(f1)
        odd.start()
        odd.answer(f1, listOf(HASH))
        val unknown = json("ok" to true, "thumbnail" to json("base64" to "QUJD", "contentType" to "image/webp", "extra" to 1))
        odd.thumbnail(f1, unknown)
        assertEquals(listOf(unknown.toString()), odd.replies)
    }

    @Test
    fun aRefusalIsTheImageFetchResultShape() {
        val parsed = JSONObject(ImageOwner.failure("no-owner"))
        assertFalse(parsed.getBoolean("ok"))
        assertEquals("no-owner", parsed.getString("reason"))
        assertEquals(2, parsed.length())
    }

    // --- protocol hygiene ----------------------------------------------------------------------------

    @Test
    fun anythingButVersionOneIsIgnored() {
        val h = Harness()
        val f1 = Frame("f1")
        h.owner.registerFrame(f1)
        h.start()
        h.posted.clear()
        h.answer(f1, listOf(HASH), v = 2)
        h.answer(f1, listOf(HASH), v = "1")
        h.owner.onMessage(json("type" to "zen:image-owner", "nonce" to NONCE, "hashes" to JSONArray(listOf(HASH))), f1, false)
        assertTrue(h.posted.isEmpty())
        // Not marked answered by a wrong-version message: its real answer still counts.
        h.answer(f1, listOf(HASH))
        assertEquals(listOf(f1), h.posted.map { it.first })
        h.posted.clear()
        h.thumbnail(f1, okResult("QUJD"), v = 2)
        assertTrue(h.replies.isEmpty())
        // 1.0 is 1 (JSON has one number type).
        h.thumbnail(f1, okResult("QUJD"), v = 1.0)
        assertEquals(1, h.replies.size)
    }

    @Test
    fun aMalformedAnswerIsNeitherAMatchNorAnAnswer() {
        val h = Harness()
        val f1 = Frame("f1")
        h.owner.registerFrame(f1)
        h.start()
        h.posted.clear()
        // No `hashes`: not read, and the frame is still owed its answer.
        h.owner.onMessage(json("v" to 1, "type" to "zen:image-owner", "nonce" to NONCE), f1, false)
        h.owner.onMessage(json("v" to 1, "type" to "zen:image-owner", "nonce" to NONCE, "hashes" to HASH), f1, false)
        h.answer(h.main, emptyList())
        assertTrue(h.replies.isEmpty())
        // A list with junk in it is read for its strings.
        h.owner.onMessage(
            json("v" to 1, "type" to "zen:image-owner", "nonce" to NONCE, "hashes" to JSONArray(listOf(7, JSONObject.NULL, HASH))),
            f1, false
        )
        assertEquals(listOf(f1), h.posted.map { it.first })
        // The owner's message without a result is not the result.
        h.owner.onMessage(json("v" to 1, "type" to "zen:image-thumbnail", "nonce" to NONCE), f1, false)
        h.owner.onMessage(json("v" to 1, "type" to "zen:image-thumbnail", "nonce" to NONCE, "result" to "ok"), f1, false)
        assertTrue(h.replies.isEmpty())
        assertTrue(h.owner.busy)
    }

    @Test
    fun aFrameNotAskedAndAProxylessMessageAreIgnored() {
        val h = Harness()
        val f1 = Frame("f1")
        h.owner.registerFrame(f1)
        h.start()
        h.posted.clear()
        // A frame that said hello after the broadcast was not asked this time.
        val late = Frame("late")
        h.owner.registerFrame(late)
        h.answer(late, listOf(HASH))
        // The legacy bridge hands no proxy: nothing is heard from it.
        h.owner.onMessage(json("v" to 1, "type" to "zen:image-owner", "nonce" to NONCE, "hashes" to JSONArray(listOf(HASH))), null, true)
        assertTrue(h.posted.isEmpty())
        assertTrue(h.owner.busy)
        // Next time the late frame is asked, after the first, before the main document.
        h.owner.documentStarted()
        h.owner.registerFrame(f1)
        h.owner.registerFrame(late)
        h.posted.clear()
        h.start()
        assertEquals(listOf(f1, late, h.main), h.posted.map { it.first })
    }

    @Test
    fun aFramesWordOnBeingTheMainDocumentMustAgreeWithItsProxy() {
        // Both are the browser's (js_to_browser_messaging.cc fixes is_main_frame with the origin
        // for the frame's lifetime), so they cannot disagree; when they do the message is dropped.
        val h = Harness()
        val f1 = Frame("f1")
        h.owner.registerFrame(f1)
        h.start()
        h.posted.clear()
        h.answer(f1, listOf(HASH), isMainFrame = true)
        h.answer(h.main, listOf(HASH), isMainFrame = false)
        assertTrue(h.posted.isEmpty())
        assertTrue(h.replies.isEmpty())
        h.answer(f1, listOf(HASH), isMainFrame = false)
        assertEquals(listOf(f1), h.posted.map { it.first })
    }

    // --- the wiring in TabWebView and Host, read as text ------------------------------------------------

    @Test
    fun theSubFramesHelloRegistersItsProxyBeforeItIsDroppedAndNeverReplacesTheReplyProxy() {
        val code = code(File(repoRoot(), "android/app/src/main/kotlin/app/zen/chromium/TabWebView.kt"))
        val onPageMessage = code.indexOf("private fun onPageMessage(message: WebMessageCompat, proxy: JavaScriptReplyProxy?, isMainFrame: Boolean = true)")
        assertTrue(onPageMessage >= 0)
        val body = code.substring(onPageMessage)
        val register = body.indexOf("if (!isMainFrame && proxy != null && route === PageMessageRoute.Hello) imageOwner().registerFrame(proxy)")
        val drop = body.indexOf("if (!route.heardFrom(isMainFrame)) return")
        assertTrue("the sub-frame's hello registers its proxy", register >= 0)
        assertTrue("before heardFrom drops it", drop > register)
        // `replyProxy = proxy` is the main document's alone: once, under Hello, after the drop.
        val assignments = Regex("""replyProxy = proxy\b""").findAll(code).map { it.range.first }.toList()
        assertEquals(1, assignments.size)
        val hello = body.indexOf("PageMessageRoute.Hello -> {")
        assertTrue(hello > drop)
        assertEquals(onPageMessage + hello, code.lastIndexOf("PageMessageRoute.Hello -> {", assignments.single()))
        // Nothing of the protocol is built with the view: a nullable field, made on first use.
        assertTrue(code.contains("private var imageOwner: ImageOwner<JavaScriptReplyProxy>? = null"))
        assertFalse(Regex("""imageOwner\s*=\s*ImageOwner""").containsMatchIn(code))
        // Cleared with the main document and with the view.
        val onPageStarted = code.indexOf("domReady.documentStarted()")
        assertTrue(onPageStarted >= 0)
        assertEquals("imageOwner?.documentStarted()", code.substring(onPageStarted).lines()[1].trim())
        assertTrue(code.contains("imageOwner?.destroy()"))
    }

    @Test
    fun theTwoTypesGoToTheOrchestratorAndNotToTheCoreAsPageMessages() {
        val code = code(File(repoRoot(), "android/app/src/main/kotlin/app/zen/chromium/TabWebView.kt"))
        val forward = code.indexOf("is PageMessageRoute.Forward -> when (route.message.optString(\"type\")) {")
        assertTrue(forward >= 0)
        val branch = code.substring(forward, code.indexOf("\n    }\n", forward))
        val consumed = Regex(
            """PageMessageRoute\.IMAGE_OWNER, PageMessageRoute\.IMAGE_THUMBNAIL ->\s*imageOwner\?\.onMessage\(route\.message, proxy, isMainFrame\)"""
        )
        assertTrue(consumed.containsMatchIn(branch))
        // The rest of the branch is what it was: share prepared, everything else forwarded.
        assertTrue(branch.contains("\"share\" -> host.preparePageMessage(route.message) { host.viewEvent(tabId, \"pageMessage\", it) }"))
        assertTrue(branch.contains("else -> host.viewEvent(tabId, \"pageMessage\", route.message)"))
        // No arm of the branch hands the two types to viewEvent.
        val arms = branch.split("\n").filter { it.contains("IMAGE_OWNER") || it.contains("IMAGE_THUMBNAIL") }
        assertTrue(arms.isNotEmpty())
        assertTrue(arms.none { it.contains("viewEvent") })
        // The verb, beside view.eval, hands the core the JSON text; a gone view answers null.
        val host = code(File(repoRoot(), "android/app/src/main/kotlin/app/zen/chromium/Host.kt"))
        val verb = host.indexOf("\"view.imageThumbnail\" ->")
        assertTrue(verb >= 0)
        assertTrue(verb > host.indexOf("\"view.eval\" ->"))
        val verbBody = host.substring(verb, host.indexOf("\"view.input\" ->", verb))
        assertTrue(verbBody.contains("if (tab == null) reply(null)"))
        assertTrue(verbBody.contains("tab.imageThumbnail("))
        assertTrue(verbBody.contains("{ reply(RawJson(it)) }"))
        // view.post and postForImageSearch are not this PR's.
        assertTrue(host.contains("\"view.post\" ->"))
        assertTrue(code.contains("fun postForImageSearch("))
        // The legacy bridge's word, decided where the features are.
        assertTrue(code.contains("val legacy = !WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER) ||"))
        assertTrue(code.contains("imageOwner().start(src, bounds, quality, maxBytes, replyProxy, legacy, reply)"))
    }

    private companion object {
        const val NONCE = "0123456789abcdef0123456789abcdef"
        const val URL = "https://example.com/a.png"
        const val HASH = "5008d908d5e08c6645f6aa651b540491afe63dde85ea320e6774c2808abbd885"
        const val MAX_BYTES = 20_971_520L
        val BOUNDS: JSONObject get() = json("maxSide" to 1000, "minArea" to 90_000)

        fun bytes(hex: String): ByteArray = ByteArray(hex.length / 2) { hex.substring(it * 2, it * 2 + 2).toInt(16).toByte() }

        fun hex(bytes: ByteArray): String = bytes.joinToString("") { "%02x".format(it.toInt() and 0xff) }

        /** A frame's hash of some other URL it holds, for the live nonce. */
        fun other(url: String): String = ImageOwner.hashFor(NONCE, url)

        fun failure(reason: String): String = json("ok" to false, "reason" to reason).toString()

        fun okResult(base64: String): JSONObject = json(
            "ok" to true,
            "thumbnail" to json(
                "base64" to base64, "contentType" to "image/jpeg", "width" to 600, "height" to 400,
                "originalWidth" to 1200, "originalHeight" to 800
            )
        )

        /** The file's code – block comments and comment lines out, as `LockVeilTest` reads a source. */
        fun code(file: File): String =
            file.readText().replace(Regex("""/\*[\s\S]*?\*/"""), "").lines().filterNot { it.trim().startsWith("//") }.joinToString("\n")

        fun repoRoot(): File {
            var dir: File? = File(System.getProperty("user.dir") ?: ".").absoluteFile
            while (dir != null) {
                if (File(dir, "package.json").isFile && File(dir, "android").isDirectory) return dir
                dir = dir.parentFile
            }
            error("not inside the repository")
        }
    }
}
