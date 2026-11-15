package com.example.loyalty

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class PointsTest {
    @Test
    fun earnedPoints() {
        assertEquals(0, Points.earned(0, member = true))
        assertEquals(1, Points.earned(100, member = false))
        assertEquals(4, Points.earned(250, member = true))
    }

    @Test
    fun tiers() {
        assertEquals("bronze", Points.tier(199))
        assertEquals("silver", Points.tier(200))
        assertEquals("silver", Points.tier(999))
        assertEquals("gold", Points.tier(1000))
    }

    @Test
    fun redeeming() {
        assertTrue(Points.canRedeem(50, 50))
        assertFalse(Points.canRedeem(49, 50))
        assertEquals(10, Points.redeem(60, 50))
        assertFailsWith<IllegalArgumentException> { Points.redeem(10, 50) }
    }
}
