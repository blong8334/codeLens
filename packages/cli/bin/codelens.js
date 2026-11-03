#!/usr/bin/env node
// Runs the TypeScript entry point through tsx so the CLI works without a build step.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const tsx = require.resolve('tsx/cli');
const entry = fileURLToPath(new URL('../src/index.ts', import.meta.url));
const { status } = spawnSync(process.execPath, ['--liftoff-only', tsx, entry, ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(status ?? 1);
