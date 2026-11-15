<?php

declare(strict_types=1);

namespace Shop\Tests;

/**
 * The few assertions these tests use, so the fixture installs nothing from Packagist.
 */
abstract class TestCase
{
    public int $assertions = 0;

    protected function assertSame(mixed $expected, mixed $actual): void
    {
        $this->assertions++;
        if ($expected !== $actual) {
            throw new \AssertionError(sprintf('expected %s, got %s', var_export($expected, true), var_export($actual, true)));
        }
    }

    protected function assertThrows(string $class, callable $fn): void
    {
        $this->assertions++;
        try {
            $fn();
        } catch (\Throwable $e) {
            if ($e instanceof $class) {
                return;
            }
            throw new \AssertionError(sprintf('expected %s, got %s', $class, $e::class));
        }
        throw new \AssertionError(sprintf('expected %s, nothing was thrown', $class));
    }
}
