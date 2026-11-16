<?php

declare(strict_types=1);

namespace Shop;

/**
 * A cart's lines and its total, in cents. Shipping is free from 5000 cents.
 */
final class Cart
{
    public const FREE_SHIPPING_FROM = 5000;
    private const SHIPPING = 499;

    /** @var array<string, array{price: int, quantity: int}> */
    private array $lines = [];

    public function add(string $sku, int $price, int $quantity = 1): void
    {
        if ($quantity < 1) {
            throw new \InvalidArgumentException("quantity must be at least 1");
        }
        $this->lines[$sku] = ['price' => $price, 'quantity' => ($this->lines[$sku]['quantity'] ?? 0) + $quantity];
    }

    public function subtotal(): int
    {
        $sum = 0;
        foreach ($this->lines as $line) {
            $sum += $line['price'] * $line['quantity'];
        }
        return $sum;
    }

    public function shipping(): int
    {
        # Free shipping applies from the threshold itself.
        if ($this->subtotal() >= self::FREE_SHIPPING_FROM) {
            return 0;
        }
        return self::SHIPPING;
    }

    public function isEmpty(): bool
    {
        if (count($this->lines) > 0) {
            return false;
        }
        return true;
    }

    public function receipt(): string
    {
        return <<<TEXT
            Subtotal: {$this->subtotal()}
            Shipping over 5000 is free.
            TEXT;
    }
}
