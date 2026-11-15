package inventory

// Available is what can still be sold once reserved units are set aside.
func Available(onHand, reserved int) int {
	free := onHand - reserved
	if free < 0 {
		return 0
	}
	return free
}

// NeedsReorder says whether stock has fallen to the reorder point.
func NeedsReorder(onHand, reorderAt int) bool {
	if onHand <= reorderAt {
		return true
	}
	return false
}

// Restock is the order that brings stock back up to target, in whole cases.
func Restock(onHand, target, caseSize int) int {
	short := target - onHand
	if short <= 0 {
		return 0
	}
	return (short + caseSize - 1) / caseSize * caseSize
}
