package com.example.loyalty

/** Loyalty points for an order, and the tier a customer reaches. */
object Points {
    fun earned(amountCents: Int, member: Boolean): Int {
        if (amountCents <= 0) {
            return 0
        }
        val base = amountCents / 100
        return if (member) base * 2 else base
    }

    fun tier(points: Int): String {
        if (points >= 1000) {
            return "gold"
        }
        if (points >= 200) {
            return "silver"
        }
        return "bronze"
    }

    fun canRedeem(points: Int, costPoints: Int): Boolean {
        if (costPoints > points) {
            return false
        }
        return true
    }

    fun redeem(points: Int, costPoints: Int): Int {
        if (!canRedeem(points, costPoints)) {
            throw IllegalArgumentException("not enough points")
        }
        return points - costPoints
    }
}
