// Builds the publishable package: the CLI bundled to dist/ (dependencies stay external and are
// installed by npm), the canvas built into dist/web, and the parser version stamped in.
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
rmSync(here('../dist'), { recursive: true, force: true });

// The canvas, built from packages/web.
execFileSync('npm', ['run', 'build'], { cwd: here('../../web'), stdio: 'inherit' });
if (!existsSync(here('../../web/dist/index.html'))) throw new Error('the canvas did not build');
// Local graph files in the canvas's public/ folder (demo output, your own reviews) must never ship.
cpSync(here('../../web/dist'), here('../dist/web'), { recursive: true, filter: (src) => !/codelens\.[^/]*\.json$/.test(src) });

// Same hash the sources would give, so caches are shared between the repo and the package.
const { extractorVersionFromSources } = await import('../src/parse.ts');
const version = extractorVersionFromSources();

await build({
  entryPoints: { codelens: here('../src/index.ts') },
  outdir: here('../dist'),
  bundle: true,
  splitting: true, // lazily loaded parts (providers, Postgres, the type checker, the server) stay lazy
  format: 'esm',
  platform: 'node',
  target: 'node22',
  packages: 'external',
  define: { __CODELENS_EXTRACTOR__: JSON.stringify(version) },
  banner: { js: '// CodeLens — Apache-2.0 — https://github.com/blong8334/codeLens' },
  logLevel: 'info',
});
console.log(`built dist/ (parser version ${version})`);
