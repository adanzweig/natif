package com.benatif

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class HistoryTest {
    private fun turns(n: Int) = List(n) { i -> ChatMessage(if (i % 2 == 1) Role.ASSISTANT else Role.USER, i.toString()) }

    @Test fun `keeps everything under the limit`() = assertEquals(TrimmedHistory(turns(20), 0), trimHistory(turns(20), 20))

    @Test fun `drops in blocks so the prefix stays the same for several turns`() {
        val starts = listOf(22, 24, 26, 28).map { trimHistory(turns(it), 20).kept.first().content }
        assertEquals(1, starts.toSet().size)
        for (n in listOf(21, 25, 29, 33, 40, 57)) {
            val (kept, dropped) = trimHistory(turns(n), 20)
            assertTrue(kept.size <= 20)
            assertEquals(Role.USER, kept.first().role)
            assertEquals(n, dropped + kept.size)
        }
    }

    @Test fun `max 0 drops everything`() = assertEquals(TrimmedHistory(emptyList(), 3), trimHistory(turns(3), 0))
}
