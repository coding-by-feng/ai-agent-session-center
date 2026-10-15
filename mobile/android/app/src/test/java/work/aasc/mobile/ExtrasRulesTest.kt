package work.aasc.mobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ExtrasRulesTest {
    @Test
    fun acceptsTheImageTypesTheMacTakes() {
        listOf("image/png", "image/jpeg", "IMAGE/WEBP", "image/gif").forEach { assertTrue(it, ShareRules.isAcceptedImage(it)) }
        listOf("image/svg+xml", "image/heic", "text/plain", null).forEach { assertFalse("$it", ShareRules.isAcceptedImage(it)) }
        assertTrue(ShareRules.needsJpeg("image/heic"))
        assertTrue(ShareRules.needsJpeg("image/HEIF"))
        assertFalse(ShareRules.needsJpeg("image/png"))
    }

    @Test
    fun anImageAtTheLimitStillFitsTheShellsDataUrlCap() {
        val base64 = 4 * ((ShareRules.MAX_IMAGE_BYTES + 2) / 3)
        assertTrue(base64 + "data:image/jpeg;base64,".length <= 2_900_000)
    }

    @Test
    fun namesLoseControlsAndPaths() {
        assertEquals("evilname.png", ShareRules.safeName("../evil\u0000/name.png".replace("..", ""), 0))
        assertEquals("shared-image-2", ShareRules.safeName("  ", 1))
        assertEquals(120, ShareRules.safeName("a".repeat(500), 0).length)
    }

    @Test
    fun textTooLongForAnyQueueIsNotCarried() {
        assertEquals("hi", ShareRules.carriedText("hi"))
        assertNull(ShareRules.carriedText("x".repeat(ShareRules.MAX_TEXT_CHARS + 1)))
        assertNull(ShareRules.carriedText(null))
    }

    @Test
    fun widgetReadsOnlyAV1ModelAndCleansItsLines() {
        val view = WidgetRules.parse(
            """{"v":1,"headline":"2 sessions need you","top":{"ref":"a","title":"Fix‮the build","label":"Needs approval"},"updatedAt":1760000000000}""",
        )
        assertEquals(WidgetView("2 sessions need you", "Fixthe build", "Needs approval", 1760000000000), view)
        assertEquals(null, WidgetRules.parse("""{"v":1,"headline":"Nothing needs you","top":null,"updatedAt":1}""")?.title)
        assertNull(WidgetRules.parse("""{"v":2,"headline":"x"}"""))
        assertNull(WidgetRules.parse("""{"v":1}"""))
        assertNull(WidgetRules.parse("not json"))
        assertNull(WidgetRules.parse("""{"v":1,"headline":"${"x".repeat(WidgetRules.MAX_CHARS)}"}"""))
        assertNull(WidgetRules.parse(null))
    }

    @Test
    fun promptTitleIsOneShortLine() {
        assertEquals("Unlock AASC", PromptRules.title(null))
        assertEquals("Confirm kill", PromptRules.title("Confirm\n kill".replace("\n", "")))
        assertEquals(60, PromptRules.title("y".repeat(200)).length)
    }
    @Test
    fun shareRefusesLinksIntoTheAppsOwnStorage() {
        // Another app can share content://work.aasc.mobile.fileprovider/...: AASC would read its own files.
        assertTrue(ShareRules.isOwnAuthority("work.aasc.mobile.fileprovider", "work.aasc.mobile"))
        assertTrue(ShareRules.isOwnAuthority("work.aasc.mobile", "work.aasc.mobile"))
        assertTrue(ShareRules.isOwnAuthority("WORK.AASC.MOBILE.fileprovider", "work.aasc.mobile"))
        assertTrue(ShareRules.isOwnAuthority(null, "work.aasc.mobile"))
        assertFalse(ShareRules.isOwnAuthority("com.google.android.apps.photos.contentprovider", "work.aasc.mobile"))
        assertFalse(ShareRules.isOwnAuthority("work.aasc.mobileother", "work.aasc.mobile"))
        // A user-info prefix can't hide our authority.
        assertTrue(ShareRules.isOwnAuthority("0@work.aasc.mobile.fileprovider", "work.aasc.mobile"))
    }
}

class LockRulesTest {
    private val shell = "https://localhost"
    private val on5 = """{"enabled":true,"relockAfterMinutes":5}"""
    private val mac = "http://100.101.102.103:3333/queue?session=abc"

    @Test
    fun readsTheShellsSettingsAndFallsBackToOff() {
        assertEquals(true to 5, LockRules.settings(on5))
        assertEquals(true to 5, LockRules.settings("""{"enabled":true,"relockAfterMinutes":7}"""))
        assertEquals(false to 5, LockRules.settings("""{"enabled":"yes"}"""))
        assertEquals(false to 5, LockRules.settings("garbage"))
        assertEquals(false to 5, LockRules.settings(null))
    }

    @Test
    fun sendsAMacPageBackToTheShellWithItsPathAfterTheGracePeriod() {
        val url = LockRules.resumeUrl(on5, shell, mac, pausedAt = 1_000, now = 1_000 + 6 * 60_000)
        assertEquals("https://localhost/?resume=1&away=1000&back=%2Fqueue%3Fsession%3Dabc", url)
    }

    @Test
    fun leavesThePageAloneWhenItCan() {
        assertNull(LockRules.resumeUrl(on5, shell, mac, pausedAt = 1_000, now = 1_000 + 60_000)) // within 5 min
        assertNull(LockRules.resumeUrl("""{"enabled":false}""", shell, mac, 1_000, 10_000_000))
        assertNull(LockRules.resumeUrl(on5, shell, "https://localhost/?x=1", 1_000, 10_000_000)) // the shell decides itself
        assertNull(LockRules.resumeUrl(on5, shell, "https://evil.example/", 1_000, 10_000_000))
        assertNull(LockRules.resumeUrl(on5, shell, mac, pausedAt = 0, now = 10_000_000))
    }

    @Test
    fun aClockThatMovedBackAndEveryTimeAlwaysGoToTheShell() {
        assertTrue(LockRules.resumeUrl(on5, shell, mac, pausedAt = 10_000, now = 5_000) != null)
        val every = """{"enabled":true,"relockAfterMinutes":0}"""
        assertTrue(LockRules.resumeUrl(every, shell, mac, pausedAt = 1_000, now = 1_001) != null)
    }
}
