require "minitest/autorun"
require "loyalty"

class PointsTest < Minitest::Test
  def test_one_point_per_whole_unit
    assert_equal 42, Loyalty::Points.earned(42.9)
  end

  def test_double_points_from_one_hundred
    assert_equal 99, Loyalty::Points.earned(99.5)
    assert_equal 200, Loyalty::Points.earned(100)
  end

  def test_negative_total_is_rejected
    assert_raises(ArgumentError) { Loyalty::Points.earned(-1) }
  end

  def test_redeem_takes_the_cost
    assert_equal 30, Loyalty::Points.redeem(50, 20)
    assert_equal 1, Loyalty::Points.redeem(21, 20)
  end

  def test_redeem_never_goes_below_zero
    assert_equal 0, Loyalty::Points.redeem(20, 20)
    assert_equal 0, Loyalty::Points.redeem(10, 20)
  end

  def test_redeemable
    assert Loyalty::Points.redeemable?(20, 20)
    refute Loyalty::Points.redeemable?(19, 20)
  end
end
