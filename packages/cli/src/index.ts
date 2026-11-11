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
import { buildBrief } from './brief.ts';
import { commitPatch, patchInfo } from './patch.ts';
import { applyPreferences, defaultPreferencesPath, loadPreferences } from './preferences.ts';
import { buildGuide } from './guide.ts';
import { describeGraph } from './purpose.ts';
import { cacheDir, defaultStorePath, openStore as openStoreAt, type Store } from './store/index.ts';
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

/** `--no-source`: keep structure and descriptions, drop the code itself (for graphs you share or upload). */
function stripSource(graph: CodeGraph) {
  for (const n of graph.nodes) {
    n.source = '';
    delete n.diff;
    if (n.before) n.before.source = '';
    if (n.after) n.after.source = '';
  }
  if (graph.explore?.readme) graph.explore.readme.text = '';
  for (const f of graph.review?.files ?? []) delete f.patch;
  graph.meta.sourceIncluded = false;
}

async function writeJson(path: string, data: unknown) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(data, null, 2));
  log(`Wrote ${path}`);
}

/**
 * `--store <file | postgres://…>` / `--no-store`: where parses, descriptions and snapshots live.
 * A path is a SQLite file; a postgres:// URL (optionally `?schema=name`) is a shared database.
 */
async function openStore(o: { store?: string | boolean }): Promise<Store | undefined> {
  if (o.store === false) return undefined;
  const at = typeof o.store === 'string' ? o.store : defaultStorePath();
  return openStoreAt(/^postgres(ql)?:\/\//.test(at) || at === ':memory:' ? at : here(at));
}

/** Serve a graph with the built canvas and open it in the browser. */
async function openViewer(graphPath: string, port?: number) {
  // A viewer may already be running for another graph; each `view` gets its own port.
  const { view } = await import('./view.ts');
  await view(graphPath, { port, log });
}

async function providerFor(name: string, model?: string, baseURL?: string): Promise<EnrichmentProvider> {
  if (name === 'heuristic' || name === 'mock') return heuristicProvider;
  if (name === 'claude') {
    const { claudeProvider } = await import('./claude.ts');
    return claudeProvider({ model });
  }
  if (name === 'claude-code') {
    const { claudeCodeProvider } = await import('./claudeCode.ts');
    return claudeCodeProvider({ model });
  }
  if (name === 'openai') {
    const { openaiProvider } = await import('./openai.ts');
    return openaiProvider({ model, baseURL: baseURL ?? undefined });
  }
  throw new Error(`Unknown provider "${name}" (expected heuristic | claude-code | claude | openai)`);
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
  .option('-e, --enrich [provider]', 'also run enrichment (heuristic | claude-code | claude | openai)')
  .option('-m, --model <id>', 'model id for the chosen provider')
  .option('--base-url <url>', 'openai provider: an OpenAI-compatible API (default $OPENAI_BASE_URL or OpenAI; Ollama: http://localhost:11434/v1)')
  .option('--no-purpose', 'skip the "what / why" descriptions for functions and groups')
  .option('--store <file>', `SQLite file or postgres:// URL for parses and descriptions (default: ${defaultStorePath()})`)
  .option('--no-store', 'do not read or write the store')
  .option('--no-source', 'leave source code and diffs out of the written graph (structure and descriptions only)')
  .option('--no-types', 'skip the TypeScript checker (name matching only)')
  .action(async (repo: string, o) => {
    const store = await openStore(o);
    let graph = await inspect(here(repo), { base: o.base, head: o.head, maxDepth: Number(o.depth), full: !!o.full, store, types: o.types, log });
    if (o.enrich) {
      const provider = await providerFor(o.enrich === true ? 'heuristic' : o.enrich, o.model, o.baseUrl);
      log(`Enriching with ${provider.name}…`);
      graph = await enrich(graph, provider, { log, purposes: o.purpose, store });
      graph.enrichment!.brief = await buildBrief(graph, provider, { store, log });
    }
    await store?.close();
    if (o.source === false) stripSource(graph);
    await writeJson(here(o.out), graph);
  });

program
  .command('enrich')
  .description('Add contracts, invariants, and blast-radius scores to a graph JSON')
  .argument('<graph>', 'graph JSON produced by `inspect`')
  .option('-p, --provider <name>', 'heuristic | claude-code | claude | openai', 'heuristic')
  .option('-m, --model <id>', 'model id for the chosen provider')
  .option('--base-url <url>', 'openai provider: an OpenAI-compatible API (default $OPENAI_BASE_URL or OpenAI; Ollama: http://localhost:11434/v1)')
  .option('-o, --out <file>', 'output path (defaults to overwriting the input)')
  .option('-c, --concurrency <n>', 'parallel LLM requests', '4')
  .option('--no-purpose', 'skip the "what / why" descriptions for functions and groups')
  .option('--store <file>', `SQLite file or postgres:// URL for parses and descriptions (default: ${defaultStorePath()})`)
  .option('--no-store', 'do not read or write the store')
  .option('--no-source', 'leave source code and diffs out of the written graph (structure and descriptions only)')
  .action(async (file: string, o) => {
    const graph = JSON.parse(await readFile(here(file), 'utf8')) as CodeGraph;
    const provider = await providerFor(o.provider, o.model, o.baseUrl);
    const store = await openStore(o);
    log(`Enriching ${graph.meta.stats.changedFunctions} changed functions with ${provider.name}…`);
    await enrich(graph, provider, { concurrency: Number(o.concurrency), log, purposes: o.purpose, store });
    graph.enrichment!.brief = await buildBrief(graph, provider, { store, log });
    await store?.close();
    if (o.source === false) stripSource(graph);
    await writeJson(here(o.out ?? file), graph);
  });

program
  .command('review')
  .description('Review a branch like a pull request: risk, reading order, broken contracts, reach and effects, as Markdown')
  .argument('[repo]', 'path to the git repository', '.')
  .option('-b, --base <ref>', "branch to compare against (default: the remote's default branch); the fork point is used, as in a PR")
  .option('-H, --head <ref>', `revision to review (${WORKING_TREE} = include uncommitted changes)`, 'HEAD')
  .option('-p, --provider <name>', 'heuristic | claude-code | claude | openai', 'heuristic')
  .option('-m, --model <id>', 'model id for the chosen provider')
  .option('--base-url <url>', 'openai provider: an OpenAI-compatible API')
  .option('-c, --concurrency <n>', 'parallel LLM requests', '4')
  .option('-d, --depth <n>', 'caller hops to include around changes', '4')
  .option('-o, --out <file>', 'write the Markdown here instead of stdout')
  .option('--json', 'print the report as JSON instead of Markdown')
  .option('--json-out <file>', 'also write the report as JSON to this file')
  .option('-g, --graph <file>', 'also write the review graph, for `codelens view`')
  .option('--fail-on <level>', 'exit with status 1 when overall risk is at least this level: low | medium | high')
  .option('--no-purpose', 'skip the "what / why" descriptions')
  .option('--store <file>', `SQLite file or postgres:// URL (default: ${defaultStorePath()})`)
  .option('--no-store', 'do not read or write the store')
  .option('--no-source', 'leave source code and diffs out of the written graph')
  .option('--prefs <file>', `your review preferences: what you care about and skip (default: ${defaultPreferencesPath()}, if it exists)`)
  .option('--no-prefs', 'ignore your review preferences')
  .option('--no-types', 'skip the TypeScript checker (name matching only)')
  .action(async (repo: string, o) => {
    const { reviewBase } = await import('./git.ts');
    const { reviewMarkdown, reviewReport } = await import('./review.ts');
    const { Repo } = await import('./git.ts');
    const root = (await Repo.open(here(repo))).root;
    const { base, label } = await reviewBase(root, o.base, o.head);
    log(`Reviewing ${o.head === WORKING_TREE ? 'the working tree' : o.head} against ${label}`);
    const store = await openStore(o);
    let graph = await inspect(root, { base, head: o.head, maxDepth: Number(o.depth), full: false, store, types: o.types, log });
    applyPreferences(graph, await usePreferences(o.prefs));
    const provider = await providerFor(o.provider, o.model, o.baseUrl);
    log(`Enriching with ${provider.name}…`);
    graph = await enrich(graph, provider, { concurrency: Number(o.concurrency), log, purposes: o.purpose, store });
    graph.enrichment!.brief = await buildBrief(graph, provider, { store, log });
    await store?.close();
    const report = reviewReport(graph);
    if (o.graph) {
      if (o.source === false) stripSource(graph);
      await writeJson(here(o.graph), graph);
    }
    const text = o.json ? JSON.stringify(report, null, 2) : reviewMarkdown(report, { viewHint: o.graph ? `map: \`codelens view ${o.graph}\`` : undefined });
    if (o.jsonOut) await writeJson(here(o.jsonOut), report);
    if (o.out) {
      await mkdir(dirname(here(o.out)), { recursive: true });
      await writeFile(here(o.out), text);
      log(`Wrote ${here(o.out)}`);
    } else console.log(text);
    log(`Overall risk: ${report.risk.level} (${report.risk.score.toFixed(2)})`);
    const levels = ['low', 'medium', 'high'];
    if (o.failOn && !levels.includes(o.failOn)) throw new Error('--fail-on expects low, medium or high');
    if (o.failOn && levels.indexOf(report.risk.level) >= levels.indexOf(o.failOn)) process.exitCode = 1;
  });

program
  .command('pr')
  .description('Open a GitHub pull request in CodeLens: fetch it, review it, and show the map')
  .argument('<pr>', 'number (in the current clone), owner/repo#number, or the pull request URL')
  .argument('[repo]', 'local clone to use (default: the current directory; otherwise a code-only clone is cached)', '.')
  .option('-p, --provider <name>', 'heuristic | claude-code | claude | openai', 'heuristic')
  .option('-m, --model <id>', 'model id for the chosen provider')
  .option('--base-url <url>', 'openai provider: an OpenAI-compatible API')
  .option('-c, --concurrency <n>', 'parallel LLM requests', '4')
  .option('-d, --depth <n>', 'caller hops to include around changes', '4')
  .option('-o, --out <file>', 'graph JSON path (default: in the CodeLens cache directory)')
  .option('--no-open', 'write the graph and review without opening the canvas')
  .option('--port <n>', 'port for the canvas', '5173')
  .option('--no-purpose', 'skip the "what / why" descriptions')
  .option('--store <file>', `SQLite file or postgres:// URL (default: ${defaultStorePath()})`)
  .option('--no-store', 'do not read or write the store')
  .option('--no-source', 'leave source code and diffs out of the written graph')
  .option('--prefs <file>', `your review preferences: what you care about and skip (default: ${defaultPreferencesPath()}, if it exists)`)
  .option('--no-prefs', 'ignore your review preferences')
  .option('--no-types', 'skip the TypeScript checker (name matching only)')
  .action(async (prArg: string, repo: string, o) => {
    const { checkoutPr } = await import('./github.ts');
    const { reviewMarkdown, reviewReport } = await import('./review.ts');
    const pr = await checkoutPr(prArg, here(repo), log);
    const store = await openStore(o);
    let graph = await inspect(pr.root, { base: pr.base, head: pr.head, maxDepth: Number(o.depth), full: false, store, types: o.types, log });
    applyPreferences(graph, await usePreferences(o.prefs));
    const provider = await providerFor(o.provider, o.model, o.baseUrl);
    log(`Enriching with ${provider.name}…`);
    graph.meta.pr = pr.info;
    if (graph.review) graph.review.key = `${new URL(pr.info.url).host}/${pr.info.repo}#${pr.info.number}`;
    graph = await enrich(graph, provider, { concurrency: Number(o.concurrency), log, purposes: o.purpose, store });
    graph.enrichment!.brief = await buildBrief(graph, provider, { store, log });
    await store?.close();
    const { fetchDiscussion } = await import('./discussion.ts');
    graph.meta.pr!.discussion = await fetchDiscussion(graph, pr.root).catch((err: Error) => {
      log(`  ! could not load the discussion (${err.message})`);
      return undefined;
    });
    const d = graph.meta.pr!.discussion;
    if (d) log(`Discussion: ${d.threads.length} thread${d.threads.length === 1 ? '' : 's'} (${d.threads.filter((t) => t.fnId).length} on functions in the map), ${d.reviews.length} review${d.reviews.length === 1 ? '' : 's'}, ${d.conversation.length} comment${d.conversation.length === 1 ? '' : 's'}`);
    const report = reviewReport(graph);
    if (o.source === false) stripSource(graph);
    const name = `${pr.info.repo.replace('/', '-')}-pr${pr.info.number}`;
    const out = o.out ? here(o.out) : join(cacheDir(), 'graphs', `${name}.graph.json`);
    await writeJson(out, graph);
    const md = out.replace(/\.graph\.json$|\.json$/, '') + '.review.md';
    await writeFile(md, reviewMarkdown(report));
    log(`Wrote ${md}`);
    log(`Overall risk: ${report.risk.level} (${report.risk.score.toFixed(2)}) · ${report.changes.length} functions changed`);
    if (o.open) await openViewer(out, Number(o.port));
  });

program
  .command('diff')
  .description('Review a patch from any code review tool (a downloaded .diff or .patch) against a local clone')
  .argument('<patch>', 'unified diff or `git format-patch` file; - reads stdin')
  .argument('[repo]', 'local clone the patch applies to', '.')
  .option('-b, --base <ref>', 'revision the patch was written against', 'HEAD')
  .option('--strip <n>', 'leading path components to drop from patch paths, as `git apply -p` (default 1: a/ b/)')
  .option('--directory <dir>', 'prepend this directory to patch paths (patch made inside a subfolder)')
  .option('-t, --title <text>', 'title for the brief (default: the patch subject, if any)')
  .option('--description <text>', "the author's description, or @file to read it from a file")
  .option('-k, --key <id>', 'keep this review\'s accepted changes separate, e.g. a CR number (default: one set per repository; accepts are tied to the exact changed lines, so revisions keep them and other changes do not)')
  .option('-p, --provider <name>', 'heuristic | claude-code | claude | openai', 'heuristic')
  .option('-m, --model <id>', 'model id for the chosen provider')
  .option('--base-url <url>', 'openai provider: an OpenAI-compatible API')
  .option('-c, --concurrency <n>', 'parallel LLM requests', '4')
  .option('-d, --depth <n>', 'caller hops to include around changes', '4')
  .option('-o, --out <file>', 'graph JSON path (default: in the CodeLens cache directory)')
  .option('--no-open', 'write the graph and review without opening the canvas')
  .option('--port <n>', 'port for the canvas', '5173')
  .option('--no-purpose', 'skip the "what / why" descriptions')
  .option('--store <file>', `SQLite file or postgres:// URL (default: ${defaultStorePath()})`)
  .option('--no-store', 'do not read or write the store')
  .option('--no-source', 'leave source code and diffs out of the written graph')
  .option('--prefs <file>', `your review preferences: what you care about and skip (default: ${defaultPreferencesPath()}, if it exists)`)
  .option('--no-prefs', 'ignore your review preferences')
  .option('--no-types', 'skip the TypeScript checker (name matching only)')
  .action(async (patchArg: string, repo: string, o) => {
    const { Repo } = await import('./git.ts');
    const { reviewMarkdown, reviewReport } = await import('./review.ts');
    const fromStdin = patchArg === '-';
    const text = fromStdin ? await readStdin() : await readFile(here(patchArg), 'utf8');
    if (!/^(@@ |diff --git |--- )/m.test(text)) throw new Error(`${fromStdin ? 'stdin' : patchArg} does not look like a unified diff`);
    const root = (await Repo.open(here(repo))).root;
    const head = await commitPatch(root, o.base, text, { strip: o.strip === undefined ? undefined : Number(o.strip), directory: o.directory });
    const info = patchInfo(text);
    const source = fromStdin ? 'patch from stdin' : basename(patchArg);
    const title = o.title ?? info.title;
    const description = o.description?.startsWith('@') ? await readFile(here(o.description.slice(1)), 'utf8') : (o.description ?? info.description);
    log(`Applied ${source} on ${o.base}${title ? ` — ${title}` : ''}`);
    const store = await openStore(o);
    let graph = await inspect(root, { base: o.base, head, maxDepth: Number(o.depth), full: false, store, types: o.types, log });
    graph.meta.change = { title, description, source };
    // One set of marks per repository by default: a mark is tied to a change's exact lines, so a new
    // revision of the same change keeps it and a different change touching the same code does not.
    const key: string | undefined = o.key;
    if (graph.review) graph.review.key = key ? `patch:${root}:${key}` : `patch:${root}`;
    applyPreferences(graph, await usePreferences(o.prefs));
    const provider = await providerFor(o.provider, o.model, o.baseUrl);
    log(`Enriching with ${provider.name}…`);
    graph = await enrich(graph, provider, { concurrency: Number(o.concurrency), log, purposes: o.purpose, store });
    graph.enrichment!.brief = await buildBrief(graph, provider, { store, log });
    await store?.close();
    const report = reviewReport(graph);
    if (o.source === false) stripSource(graph);
    const name = `${basename(root)}-${(key ?? head.slice(0, 7)).replace(/[^\w.-]+/g, '_')}`;
    const out = o.out ? here(o.out) : join(cacheDir(), 'graphs', `${name}.graph.json`);
    await writeJson(out, graph);
    const md = out.replace(/\.graph\.json$|\.json$/, '') + '.review.md';
    await writeFile(md, reviewMarkdown(report));
    log(`Wrote ${md}`);
    log(`Overall risk: ${report.risk.level} (${report.risk.score.toFixed(2)}) · ${report.changes.length} functions changed`);
    if (o.open) await openViewer(out, Number(o.port));
  });

/** Load review preferences (an explicit path must exist; the default one is optional) and say so. */
async function usePreferences(path: string | boolean | undefined) {
  const prefs = await loadPreferences(path === true ? undefined : path);
  if (prefs) log(`Using your review preferences (${prefs.source})${[prefs.skipTests && 'skipping tests', prefs.skipMoves && 'skipping moves and renames'].filter(Boolean).map((x) => `, ${x}`).join('')}`);
  return prefs;
}

async function readStdin(): Promise<string> {
  let s = '';
  for await (const chunk of process.stdin) s += chunk;
  return s;
}

program
  .command('explore')
  .description('Map a whole package or repository: entry points, hotspots, and what every part does')
  .argument('[path]', 'package directory, repository, or any folder of code', '.')
  .option('-r, --ref <ref>', `revision to explore (${WORKING_TREE} = files on disk)`, WORKING_TREE)
  .option('-p, --provider <name>', 'who writes the descriptions: heuristic | claude-code | claude | openai', 'heuristic')
  .option('-m, --model <id>', 'model id for the chosen provider')
  .option('--base-url <url>', 'openai provider: an OpenAI-compatible API (default $OPENAI_BASE_URL or OpenAI; Ollama: http://localhost:11434/v1)')
  .option('-c, --concurrency <n>', 'parallel LLM requests', '4')
  .option('--scope-only', 'parse only this path, not the rest of the repository (faster on huge monorepos)')
  .option('-o, --out <file>', 'output JSON path (default: in the CodeLens cache directory)')
  .option('--open', 'open the result in the web canvas')
  .option('--store <file>', `SQLite file or postgres:// URL for parses, descriptions and snapshots (default: ${defaultStorePath()})`)
  .option('--no-store', 'do not read or write the store')
  .option('--no-source', 'leave source code and diffs out of the written graph (structure and descriptions only)')
  .option('--no-types', 'skip the TypeScript checker (name matching only)')
  .action(async (path: string, o) => {
    const store = await openStore(o);
    const { graph, record } = await explore(here(path), { ref: o.ref, store, scopeOnly: !!o.scopeOnly, types: o.types, log });
    const provider = await providerFor(o.provider, o.model, o.baseUrl);
    log(`Describing with ${provider.name}…`);
    const { described, cached } = await describeGraph(graph, provider, heuristicProvider, { store, concurrency: Number(o.concurrency), log });
    if (provider.name !== 'heuristic') log(`  ${described} newly described, ${cached} from the store`);
    graph.explore!.guide = await buildGuide(graph, provider, { store, log });
    const rec = await record(provider.name);
    await store?.close();
    if (rec) log(`Recorded snapshot #${rec.id}${rec.commit ? ` (${rec.commit.slice(0, 7)}${rec.dirty ? ' + uncommitted changes' : ''})` : ''}`);
    const name = `${basename(graph.meta.repo)}${graph.meta.scope ? `-${graph.meta.scope.replace(/[^\w.-]+/g, '_')}` : ''}`;
    const id = createHash('sha1').update(`${graph.meta.repo}\0${graph.meta.scope}`).digest('hex').slice(0, 8);
    const out = o.out ? here(o.out) : join(cacheDir(), 'graphs', `${name}-${id}.graph.json`);
    if (o.source === false) stripSource(graph);
    await writeJson(out, graph);
    if (o.open) await openViewer(out);
    else log(`View it: codelens view ${out}`);
  });

program
  .command('view')
  .description('Open a graph in the canvas (default: the most recently written explore graph)')
  .argument('[graph]', 'graph JSON written by explore or inspect')
  .option('--port <n>', 'port to serve on (the next free one is used if taken)', '5173')
  .option('--no-open', 'do not open a browser')
  .action(async (file: string | undefined, o) => {
    let path = file ? here(file) : undefined;
    if (!path) {
      const { readdirSync, statSync } = await import('node:fs');
      const dir = join(cacheDir(), 'graphs');
      const latest = (() => {
        try {
          return readdirSync(dir)
            .filter((n) => n.endsWith('.graph.json'))
            .map((n) => join(dir, n))
            .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
        } catch {
          return undefined;
        }
      })();
      if (!latest) throw new Error('no graph given and none explored yet: run `codelens explore <path>` first');
      path = latest;
    }
    const { view } = await import('./view.ts');
    await view(path, { port: Number(o.port), open: o.open, log });
  });

program
  .command('history')
  .description('List explore snapshots recorded in the store')
  .argument('[path]', 'only snapshots of the repository containing this path')
  .option('--store <file>', `SQLite file or postgres:// URL (default: ${defaultStorePath()})`)
  .action(async (path: string | undefined, o) => {
    const store = (await openStore(o))!;
    let repo: string | undefined;
    if (path) {
      const { openSnapshot } = await import('./source.ts');
      const snap = await openSnapshot(here(path));
      repo = snap.root;
      snap.close();
    }
    const rows = await store.listSnapshots(repo);
    const s = await store.stats();
    await store.close();
    if (!rows.length) log('No explore snapshots yet. Run `codelens explore <path>`.');
    for (const r of rows) {
      const rev = r.commit ? `${r.commit.slice(0, 7)}${r.dirty ? '+dirty' : ''}` : 'no git';
      console.log(`#${String(r.id).padEnd(4)} ${r.createdAt.slice(0, 16).replace('T', ' ')}  ${rev.padEnd(14)} ${String(r.functions).padStart(6)} fns  ${r.provider.padEnd(11)} ${r.repo}${r.scope ? `/${r.scope}` : ''}`);
    }
    log(`Store ${store.location}: ${s.parses} cached parses, ${s.descriptions} descriptions, ${s.snapshots} snapshots`);
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
