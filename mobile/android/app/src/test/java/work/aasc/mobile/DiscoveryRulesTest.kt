package work.aasc.mobile

import org.junit.Assert.assertEquals
import org.junit.Test

class DiscoveryRulesTest {
    @Test
    fun browsesForTheServiceTheMacAdvertises() {
        assertEquals("_aasc._tcp.", DiscoveryRules.SERVICE_TYPE)
    }

    @Test
    fun theBrowseWindowStaysBetweenHalfASecondAndFive() {
        assertEquals(2_000L, DiscoveryRules.browseMs(null))
        assertEquals(2_000L, DiscoveryRules.browseMs(2_000))
        assertEquals(500L, DiscoveryRules.browseMs(0))
        assertEquals(500L, DiscoveryRules.browseMs(-1))
        assertEquals(5_000L, DiscoveryRules.browseMs(600_000))
    }

    @Test
    fun keepsEachAddressOnceWithARealPort() {
        val kept = DiscoveryRules.keep(
            listOf(
                FoundMac("192.168.1.57", 3333),
                FoundMac("192.168.1.57", 3333),
                FoundMac("", 3333),
                FoundMac("192.168.1.9", 0),
                FoundMac("192.168.1.9", 70_000),
                FoundMac("10.0.0.7", 3334),
            ),
        )
        assertEquals(listOf(FoundMac("192.168.1.57", 3333), FoundMac("10.0.0.7", 3334)), kept)
    }

    @Test
    fun boundsHowManyComeBack() {
        val many = (1..100).map { FoundMac("192.168.1.$it", 3333) }
        assertEquals(DiscoveryRules.MAX_SERVICES * 2, DiscoveryRules.keep(many).size)
    }
}
