require "minitest/autorun"
require "loyalty"

class TierTest < Minitest::Test
  def test_tiers_at_their_bounds
    assert_equal "bronze", Loyalty::Tier.for(999)
    assert_equal "silver", Loyalty::Tier.for(1000)
    assert_equal "silver", Loyalty::Tier.for(4999)
    assert_equal "gold", Loyalty::Tier.for(5000)
  end

  def test_next_level
    assert_equal "silver", Loyalty::Tier.next_level("bronze")
    assert_equal "gold", Loyalty::Tier.next_level("silver")
    assert_nil Loyalty::Tier.next_level("gold")
  end

  def test_unknown_tier
    assert_raises(ArgumentError) { Loyalty::Tier.next_level("platinum") }
  end

  def test_summary
    assert_equal "1200 points, tier silver\nGold starts at 5000 points.\n", Loyalty::Tier.summary(1200)
  end
end
