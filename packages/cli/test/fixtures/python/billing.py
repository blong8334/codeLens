import requests
from .money import format_money


def charge(amount, currency="USD"):
    """Charges the customer through the payment gateway."""
    validate(amount)
    requests.post("https://pay.example", json={"amount": amount})
    return format_money(amount, currency)


def _validate(amount):
    if amount <= 0:
        raise ValueError("amount must be positive")


validate = _validate


class Service:
    def run(self):
        self.helper()
        charge(10)

    def helper(self):
        pass
