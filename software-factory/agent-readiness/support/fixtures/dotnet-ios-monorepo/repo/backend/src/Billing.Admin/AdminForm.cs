namespace Billing.Admin;

public class AdminForm : Form
{
    public AdminForm()
    {
        Text = $"Late fee for 3 days: {Invoice.LateFeeCents(3)}";
    }
}
