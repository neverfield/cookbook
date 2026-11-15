def bulk_discount(quantity):
    if quantity >= 10:
        return 15
    return 0


def shipping_band(weight_kg):
    if weight_kg > 20:
        return "freight"
    if weight_kg > 2:
        return "parcel"
    return "letter"


def is_member_price(code):
    if not code.startswith("M"):
        return False
    return len(code) == 5


def next_tier(points):
    return points // 100 + 1


def checked_quantity(quantity):
    if quantity < 1:
        raise ValueError("quantity must be at least 1")
    return quantity
