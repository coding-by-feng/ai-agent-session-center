package work.aasc.mobile

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class DictationRulesTest {
    private val mac = "http://192.168.1.20:3333"
    private val paired: (String) -> Boolean = { it == mac }

    @Test
    fun takesOnlyStartStopCancelWithACleanId() {
        assertEquals(DictationRules.Request("d1x-9", DictationRules.Action.START), DictationRules.request("""{"id":"d1x-9","action":"start"}"""))
        assertEquals(DictationRules.Action.STOP, DictationRules.request("""{"id":"d1","action":"stop"}""")?.action)
        assertEquals(DictationRules.Action.CANCEL, DictationRules.request("""{"id":"d1","action":"cancel"}""")?.action)
        assertNull(DictationRules.request("""{"id":"d1","action":"upload"}"""))
        assertNull(DictationRules.request("""{"id":"d1"}"""))
        assertNull(DictationRules.request("""{"action":"start"}"""))
        assertNull(DictationRules.request("""{"id":"a b","action":"start"}"""))
        assertNull(DictationRules.request("""{"id":"x');alert(1);//","action":"start"}"""))
        assertNull(DictationRules.request("""{"id":"${"a".repeat(65)}","action":"start"}"""))
        assertNull(DictationRules.request("""{"id":7,"action":"start"}"""))
        assertNull(DictationRules.request("start"))
        assertNull(DictationRules.request(null))
        assertNull(DictationRules.request("x".repeat(DictationRules.MESSAGE_MAX + 1)))
    }

    @Test
    fun aRefusedRequestStillHasItsId() {
        assertEquals("d1", DictationRules.postedId("""{"id":"d1","action":"upload"}"""))
        assertNull(DictationRules.postedId("""{"id":7}"""))
        assertNull(DictationRules.postedId("not json"))
    }

    @Test
    fun onlyAPairedMacsMainFrameThatIsShowingNow() {
        assertTrue(DictationRules.accepts(true, mac, "$mac/?m=/sessions/s1", paired))
        assertFalse("a frame inside the page", DictationRules.accepts(false, mac, "$mac/", paired))
        assertFalse("the bundled shell", DictationRules.accepts(true, "https://localhost", "https://localhost/", paired))
        assertFalse("an origin that is not a Mac's", DictationRules.accepts(true, "https://evil.example", "https://evil.example/", { true }))
        assertFalse("a Mac this phone is not paired with", DictationRules.accepts(true, "http://192.168.1.21:3333", "http://192.168.1.21:3333/", paired))
        assertFalse("the WebView has moved on", DictationRules.accepts(true, mac, "https://localhost/?reauth=1", paired))
        assertFalse(DictationRules.accepts(true, null, "$mac/", paired))
        assertFalse(DictationRules.accepts(true, mac, null, paired))
    }

    @Test
    fun aTapIsNotSpeechAndAClipHasACeiling() {
        assertTrue(DictationRules.longEnough(400))
        assertTrue(DictationRules.longEnough(30_000))
        assertFalse(DictationRules.longEnough(399))
        assertFalse(DictationRules.longEnough(-1))
        assertTrue(DictationRules.fits(1))
        assertTrue(DictationRules.fits(DictationRules.MAX_BYTES.toLong()))
        assertFalse(DictationRules.fits(0))
        assertFalse(DictationRules.fits(DictationRules.MAX_BYTES + 1L))
    }

    @Test
    fun aRecordingStartsOnlyOnAFingerJustPutDown() {
        // A page's script alone can't turn the microphone on.
        assertTrue(DictationRules.touched(100_000L, 100_050L))
        assertTrue(DictationRules.touched(100_000L, 100_000L + DictationRules.TOUCH_GRACE_MS))
        assertFalse(DictationRules.touched(100_000L, 102_000L))
        assertFalse(DictationRules.touched(null, 100_000L))
        assertFalse("a clock that ran backwards", DictationRules.touched(100_000L, 99_000L))
    }

    @Test
    fun anOutcomeIsJson() {
        val audio = JSONObject(DictationRules.outcome("d1", "audio", mapOf("audio" to "QUJD", "mime" to "audio/mp4", "ms" to 1500L)))
        assertEquals("d1", audio.getString("id"))
        assertEquals("audio", audio.getString("state"))
        assertEquals("QUJD", audio.getString("audio"))
        assertEquals(1500L, audio.getLong("ms"))
        val asked = JSONObject(DictationRules.outcome("d1", "permission", mapOf("granted" to true)))
        assertTrue(asked.getBoolean("granted"))
        val hostile = "x\"} </script>"
        assertEquals(hostile, JSONObject(DictationRules.outcome("d1", "failed", mapOf("message" to hostile))).getString("message"))
        // A field may not replace the id or the state.
        val pinned = JSONObject(DictationRules.outcome("d1", "failed", mapOf("id" to "other", "state" to "audio")))
        assertEquals("d1", pinned.getString("id"))
        assertEquals("failed", pinned.getString("state"))
    }
}
