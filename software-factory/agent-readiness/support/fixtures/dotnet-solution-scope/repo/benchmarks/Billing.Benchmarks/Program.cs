using Billing;

var total = 0;
for (var day = 0; day < 1_000_000; day++)
{
    total += InvoiceCalculator.LateFee(day % 40);
}
Console.WriteLine(total);
