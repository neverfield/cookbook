<?php

declare(strict_types=1);

namespace Shop\Tests;

use Shop\Discount;

final class DiscountTest extends TestCase
{
    public function testApplyTakesThePercentage(): void
    {
        $this->assertSame(900, (new Discount(10))->apply(1000));
        $this->assertSame(1000, (new Discount(0))->apply(1000));
    }

    public function testTotalNeverGoesBelowOneCent(): void
    {
        $this->assertSame(1, (new Discount(100))->apply(1000));
    }

    public function testAtMostOneHundredPercent(): void
    {
        $this->assertThrows(\InvalidArgumentException::class, fn () => new Discount(101));
        $this->assertSame(1, (new Discount(100))->apply(5));
    }

    public function testLastUnit(): void
    {
        $this->assertSame(2, (new Discount(5))->lastUnit(3));
    }
}
