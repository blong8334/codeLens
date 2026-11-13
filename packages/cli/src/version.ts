import { readFileSync } from 'node:fs';

/** This package's version (from package.json, which sits one folder up from both src/ and dist/). */
export const VERSION: string = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
