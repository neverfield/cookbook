<?php

declare(strict_types=1);

// Runs every test* method of every *Test class under tests/ and prints PHPUnit's summary line.
require __DIR__ . '/../vendor/autoload.php';

$tests = 0;
$assertions = 0;
$failures = [];
foreach (glob(__DIR__ . '/*Test.php') as $file) {
    $class = 'Shop\\Tests\\' . basename($file, '.php');
    foreach (get_class_methods($class) as $method) {
        if (!str_starts_with($method, 'test')) {
            continue;
        }
        $tests++;
        $case = new $class();
        try {
            $case->$method();
        } catch (\Throwable $e) {
            $failures[] = "$class::$method: {$e->getMessage()}";
        }
        $assertions += $case->assertions;
    }
}
foreach ($failures as $i => $failure) {
    echo ($i + 1) . ") $failure\n";
}
if ($failures) {
    printf("FAILURES!\nTests: %d, Assertions: %d, Failures: %d.\n", $tests, $assertions, count($failures));
    exit(1);
}
printf("OK (%d tests, %d assertions)\n", $tests, $assertions);
