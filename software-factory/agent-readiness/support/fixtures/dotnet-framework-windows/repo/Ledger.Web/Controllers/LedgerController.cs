using System.Web.Mvc;
using Ledger.Core;

namespace Ledger.Web.Controllers
{
    public class LedgerController : Controller
    {
        public ActionResult Index(decimal balance, decimal amount)
        {
            return Content(Balance.Apply(balance, amount).ToString());
        }
    }
}
