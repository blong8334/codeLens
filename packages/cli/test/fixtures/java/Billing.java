package com.acme.billing;

import java.net.http.HttpClient;
import com.acme.billing.util.Money;

public class Billing {
    private final HttpClient client = HttpClient.newHttpClient();

    /** Charges the customer through the payment gateway. */
    public String charge(long amount, String currency) throws Exception {
        validate(amount);
        client.send(null, null);
        return Money.format(amount, currency);
    }

    private void validate(long amount) {
        if (amount <= 0) {
            throw new IllegalArgumentException("amount must be positive");
        }
    }

    public static class Service {
        public void run() {
            this.helper();
            new Billing().charge(10, "USD");
        }

        void helper() {}
    }

    @Test
    public void chargesPositiveAmounts() {
        charge(1, "USD");
    }
}
