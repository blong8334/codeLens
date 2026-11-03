package com.acme.billing

import java.net.http.HttpClient
import com.acme.billing.util.Money

object Billing {
  /** Charges the customer through the payment gateway. */
  def charge(amount: Long, currency: String): String = {
    validate(amount)
    val client = HttpClient.newHttpClient()
    client.send(null, null)
    Money.format(amount, currency)
  }

  private def validate(amount: Long): Unit = {
    if (amount <= 0) throw new IllegalArgumentException("amount must be positive")
  }
}

class Service {
  def run(): Unit = {
    this.helper()
    Billing.charge(10, "USD")
  }

  def helper(): Unit = {}
}
