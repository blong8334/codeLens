#!/usr/bin/env node
import { Command } from 'commander';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { inspect } from './graph.ts';
import { enrich, heuristicProvider, type EnrichmentProvider } from './enrich.ts';
import { WORKING_TREE } from './git.ts';
import type { CodeGraph } from './types.ts';

const log = (msg: string) => console.error(msg);

async function writeJson(path: string, data: unknown) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(data, null, 2));
  log(`Wrote ${path}`);
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
  .description('Turn a git diff into a layered, visual call-graph review.');

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
  .option('--cache <file>', 'description cache file (default: ~/.cache/codelens/<repo>.json)')
  .action(async (repo: string, o) => {
    let graph = await inspect(resolve(repo), { base: o.base, head: o.head, maxDepth: Number(o.depth), full: !!o.full, log });
    if (o.enrich) {
      const provider = await providerFor(o.enrich === true ? 'heuristic' : o.enrich, o.model);
      log(`Enriching with ${provider.name}…`);
      graph = await enrich(graph, provider, { log, purposes: o.purpose, cachePath: o.cache });
    }
    await writeJson(resolve(o.out), graph);
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
  .option('--cache <file>', 'description cache file (default: ~/.cache/codelens/<repo>.json)')
  .action(async (file: string, o) => {
    const graph = JSON.parse(await readFile(resolve(file), 'utf8')) as CodeGraph;
    const provider = await providerFor(o.provider, o.model);
    log(`Enriching ${graph.meta.stats.changedFunctions} changed functions with ${provider.name}…`);
    await enrich(graph, provider, { concurrency: Number(o.concurrency), log, purposes: o.purpose, cachePath: o.cache });
    await writeJson(resolve(o.out ?? file), graph);
  });

program.parseAsync().catch((err) => {
  log(`codelens: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
