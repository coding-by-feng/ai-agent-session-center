package work.aasc.mobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** The floating call (Nov 22 2026): mirrors the CallLayerRules checks in ios/RulesTests/main.swift. */
class CallLayerRulesTest {
    @Test
    fun theBubbleShowsOnlyAShortClockOrWord() {
        assertEquals("3:12", CallLayerRules.label("3:12"))
        assertEquals("Paused", CallLayerRules.label("Paused"))
        assertEquals("125:07", CallLayerRules.label("125:07"))
        assertEquals("Call", CallLayerRules.label(null))
        assertEquals("Call", CallLayerRules.label("  "))
        assertEquals("Call", CallLayerRules.label("<b>hi</b>"))
        assertEquals("Call", CallLayerRules.label("a\nb"))
        assertEquals("Call", CallLayerRules.label("1".repeat(13)))
    }

    @Test
    fun statesAndAnythingElseIsLive() {
        assertEquals(CallLayerRules.BubbleState.PAUSED, CallLayerRules.state("paused"))
        assertEquals(CallLayerRules.BubbleState.MUTED, CallLayerRules.state("muted"))
        assertEquals(CallLayerRules.BubbleState.LIVE, CallLayerRules.state("live"))
        assertEquals(CallLayerRules.BubbleState.LIVE, CallLayerRules.state(null))
        assertEquals(CallLayerRules.BubbleState.LIVE, CallLayerRules.state("x"))
    }

    @Test
    fun onlyAPairedMacShapedPageOpens() {
        assertEquals("http://192.168.1.20:3333", CallLayerRules.pageOrigin("http://192.168.1.20:3333/?session=a"))
        assertEquals("http://100.101.102.103:3333", CallLayerRules.pageOrigin("http://100.101.102.103:3333/more"))
        assertNull(CallLayerRules.pageOrigin("https://192.168.1.20:3333/"))
        assertNull(CallLayerRules.pageOrigin("http://example.com:3333/"))
        assertNull(CallLayerRules.pageOrigin("http://8.8.8.8:3333/"))
        assertNull(CallLayerRules.pageOrigin("http://user@192.168.1.20:3333/"))
        assertNull(CallLayerRules.pageOrigin("https://localhost/?call=1"))
        assertNull(CallLayerRules.pageOrigin(null))
    }
}
