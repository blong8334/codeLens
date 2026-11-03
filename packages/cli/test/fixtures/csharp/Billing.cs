using System.Net.Http;
using Acme.Billing.Util;

namespace Acme.Billing
{
    public class Billing
    {
        private readonly HttpClient client = new HttpClient();

        /// <summary>Charges the customer through the payment gateway.</summary>
        public async Task<string> Charge(long amount, string currency)
        {
            Validate(amount);
            await client.PostAsync("https://pay.example", null);
            return Money.Format(amount, currency);
        }

        private void Validate(long amount)
        {
            if (amount <= 0) throw new ArgumentException("amount must be positive");
        }

        [HttpGet("charge")]
        public void Run()
        {
            this.Helper();
        }

        void Helper() {}
    }
}
