// Per-language extraction tests. Every fixture models the same small program:
//   charge(amount, currency)  — documented, public; calls validate(), an HTTP client, and a formatter
//   validate(amount)          — private; throws on bad input
//   Service.run()             — calls its sibling helper() through this/self, then charge()
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { LANGUAGES } from '../src/lang/index.ts';
import { parseFile, type ExtractedFile, type ExtractedFn } from '../src/parse.ts';

interface Case {
  file: string;
  /** Qualified names that must be extracted. */
  fns: string[];
  charge: string;
  validate: string;
  run: string;
  params: string[];
  /** Calls `charge` must make, written as `receiver.name` or `name`. */
  chargeCalls: string[];
  /** How `run` calls its sibling. */
  selfCall: string;
  /** Local import name → module, if the language binds names. */
  imports?: Record<string, string>;
  validateExported?: boolean;
}

const CASES: Record<string, Case> = {
  typescript: {
    file: 'typescript/billing.ts',
    fns: ['charge', 'validate', 'Service.run', 'Service.helper'],
    charge: 'charge', validate: 'validate', run: 'Service.run',
    params: ['amount', 'currency'],
    chargeCalls: ['validate', 'axios.post', 'format'],
    selfCall: 'this.helper',
    imports: { axios: 'axios', format: './money' },
    validateExported: false,
  },
  python: {
    file: 'python/billing.py',
    fns: ['charge', '_validate', 'Service.run', 'Service.helper'],
    charge: 'charge', validate: '_validate', run: 'Service.run',
    params: ['amount', 'currency'],
    chargeCalls: ['validate', 'requests.post', 'format_money'],
    selfCall: 'self.helper',
    imports: { requests: 'requests', format_money: '.money' },
    validateExported: false,
  },
  java: {
    file: 'java/Billing.java',
    fns: ['Billing.charge', 'Billing.validate', 'Billing.Service.run', 'Billing.Service.helper', 'Billing.chargesPositiveAmounts'],
    charge: 'Billing.charge', validate: 'Billing.validate', run: 'Billing.Service.run',
    params: ['amount', 'currency'],
    chargeCalls: ['validate', 'client.send', 'Money.format'],
    selfCall: 'this.helper',
    imports: { HttpClient: 'java.net.http.HttpClient', Money: 'com.acme.billing.util.Money' },
    validateExported: false,
  },
  kotlin: {
    file: 'kotlin/Billing.kt',
    fns: ['charge', 'validate', 'Service.run', 'Service.helper'],
    charge: 'charge', validate: 'validate', run: 'Service.run',
    params: ['amount', 'currency'],
    chargeCalls: ['validate', 'client.send', 'Money.format'],
    selfCall: 'this.helper',
    imports: { HttpClient: 'java.net.http.HttpClient', Money: 'com.acme.billing.util.Money' },
    validateExported: false,
  },
  scala: {
    file: 'scala/Billing.scala',
    fns: ['Billing.charge', 'Billing.validate', 'Service.run', 'Service.helper'],
    charge: 'Billing.charge', validate: 'Billing.validate', run: 'Service.run',
    params: ['amount', 'currency'],
    chargeCalls: ['validate', 'client.send', 'Money.format'],
    selfCall: 'this.helper',
    imports: { HttpClient: 'java.net.http.HttpClient', Money: 'com.acme.billing.util.Money' },
    validateExported: false,
  },
  csharp: {
    file: 'csharp/Billing.cs',
    fns: ['Billing.Charge', 'Billing.Validate', 'Billing.Run', 'Billing.Helper'],
    charge: 'Billing.Charge', validate: 'Billing.Validate', run: 'Billing.Run',
    params: ['amount', 'currency'],
    chargeCalls: ['Validate', 'client.PostAsync', 'Money.Format'],
    selfCall: 'this.Helper',
    validateExported: false,
  },
  go: {
    file: 'go/billing.go',
    fns: ['Charge', 'validate', 'Service.Run', 'Service.helper', 'HandleCharge'],
    charge: 'Charge', validate: 'validate', run: 'Service.Run',
    params: ['amount', 'currency'],
    chargeCalls: ['validate', 'http.Post', 'money.Format'],
    selfCall: 's.helper',
    imports: { http: 'net/http', money: 'github.com/acme/shop/money' },
    validateExported: false,
  },
  rust: {
    file: 'rust/billing.rs',
    fns: ['charge', 'validate', 'Service.run', 'Service.helper', 'charges_positive_amounts'],
    charge: 'charge', validate: 'validate', run: 'Service.run',
    params: ['amount', 'currency'],
    chargeCalls: ['validate', 'client.post', 'fs.write', 'format'],
    selfCall: 'self.helper',
    imports: { fs: 'std::fs', format: 'crate::money::format' },
    validateExported: false,
  },
  c: {
    file: 'c/billing.c',
    fns: ['charge', 'validate', 'main'],
    charge: 'charge', validate: 'validate', run: 'main',
    params: ['amount', 'currency'],
    chargeCalls: ['validate', 'curl_easy_perform', 'fopen', 'format_money'],
    selfCall: 'charge',
    validateExported: false,
  },
  cpp: {
    file: 'cpp/billing.cpp',
    fns: ['billing.charge', 'billing.validate', 'billing.Service.run', 'billing.Service.helper', 'billing.Service.reset'],
    charge: 'billing.charge', validate: 'billing.validate', run: 'billing.Service.run',
    params: ['amount', 'currency'],
    chargeCalls: ['validate', 'money.format'],
    selfCall: 'this.helper',
  },
  swift: {
    file: 'swift/Billing.swift',
    fns: ['charge', 'validate', 'Service.run', 'Service.helper'],
    charge: 'charge', validate: 'validate', run: 'Service.run',
    params: ['amount', 'currency'],
    chargeCalls: ['validate', 'URLSession.shared.dataTask', 'format'],
    selfCall: 'self.helper',
  },
  ruby: {
    file: 'ruby/billing.rb',
    fns: ['Billing.charge', 'Billing.validate', 'Billing.Service.run', 'Billing.Service.helper'],
    charge: 'Billing.charge', validate: 'Billing.validate', run: 'Billing.Service.run',
    params: ['amount', 'currency'],
    chargeCalls: ['validate', 'Net::HTTP.post', 'Money.format'],
    selfCall: 'self.helper',
  },
  php: {
    file: 'php/Billing.php',
    fns: ['Billing.charge', 'Billing.validate', 'run_billing'],
    charge: 'Billing.charge', validate: 'Billing.validate', run: 'Billing.charge',
    params: ['amount', 'currency'],
    chargeCalls: ['$this.validate', '$client.post', 'Money.format'],
    selfCall: '$this.validate',
    imports: { Client: 'GuzzleHttp\\Client', Money: 'Acme\\Billing\\Util\\Money' },
    validateExported: false,
  },
};

const callText = (fn: ExtractedFn) => fn.calls.map((c) => (c.object ? `${c.object}.${c.name}` : c.name));

async function load(c: Case): Promise<ExtractedFile> {
  const path = new URL(`./fixtures/${c.file}`, import.meta.url);
  const file = await parseFile(c.file, readFileSync(path, 'utf8'));
  assert.ok(file, `${c.file} should be claimed by a language`);
  return file;
}

test('every registered language has a fixture case', () => {
  const covered = new Set(Object.keys(CASES));
  const missing = LANGUAGES.map((l) => l.id).filter((id) => !covered.has(id) && id !== 'javascript' && id !== 'tsx');
  assert.deepEqual(missing, [], `add a fixture + CASES entry for: ${missing.join(', ')}`);
});

for (const [lang, c] of Object.entries(CASES)) {
  test(`${lang}: extracts functions, calls, docs and imports`, async () => {
    const file = await load(c);
    assert.equal(file.language, lang);
    const byName = new Map(file.functions.map((f) => [f.qualifiedName, f]));
    for (const name of c.fns) assert.ok(byName.has(name), `missing ${name}; got ${[...byName.keys()].join(', ')}`);

    const charge = byName.get(c.charge)!;
    assert.deepEqual(charge.signature.params.map((p) => p.name), c.params, 'charge params');
    assert.match(charge.doc ?? '', /charges the customer through the payment gateway/i, 'charge doc comment');
    assert.equal(charge.exported, true, 'charge is public');
    for (const call of c.chargeCalls) assert.ok(callText(charge).includes(call), `charge should call ${call}; got ${callText(charge).join(' ')}`);

    const validate = byName.get(c.validate)!;
    if (c.validateExported !== undefined) assert.equal(validate.exported, c.validateExported, 'validate visibility');
    if (lang !== 'c') assert.ok(validate.throws.length > 0, 'validate throws');

    assert.ok(callText(byName.get(c.run)!).includes(c.selfCall), `${c.run} should call ${c.selfCall}`);
    for (const [local, source] of Object.entries(c.imports ?? {})) assert.equal(file.importNames[local], source, `import ${local}`);
  });
}

test('typescript: calls inside anonymous callbacks belong to the enclosing function', async () => {
  const file = await load(CASES.typescript);
  const run = file.functions.find((f) => f.qualifiedName === 'Service.run')!;
  assert.ok(callText(run).includes('charge'));
});

test('go: methods carry their receiver variable and type', async () => {
  const file = await load(CASES.go);
  const run = file.functions.find((f) => f.qualifiedName === 'Service.Run')!;
  assert.equal(run.self, 's');
  assert.equal(run.kind, 'method');
});

test('annotations and attributes are collected as decorators', async () => {
  const java = await load(CASES.java);
  assert.deepEqual(java.functions.find((f) => f.name === 'chargesPositiveAmounts')!.decorators, ['@Test']);
  const rust = await load(CASES.rust);
  assert.deepEqual(rust.functions.find((f) => f.name === 'charges_positive_amounts')!.decorators, ['#[test]']);
  const cs = await load(CASES.csharp);
  assert.deepEqual(cs.functions.find((f) => f.name === 'Run')!.decorators, ['[HttpGet("charge")]']);
});

test('async functions are detected across languages', async () => {
  const ts = await load(CASES.typescript);
  assert.equal(ts.functions.find((f) => f.name === 'charge')!.signature.async, true);
  const cs = await load(CASES.csharp);
  assert.equal(cs.functions.find((f) => f.name === 'Charge')!.signature.async, true);
  const kt = await load(CASES.kotlin);
  assert.equal(kt.functions.find((f) => f.name === 'run')!.signature.async, true, 'Kotlin suspend');
  const sw = await load(CASES.swift);
  assert.equal(sw.functions.find((f) => f.name === 'run')!.signature.async, true);
});
