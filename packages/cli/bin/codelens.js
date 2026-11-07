#!/usr/bin/env node
// Runs the published bundle when there is one; in the repository, the TypeScript sources via tsx.
// Either way Node gets --liftoff-only (large WebAssembly grammars need it; see src/index.ts).
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// Sources only exist in the repository (the package ships dist/), so their presence means
// development: run them, never a stale build.
const source = fileURLToPath(new URL('../src/index.ts', import.meta.url));
const args = existsSync(source)
  ? ['--liftoff-only', createRequire(import.meta.url).resolve('tsx/cli'), source]
  : ['--liftoff-only', fileURLToPath(new URL('../dist/codelens.js', import.meta.url))];
const { status } = spawnSync(process.execPath, [...args, ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(status ?? 1);
