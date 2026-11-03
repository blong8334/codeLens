package com.acme.billing

import java.net.http.HttpClient
import com.acme.billing.util.Money

/** Charges the customer through the payment gateway. */
fun charge(amount: Long, currency: String = "USD"): String {
    validate(amount)
    val client = HttpClient.newHttpClient()
    client.send(null, null)
    return Money.format(amount, currency)
}

private fun validate(amount: Long) {
    if (amount <= 0) throw IllegalArgumentException("amount must be positive")
}

class Service {
    suspend fun run() {
        this.helper()
        charge(10, "USD")
    }

    fun helper() {}
}
