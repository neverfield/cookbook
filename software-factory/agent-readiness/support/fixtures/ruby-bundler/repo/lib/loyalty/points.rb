module Loyalty
  # Points earned on an order: one per whole unit spent, doubled on orders of 100 or more.
  module Points
    DOUBLE_FROM = 100

    def self.earned(total)
      raise ArgumentError, "total can't be negative" if total.negative?

      points = total.floor
      points *= 2 if total >= DOUBLE_FROM
      points
    end

    # The points left after a redemption; a redemption never takes the balance below zero.
    def self.redeem(balance, cost)
      return 0 unless cost < balance

      balance - cost
    end

    def self.redeemable?(balance, cost)
      return false if cost > balance

      true
    end

=begin
Older accounts kept 10 bonus points; they were migrated in 2024 and need no code here.
=end
  end
end
