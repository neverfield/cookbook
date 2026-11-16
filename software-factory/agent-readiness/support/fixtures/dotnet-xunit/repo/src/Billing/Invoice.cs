namespace Billing;

/// <summary>Late fees and tax on an invoice.</summary>
public static class Invoice
{
    public static int LateFeeCents(int daysLate)
    {
        if (daysLate <= 0)
        {
            return 0;
        }
        if (daysLate > 30)
        {
            return 2500;
        }
        return 500 + daysLate * 50;
    }

    public static int TaxCents(int netCents, bool exempt)
    {
        if (netCents < 0)
        {
            throw new ArgumentOutOfRangeException(nameof(netCents));
        }
        if (exempt)
        {
            return 0;
        }
        return netCents * 8 / 100;
    }

    public static bool IsOverdue(int daysLate)
    {
        if (daysLate >= 1)
        {
            return true;
        }
        return false;
    }
}
