<?php

declare(strict_types=1);

namespace Shop\Tests;

use Shop\Cart;

final class CartTest extends TestCase
{
    public function testSubtotalAddsLines(): void
    {
        $cart = new Cart();
        $cart->add('tea', 450, 2);
        $cart->add('mug', 1200);
        $cart->add('tea', 450);
        $this->assertSame(2550, $cart->subtotal());
    }

    public function testQuantityMustBePositive(): void
    {
        $this->assertThrows(\InvalidArgumentException::class, fn () => (new Cart())->add('tea', 450, 0));
        $cart = new Cart();
        $cart->add('tea', 450, 1);
        $this->assertSame(450, $cart->subtotal());
    }

    public function testShippingIsFreeFromTheThreshold(): void
    {
        $cart = new Cart();
        $cart->add('kettle', 4999);
        $this->assertSame(499, $cart->shipping());
        $cart->add('spoon', 1);
        $this->assertSame(0, $cart->shipping());
    }

    public function testEmpty(): void
    {
        $cart = new Cart();
        $this->assertSame(true, $cart->isEmpty());
        $cart->add('tea', 450);
        $this->assertSame(false, $cart->isEmpty());
    }

    public function testReceipt(): void
    {
        $cart = new Cart();
        $cart->add('tea', 450);
        $this->assertSame("Subtotal: 450\nShipping over 5000 is free.", $cart->receipt());
    }
}
