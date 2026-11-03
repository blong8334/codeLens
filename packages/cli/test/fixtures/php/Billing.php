<?php

namespace Acme\Billing;

use GuzzleHttp\Client;
use Acme\Billing\Util\Money;

class Billing
{
    /** Charges the customer through the payment gateway. */
    public function charge(int $amount, string $currency = 'USD'): string
    {
        $this->validate($amount);
        $client = new Client();
        $client->post('https://pay.example');
        return Money::format($amount, $currency);
    }

    private function validate(int $amount): void
    {
        if ($amount <= 0) {
            throw new \InvalidArgumentException('amount must be positive');
        }
    }
}

function run_billing(): void
{
    (new Billing())->charge(10);
}
