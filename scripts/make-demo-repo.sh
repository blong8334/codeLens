#!/usr/bin/env bash
# Builds examples/demo-shop: a small repo with a base commit and a risky follow-up commit.
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)/examples/demo-shop"
rm -rf "$DIR" && mkdir -p "$DIR/src/api" "$DIR/src/services" "$DIR/src/lib" "$DIR/src/reports" "$DIR/worker"
cd "$DIR"
git init -q -b main
git config user.email demo@codelens.dev && git config user.name "CodeLens Demo"

cat > src/lib/money.ts <<'EOF'
export interface Money { cents: number; currency: string }

export function parseMoney(input: string): Money {
  const [amount, currency = 'USD'] = input.trim().split(' ');
  return { cents: Math.round(parseFloat(amount) * 100), currency };
}

export function formatMoney(m: Money): string {
  return `${(m.cents / 100).toFixed(2)} ${m.currency}`;
}
EOF

cat > src/services/payments.ts <<'EOF'
import { Money } from '../lib/money';

/** Charges the customer's card on file through the payment gateway. */
export async function chargeCard(customerId: string, amount: Money): Promise<string> {
  if (!customerId) throw new Error('customerId required');
  if (amount.cents <= 0) throw new Error('amount must be positive');
  return `ch_${customerId}_${amount.cents}`;
}

export async function refund(chargeId: string): Promise<void> {
  await gateway.post('/refunds', { chargeId });
}

const gateway = { post: async (_path: string, _body: unknown) => ({}) };
EOF

cat > src/services/inventory.ts <<'EOF'
const stock = new Map<string, number>();

// Holds inventory for an order so it cannot be sold twice.
export function reserveStock(sku: string, qty: number): boolean {
  if (!sku) return false;
  const available = stock.get(sku) ?? 0;
  if (qty > available) return false;
  stock.set(sku, available - qty);
  return true;
}

export function releaseStock(sku: string, qty: number): void {
  stock.set(sku, (stock.get(sku) ?? 0) + qty);
}
EOF

cat > src/services/orders.ts <<'EOF'
import { chargeCard, refund } from './payments';
import { reserveStock, releaseStock } from './inventory';
import { parseMoney, Money } from '../lib/money';
import { sendReceipt } from './notifications';

export interface Order { id: string; customerId: string; sku: string; qty: number; price: string }

export async function placeOrder(order: Order): Promise<string> {
  validateOrder(order);
  if (!reserveStock(order.sku, order.qty)) throw new Error('out of stock');
  try {
    const chargeId = await chargeCard(order.customerId, totalFor(order));
    await sendReceipt(order.customerId, chargeId);
    return chargeId;
  } catch (err) {
    releaseStock(order.sku, order.qty);
    throw err;
  }
}

export async function cancelOrder(order: Order, chargeId: string): Promise<void> {
  await refund(chargeId);
  releaseStock(order.sku, order.qty);
}

function totalFor(order: Order): Money {
  const unit = parseMoney(order.price);
  return { ...unit, cents: unit.cents * order.qty - legacyDiscount(unit) };
}

function legacyDiscount(unit: Money): number {
  return unit.cents > 10000 ? 500 : 0;
}

function validateOrder(order: Order): void {
  if (order.qty <= 0) throw new Error('qty must be positive');
}
EOF

cat > src/api/routes.ts <<'EOF'
import { placeOrder, cancelOrder, Order } from '../services/orders';
import { formatMoney, parseMoney } from '../lib/money';

export async function handleCheckout(req: { body: Order }) {
  const chargeId = await placeOrder(req.body);
  return { status: 201, chargeId, total: formatMoney(parseMoney(req.body.price)) };
}

export async function handleCancel(req: { body: { order: Order; chargeId: string } }) {
  await cancelOrder(req.body.order, req.body.chargeId);
  return { status: 204 };
}

export async function handleQuote(req: { query: { price: string } }) {
  return { status: 200, quote: formatMoney(parseMoney(req.query.price)) };
}
EOF

cat > worker/reconcile.py <<'EOF'
from .celery_app import app
from .ledger import fetch_charges


@app.task
def reconcile(day, tolerance=0):
    """Nightly job: checks that recorded charges add up to the expected daily total."""
    charges = fetch_charges(day)
    total = sum(c["cents"] for c in charges)
    return {"day": day, "total": total, "ok": abs(total - expected(day)) <= tolerance}


def expected(day):
    return 0
EOF
cat > worker/ledger.py <<'EOF'
import requests


def fetch_charges(day):
    if day is None:
        raise ValueError("day required")
    return requests.get("https://ledger.internal/charges", params={"day": day}).json()
EOF

cat > src/services/notifications.ts <<'EOF'
/** Emails the customer a receipt for a completed charge. */
export async function sendReceipt(customerId: string, chargeId: string): Promise<void> {
  await fetch('https://mail.internal/receipts', { method: 'POST', body: JSON.stringify({ customerId, chargeId }) });
}
EOF

cat > src/lib/db.ts <<'EOF'
import { Pool } from 'pg';

const pool = new Pool();

export async function query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  const res = await pool.query(sql, params);
  return res.rows as T[];
}
EOF

cat > src/reports/revenue.ts <<'EOF'
import { query } from '../lib/db';
import { parseMoney, formatMoney } from '../lib/money';

export async function revenueByDay(day: string): Promise<string> {
  const rows = await query<{ price: string }>('select price from orders where day = $1', [day]);
  return formatMoney({ cents: sumPrices(rows.map((r) => r.price)), currency: 'USD' });
}

function sumPrices(prices: string[]): number {
  return prices.reduce((total, p) => total + parseMoney(p).cents, 0);
}
EOF

cat > src/api/admin.ts <<'EOF'
import { cancelOrder, Order } from '../services/orders';
import { releaseStock } from '../services/inventory';
import { parseMoney, formatMoney } from '../lib/money';
import { revenueByDay } from '../reports/revenue';
import { query } from '../lib/db';

export async function handleRefund(req: { body: { order: Order; chargeId: string } }) {
  await cancelOrder(req.body.order, req.body.chargeId);
  return { status: 200 };
}

export async function handleAdjustPrice(req: { body: { sku: string; price: string } }) {
  const price = parseMoney(req.body.price);
  await query('update prices set cents = $1 where sku = $2', [price.cents, req.body.sku]);
  return { status: 200, price: formatMoney(price) };
}

export async function handleBulkQuote(req: { body: { prices: string[] } }) {
  return { status: 200, quotes: req.body.prices.map((p) => formatMoney(parseMoney(p))) };
}

export async function handlePriceImport(req: { body: { rows: { sku: string; price: string }[] } }) {
  for (const row of req.body.rows) {
    await query('insert into prices values ($1, $2)', [row.sku, parseMoney(row.price).cents]);
  }
  return { status: 201 };
}

export async function handleRevenueReport(req: { query: { day: string } }) {
  return { status: 200, revenue: await revenueByDay(req.query.day) };
}

export async function handleInventoryAudit(req: { body: { sku: string; qty: number } }) {
  releaseStock(req.body.sku, req.body.qty);
  return { status: 204 };
}

export async function handleConvert(req: { query: { amount: string } }) {
  return { status: 200, converted: formatMoney(parseMoney(req.query.amount)) };
}
EOF

cat > src/services/orders.test.ts <<'EOF'
import { placeOrder } from './orders';

export async function testPlaceOrderCharges() {
  const id = await placeOrder({ id: 'o1', customerId: 'c1', sku: 'sku1', qty: 1, price: '10.00 USD' });
  if (!id.startsWith('ch_')) throw new Error('expected a charge id');
}

export async function testPlaceOrderRejectsZeroQty() {
  await placeOrder({ id: 'o2', customerId: 'c1', sku: 'sku1', qty: 0, price: '10.00 USD' }).then(
    () => { throw new Error('expected rejection'); },
    () => undefined,
  );
}
EOF

cat > worker/celery_app.py <<'EOF'
class _App:
    def task(self, fn):
        return fn


app = _App()
EOF

cat > .codelens.json <<'EOF'
{
  "systems": {
    "Payments": ["src/services/payments.ts", "src/lib/money.ts"]
  }
}
EOF

git add -A && git commit -qm "Initial shop service"

# ---- The change under review ----
cat > src/lib/money.ts <<'EOF'
export interface Money { cents: number; currency: string }

export function parseMoney(input: string, defaultCurrency: string): Money {
  const [amount, currency = defaultCurrency] = input.trim().split(' ');
  const value = parseFloat(amount);
  if (Number.isNaN(value)) throw new Error(`invalid amount: ${input}`);
  return { cents: Math.round(value * 100), currency };
}

export function formatMoney(m: Money): string {
  return `${(m.cents / 100).toFixed(2)} ${m.currency}`;
}
EOF

cat > src/services/payments.ts <<'EOF'
import { Money } from '../lib/money';

/** Charges the customer's card on file through the payment gateway. */
export async function chargeCard(customerId: string, amount: Money, idempotencyKey: string): Promise<string> {
  if (amount.cents <= 0) throw new Error('amount must be positive');
  return `ch_${customerId}_${amount.cents}_${idempotencyKey}`;
}

export async function refund(chargeId: string): Promise<void> {
  await gateway.post('/refunds', { chargeId });
}

const gateway = { post: async (_path: string, _body: unknown) => ({}) };
EOF

cat > src/services/inventory.ts <<'EOF'
const stock = new Map<string, number>();

// Holds inventory for an order so it cannot be sold twice.
export function reserveStock(sku: string, qty: number): boolean {
  const available = stock.get(sku) ?? 0;
  stock.set(sku, available - qty);
  return true;
}

export function releaseStock(sku: string, qty: number): void {
  stock.set(sku, (stock.get(sku) ?? 0) + qty);
}
EOF

cat > src/services/orders.ts <<'EOF'
import { chargeCard, refund } from './payments';
import { reserveStock, releaseStock } from './inventory';
import { parseMoney, Money } from '../lib/money';
import { sendReceipt } from './notifications';

export interface Order { id: string; customerId: string; sku: string; qty: number; price: string }

export async function placeOrder(order: Order): Promise<string> {
  validateOrder(order);
  if (!reserveStock(order.sku, order.qty)) throw new Error('out of stock');
  try {
    const chargeId = await chargeCard(order.customerId, totalFor(order), order.id);
    await sendReceipt(order.customerId, chargeId);
    return chargeId;
  } catch (err) {
    releaseStock(order.sku, order.qty);
    throw err;
  }
}

export async function cancelOrder(order: Order, chargeId: string): Promise<void> {
  await refund(chargeId);
  releaseStock(order.sku, order.qty);
}

function totalFor(order: Order): Money {
  const unit = parseMoney(order.price, 'USD');
  return { ...unit, cents: unit.cents * order.qty - legacyDiscount(unit) };
}

function validateOrder(order: Order): void {
  if (order.qty <= 0) throw new Error('qty must be positive');
}
EOF

cat > worker/ledger.py <<'EOF'
import requests


def fetch_charges(day, currency):
    return requests.get("https://ledger.internal/charges", params={"day": day, "currency": currency}).json()
EOF

git add -A && git commit -qm "Add idempotency keys, explicit currency, simplify inventory"
echo "Demo repo ready at $DIR"
