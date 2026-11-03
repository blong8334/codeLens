import axios from 'axios';
import { format } from './money';

/** Charges the customer through the payment gateway. */
export async function charge(amount: number, currency = 'USD'): Promise<string> {
  validate(amount);
  await axios.post('https://pay.example', { amount });
  return format(amount, currency);
}

function validate(amount: number): void {
  if (amount <= 0) throw new Error('amount must be positive');
}

export class Service {
  run() {
    this.helper();
    [1, 2].forEach((n) => charge(n));
  }

  helper() {}
}
