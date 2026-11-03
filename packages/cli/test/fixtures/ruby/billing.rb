require 'net/http'
require_relative 'money'

module Billing
  # Charges the customer through the payment gateway.
  def self.charge(amount, currency = 'USD')
    validate(amount)
    Net::HTTP.post(URI('https://pay.example'), '{}')
    Money.format(amount, currency)
  end

  def self.validate(amount)
    raise ArgumentError, 'amount must be positive' if amount <= 0
  end

  class Service
    def run
      self.helper()
      Billing.charge(10, 'USD')
    end

    private

    def helper; end
  end
end
