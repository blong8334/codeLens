#!/usr/bin/env node
// Runs the published bundle when there is one; in the repository, the TypeScript sources via tsx.
// Either way Node gets --liftoff-only (large WebAssembly grammars need it; see src/index.ts).
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// node:sqlite (the default store) is built in from Node 22.13; say so plainly instead of failing
// on a missing module.
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(`codelens needs Node.js 22.13 or newer (this is ${process.version}). With nvm: nvm install 22 && nvm use 22`);
  process.exit(1);
}

// Sources only exist in the repository (the package ships dist/), so their presence means
// development: run them, never a stale build.
const source = fileURLToPath(new URL('../src/index.ts', import.meta.url));
const args = existsSync(source)
  ? ['--liftoff-only', createRequire(import.meta.url).resolve('tsx/cli'), source]
  : ['--liftoff-only', fileURLToPath(new URL('../dist/codelens.js', import.meta.url))];
const { status } = spawnSync(process.execPath, [...args, ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(status ?? 1);
