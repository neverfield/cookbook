<?php

declare(strict_types=1);

namespace Shop;

/**
 * A percentage discount, capped so a total never goes below 1 cent.
 */
final class Discount
{
    public function __construct(private int $percent)
    {
        if ($this->percent > 100) {
            throw new \InvalidArgumentException('a discount is at most 100 percent');
        }
    }

    public function apply(int $total): int
    {
        $off = intdiv($total * $this->percent, 100);
        return max($total - $off, 1);
    }

    public function lastUnit(int $quantity): int
    {
        return $quantity - 1;
    }
}
