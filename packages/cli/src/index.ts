#!/usr/bin/env node
import { Command } from 'commander';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspect } from './graph.ts';
import { enrich, heuristicProvider, type EnrichmentProvider } from './enrich.ts';
import { explore } from './explore.ts';
import { WORKING_TREE } from './git.ts';
import { describeGraph } from './purpose.ts';
import { cacheDir, defaultStorePath, Store } from './store.ts';
import type { CodeGraph } from './types.ts';

const log = (msg: string) => console.error(msg);

// `npm run …` changes into the package root; resolve user paths against where npm was invoked.
const here = (p: string) => resolve(process.env.INIT_CWD ?? process.cwd(), p);

// Some Tree-sitter grammars (Swift, Kotlin, C#) are large enough that V8's optimizing
// WebAssembly compiler runs out of memory on them. The baseline compiler is as fast for
// parsing, but the flag only works at startup, so relaunch with it when it is missing.
if (!process.execArgv.includes('--liftoff-only')) {
  const { spawnSync } = await import('node:child_process');
  const { status } = spawnSync(process.execPath, ['--liftoff-only', ...process.execArgv, ...process.argv.slice(1)], { stdio: 'inherit' });
  process.exit(status ?? 1);
}

async function writeJson(path: string, data: unknown) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(data, null, 2));
  log(`Wrote ${path}`);
}

/** `--store <file>` / `--no-store`: the SQLite store for parses, descriptions and snapshots. */
function openStore(o: { store?: string | false }): Store | undefined {
  if (o.store === false) return undefined;
  return new Store(typeof o.store === 'string' ? here(o.store) : defaultStorePath());
}

/** Serve a graph with the web canvas (Vite dev server) and open it in the browser. */
function openViewer(graphPath: string) {
  const webDir = fileURLToPath(new URL('../../web/', import.meta.url));
  log(`Opening the canvas (Ctrl+C to stop)…`);
  const child = spawn('npm', ['run', 'dev', '--', '--open'], { cwd: webDir, stdio: 'inherit', env: { ...process.env, CODELENS_GRAPH: graphPath, INIT_CWD: webDir } });
  child.on('exit', (code) => process.exit(code ?? 0));
}

async function providerFor(name: string, model?: string): Promise<EnrichmentProvider> {
  if (name === 'heuristic' || name === 'mock') return heuristicProvider;
  if (name === 'claude') {
    const { claudeProvider } = await import('./claude.ts');
    return claudeProvider({ model });
  }
  if (name === 'claude-code') {
    const { claudeCodeProvider } = await import('./claudeCode.ts');
    return claudeCodeProvider({ model });
  }
  throw new Error(`Unknown provider "${name}" (expected heuristic | claude-code | claude)`);
}

const program = new Command()
  .name('codelens')
  .description('Review a diff, or explore a whole codebase, as a layered visual call graph.');

program
  .command('inspect')
  .description('Parse a repository and emit the impacted call graph for a diff')
  .argument('[repo]', 'path to the git repository', '.')
  .option('-b, --base <ref>', 'base revision', 'HEAD')
  .option('-H, --head <ref>', `head revision (${WORKING_TREE} = uncommitted working tree)`, WORKING_TREE)
  .option('-d, --depth <n>', 'caller hops to include around changes', '4')
  .option('--full', 'emit the full repository graph, not just the impacted subgraph')
  .option('-o, --out <file>', 'output JSON path', 'codelens.graph.json')
  .option('-e, --enrich [provider]', 'also run enrichment (heuristic | claude-code | claude)')
  .option('-m, --model <id>', 'model for the claude / claude-code providers')
  .option('--no-purpose', 'skip the "what / why" descriptions for functions and groups')
  .option('--store <file>', `store for parses and descriptions (default: ${defaultStorePath()})`)
  .option('--no-store', 'do not read or write the store')
  .action(async (repo: string, o) => {
    const store = openStore(o);
    let graph = await inspect(here(repo), { base: o.base, head: o.head, maxDepth: Number(o.depth), full: !!o.full, store, log });
    if (o.enrich) {
      const provider = await providerFor(o.enrich === true ? 'heuristic' : o.enrich, o.model);
      log(`Enriching with ${provider.name}…`);
      graph = await enrich(graph, provider, { log, purposes: o.purpose, store });
    }
    store?.close();
    await writeJson(here(o.out), graph);
  });

program
  .command('enrich')
  .description('Add contracts, invariants, and blast-radius scores to a graph JSON')
  .argument('<graph>', 'graph JSON produced by `inspect`')
  .option('-p, --provider <name>', 'heuristic | claude-code | claude', 'heuristic')
  .option('-m, --model <id>', 'model for the claude / claude-code providers')
  .option('-o, --out <file>', 'output path (defaults to overwriting the input)')
  .option('-c, --concurrency <n>', 'parallel LLM requests', '4')
  .option('--no-purpose', 'skip the "what / why" descriptions for functions and groups')
  .option('--store <file>', `store for parses and descriptions (default: ${defaultStorePath()})`)
  .option('--no-store', 'do not read or write the store')
  .action(async (file: string, o) => {
    const graph = JSON.parse(await readFile(here(file), 'utf8')) as CodeGraph;
    const provider = await providerFor(o.provider, o.model);
    const store = openStore(o);
    log(`Enriching ${graph.meta.stats.changedFunctions} changed functions with ${provider.name}…`);
    await enrich(graph, provider, { concurrency: Number(o.concurrency), log, purposes: o.purpose, store });
    store?.close();
    await writeJson(here(o.out ?? file), graph);
  });

program
  .command('explore')
  .description('Map a whole package or repository: entry points, hotspots, and what every part does')
  .argument('[path]', 'package directory, repository, or any folder of code', '.')
  .option('-r, --ref <ref>', `revision to explore (${WORKING_TREE} = files on disk)`, WORKING_TREE)
  .option('-p, --provider <name>', 'who writes the descriptions: heuristic | claude-code | claude', 'heuristic')
  .option('-m, --model <id>', 'model for the claude / claude-code providers')
  .option('-c, --concurrency <n>', 'parallel LLM requests', '4')
  .option('--scope-only', 'parse only this path, not the rest of the repository (faster on huge monorepos)')
  .option('-o, --out <file>', 'output JSON path (default: in the CodeLens cache directory)')
  .option('--open', 'open the result in the web canvas')
  .option('--store <file>', `store for parses, descriptions and snapshots (default: ${defaultStorePath()})`)
  .option('--no-store', 'do not read or write the store')
  .action(async (path: string, o) => {
    const store = openStore(o);
    const { graph, record } = await explore(here(path), { ref: o.ref, store, scopeOnly: !!o.scopeOnly, log });
    const provider = await providerFor(o.provider, o.model);
    log(`Describing with ${provider.name}…`);
    const { described, cached } = await describeGraph(graph, provider, heuristicProvider, { store, concurrency: Number(o.concurrency), log });
    if (provider.name !== 'heuristic') log(`  ${described} newly described, ${cached} from the store`);
    const rec = record(provider.name);
    store?.close();
    if (rec) log(`Recorded snapshot #${rec.id}${rec.commit ? ` (${rec.commit.slice(0, 7)}${rec.dirty ? ' + uncommitted changes' : ''})` : ''}`);
    const name = `${basename(graph.meta.repo)}${graph.meta.scope ? `-${graph.meta.scope.replace(/[^\w.-]+/g, '_')}` : ''}`;
    const id = createHash('sha1').update(`${graph.meta.repo}\0${graph.meta.scope}`).digest('hex').slice(0, 8);
    const out = o.out ? here(o.out) : join(cacheDir(), 'graphs', `${name}-${id}.graph.json`);
    await writeJson(out, graph);
    if (o.open) openViewer(out);
    else log(`View it: add --open, or run CODELENS_GRAPH=${out} npm run dev`);
  });

program
  .command('history')
  .description('List explore snapshots recorded in the store')
  .argument('[path]', 'only snapshots of the repository containing this path')
  .option('--store <file>', `store file (default: ${defaultStorePath()})`)
  .action(async (path: string | undefined, o) => {
    const store = openStore(o)!;
    let repo: string | undefined;
    if (path) {
      const { openSnapshot } = await import('./source.ts');
      const snap = await openSnapshot(here(path));
      repo = snap.root;
      snap.close();
    }
    const rows = store.listSnapshots(repo);
    const s = store.stats();
    store.close();
    if (!rows.length) log('No explore snapshots yet. Run `codelens explore <path>`.');
    for (const r of rows) {
      const rev = r.commit ? `${r.commit.slice(0, 7)}${r.dirty ? '+dirty' : ''}` : 'no git';
      console.log(`#${String(r.id).padEnd(4)} ${r.createdAt.slice(0, 16).replace('T', ' ')}  ${rev.padEnd(14)} ${String(r.functions).padStart(6)} fns  ${r.provider.padEnd(11)} ${r.repo}${r.scope ? `/${r.scope}` : ''}`);
    }
    log(`Store ${o.store ?? defaultStorePath()}: ${s.parses} cached parses, ${s.descriptions} descriptions, ${s.snapshots} snapshots`);
  });

program
  .command('languages')
  .description('List supported languages and the file extensions they claim')
  .action(async () => {
    const { LANGUAGES } = await import('./lang/index.ts');
    for (const l of LANGUAGES) console.log(`${l.name.padEnd(12)} ${l.extensions.join(' ')}`);
  });

program.parseAsync().catch((err) => {
  log(`codelens: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
