namespace Ledger.Core
{
    public static class Balance
    {
        public static decimal Apply(decimal balance, decimal amount)
        {
            if (amount == 0m)
            {
                return balance;
            }
            return balance + amount;
        }
    }
}
