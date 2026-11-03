// End-to-end tests: build tiny multi-file repositories in a temp directory, commit a base and a
// change, run `inspect`, and check cross-file calls, entry points, sinks and grouping.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { inspect } from '../src/graph.ts';
import type { CodeGraph } from '../src/types.ts';

const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

async function repo(base: Record<string, string>, change: Record<string, string>): Promise<CodeGraph> {
  const dir = mkdtempSync(join(tmpdir(), 'codelens-'));
  dirs.push(dir);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  const write = (files: Record<string, string>) => {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@codelens.dev');
  git('config', 'user.name', 'CodeLens Test');
  write(base);
  git('add', '-A');
  git('commit', '-qm', 'base');
  write(change);
  git('add', '-A');
  git('commit', '-qm', 'change');
  return inspect(dir, { base: 'HEAD~1', head: 'HEAD', maxDepth: 4, full: true });
}

const edge = (g: CodeGraph, from: string, to: string) => g.edges.find((e) => e.source.endsWith(`#${from}`) && e.target.endsWith(`#${to}`));
const fn = (g: CodeGraph, qualifiedName: string) => {
  const n = g.nodes.find((x) => x.qualifiedName === qualifiedName);
  assert.ok(n, `missing ${qualifiedName}; have ${g.nodes.map((x) => x.qualifiedName).join(', ')}`);
  return n;
};
const systems = (g: CodeGraph) => g.groups.filter((x) => x.kind === 'system').map((x) => x.label).sort();

test('java: packages, imports, static calls, annotations, JDBC', async () => {
  const payments = (sig: string) => `package com.acme.billing;

import java.sql.Connection;

public class Payments {
    private Connection conn;

    public String charge(${sig}) {
        validate(amount);
        conn.prepareStatement("insert into charges values (?)");
        return Ledger.record(amount);
    }

    private void validate(long amount) {
        if (amount <= 0) throw new IllegalArgumentException("amount");
    }
}
`;
  const g = await repo(
    {
      'billing/pom.xml': '<project/>',
      'api/pom.xml': '<project/>',
      'billing/src/main/java/com/acme/billing/Payments.java': payments('long amount'),
      'billing/src/main/java/com/acme/billing/Ledger.java': `package com.acme.billing;

import java.net.http.HttpClient;

public class Ledger {
    public static String record(long amount) {
        return HttpClient.newHttpClient().toString();
    }
}
`,
      'api/src/main/java/com/acme/api/ChargeController.java': `package com.acme.api;

import com.acme.billing.Payments;

public class ChargeController {
    private Payments payments;

    @PostMapping("/charge")
    public String charge() {
        return payments.charge(10);
    }
}
`,
      'billing/src/test/java/com/acme/billing/PaymentsTest.java': `package com.acme.billing;

public class PaymentsTest {
    @Test
    public void chargesPositiveAmounts() {
        new Payments().charge(1);
    }
}
`,
    },
    { 'billing/src/main/java/com/acme/billing/Payments.java': payments('long amount, String currency') },
  );
  assert.equal(fn(g, 'Payments.charge').status, 'modified');
  assert.ok(edge(g, 'ChargeController.charge', 'Payments.charge'), 'controller → payments via injected field');
  assert.equal(edge(g, 'Payments.charge', 'Payments.validate')?.confidence, 'high', 'implicit this');
  assert.ok(edge(g, 'Payments.charge', 'Ledger.record'), 'static call to a class in the same package');
  assert.ok(edge(g, 'PaymentsTest.chargesPositiveAmounts', 'Payments.charge'), 'test → payments');
  assert.deepEqual(fn(g, 'Payments.charge').effects, ['sink:database']);
  assert.deepEqual(fn(g, 'Ledger.record').effects, ['sink:network']);
  assert.equal(fn(g, 'ChargeController.charge').entry?.kind, 'route');
  assert.equal(fn(g, 'PaymentsTest.chargesPositiveAmounts').entry?.kind, 'test');
  assert.deepEqual(systems(g), ['api', 'billing']);
});

test('go: same-package calls across files, package imports, handlers, tests', async () => {
  const charge = (body: string) => `package payments

import "database/sql"

// Charge records a charge.
func Charge(db *sql.DB, amount int) error {
	validate(amount)
	${body}
	return nil
}
`;
  const g = await repo(
    {
      'go.mod': 'module github.com/acme/shop\n',
      'payments/charge.go': charge('db.Exec("insert")'),
      'payments/validate.go': 'package payments\n\nfunc validate(amount int) {\n\tif amount <= 0 {\n\t\tpanic("amount")\n\t}\n}\n',
      'payments/charge_test.go': 'package payments\n\nimport "testing"\n\nfunc TestCharge(t *testing.T) {\n\tCharge(nil, 1)\n}\n',
      'api/handler.go': `package api

import (
	"net/http"

	"github.com/acme/shop/payments"
)

func HandleCharge(w http.ResponseWriter, r *http.Request) {
	payments.Charge(nil, 10)
}
`,
    },
    { 'payments/charge.go': charge('db.Exec("insert into charges")\n\tdb.Exec("update totals")') },
  );
  assert.equal(fn(g, 'Charge').status, 'modified');
  assert.equal(edge(g, 'Charge', 'validate')?.confidence, 'high', 'same package, different file');
  assert.ok(edge(g, 'HandleCharge', 'Charge'), 'package-qualified call through an import');
  assert.ok(edge(g, 'TestCharge', 'Charge'));
  assert.equal(fn(g, 'HandleCharge').entry?.kind, 'route');
  assert.equal(fn(g, 'TestCharge').entry?.kind, 'test');
  assert.deepEqual(fn(g, 'Charge').effects, ['sink:database']);
});

test('rust: crate paths, use imports, external crates', async () => {
  const billing = (n: string) => `use crate::ledger::record;

pub fn charge(amount: u64) {
    validate(amount);
    record(amount * ${n});
}

fn validate(amount: u64) {
    if amount == 0 {
        panic!("amount");
    }
}
`;
  const g = await repo(
    {
      'Cargo.toml': '[package]\nname = "shop"\n',
      'src/billing.rs': billing('1'),
      'src/ledger.rs': 'pub fn record(amount: u64) {\n    let client = reqwest::blocking::Client::new();\n    let _ = (client, amount);\n}\n',
      'src/main.rs': 'mod billing;\nmod ledger;\n\nuse crate::billing;\n\nfn main() {\n    billing::charge(1);\n}\n',
    },
    { 'src/billing.rs': billing('2') },
  );
  assert.equal(fn(g, 'charge').status, 'modified');
  assert.ok(edge(g, 'main', 'charge'), 'module-qualified call');
  assert.equal(edge(g, 'charge', 'validate')?.confidence, 'high');
  assert.equal(edge(g, 'charge', 'record')?.confidence, 'high', 'imported with use');
  assert.deepEqual(fn(g, 'record').effects, ['sink:network']);
  assert.equal(fn(g, 'main').entry?.kind, 'main');
});

test('csharp: namespaces via using, attributes, injected fields', async () => {
  const payments = (extra: string) => `namespace Acme.Services
{
    public class Payments
    {
        public void Charge(long amount)
        {
            Validate(amount);${extra}
        }

        private void Validate(long amount)
        {
            if (amount <= 0) throw new System.ArgumentException("amount");
        }
    }
}
`;
  const g = await repo(
    {
      'Acme.csproj': '<Project/>',
      'Services/Payments.cs': payments(''),
      'Controllers/ChargeController.cs': `using Acme.Services;

namespace Acme.Controllers
{
    public class ChargeController
    {
        private readonly Payments _payments;

        [HttpPost("charge")]
        public void Post()
        {
            _payments.Charge(10);
        }
    }
}
`,
    },
    { 'Services/Payments.cs': payments('\n            Validate(amount);') },
  );
  assert.equal(fn(g, 'Payments.Charge').status, 'modified');
  assert.ok(edge(g, 'ChargeController.Post', 'Payments.Charge'), 'injected _payments field');
  assert.equal(edge(g, 'Payments.Charge', 'Payments.Validate')?.confidence, 'high');
  assert.equal(fn(g, 'ChargeController.Post').entry?.kind, 'route');
});
