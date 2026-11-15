using Billing;
using Xunit;

namespace Billing.Tests;

public class InvoiceTests
{
    [Fact]
    public void LateFees()
    {
        Assert.Equal(0, Invoice.LateFeeCents(0));
        Assert.Equal(550, Invoice.LateFeeCents(1));
        Assert.Equal(2000, Invoice.LateFeeCents(30));
        Assert.Equal(2500, Invoice.LateFeeCents(31));
    }

    [Fact]
    public void Tax()
    {
        Assert.Equal(80, Invoice.TaxCents(1000, exempt: false));
        Assert.Equal(0, Invoice.TaxCents(1000, exempt: true));
        Assert.Throws<ArgumentOutOfRangeException>(() => Invoice.TaxCents(-1, exempt: false));
    }

    [Fact]
    public void Overdue()
    {
        Assert.False(Invoice.IsOverdue(0));
        Assert.True(Invoice.IsOverdue(1));
    }
}
