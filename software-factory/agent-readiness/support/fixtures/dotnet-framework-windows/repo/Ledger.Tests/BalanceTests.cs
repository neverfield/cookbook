using Ledger.Core;
using Microsoft.VisualStudio.TestTools.UnitTesting;

namespace Ledger.Tests
{
    [TestClass]
    public class BalanceTests
    {
        [TestMethod]
        public void ZeroLeavesBalance()
        {
            Assert.AreEqual(10m, Balance.Apply(10m, 0m));
        }

        [TestMethod]
        public void AddsAmount()
        {
            Assert.AreEqual(15m, Balance.Apply(10m, 5m));
        }
    }
}
