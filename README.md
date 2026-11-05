# CodeLens

Visual-first code understanding. CodeLens has two modes:

- **Explore** a whole package or repository to learn how it works: a zoomed-out map of its systems and modules, entry points to start reading from, hotspots, external effects, search, and a *what / why* for every function. A local store remembers what you have already seen, so re-exploring after a `git pull` only processes new code and tells you what changed.
- **Review** a diff. Instead of a line-by-line unified diff, CodeLens turns a git diff into an interactive review:

1. **Impact map**: one changed function at the center, upstream callers to the left, downstream callees and external effects (database, network, filesystem, …) to the right. A **Group by** control shows the callers and callees as individual functions, or grouped by file, module, or system. The centered function always stays its own card.
2. **Invariants**: what could fail, the evidence for it, and who relies on it
3. **Diffs**: the exact lines, per function, in suggested review order

Every function, file, module, and system carries a short *what / why* summary.

```
git diff + Tree-sitter ─▶ call graph JSON ─▶ enrichment (heuristic | Claude) ─▶ React Flow canvas
```

## Quick start

```bash
npm install
npm run demo        # builds examples/demo-shop, analyzes its last commit, opens the canvas
```

Then open http://localhost:5173.

| Gesture | Does |
|---|---|
| click | open the card in the side panel |
| double-click a function | re-center the map on it (breadcrumbs track the path) |
| double-click a group | open it in place; double-click again to fold it |
| click `+N more` | expand a capped column |
| double-click `+N more files in …` | show everything folded into that card (overview) |
| `−` / `+` | zoom detail out / in |
| `←` / `→` | previous / next change in review order (entry point in explore mode) |
| `/` | search functions, files, and modules |
| `o` | zoom out to the overview |
| `1`–`3`, `Esc`, `Backspace` | switch tab, clear selection, go back |

## Explore a codebase

```bash
# Map any package, repository, or plain folder of code and open it in the canvas
npm run explore -- ~/code/some-repo --open

# Just one package of a monorepo (calls into the rest of the repo stay as one hop of context)
npm run explore -- ~/code/some-repo/services/billing --open

# With AI descriptions through your Claude Code subscription (cached: you pay once per function)
npm run explore -- ~/code/some-repo -p claude-code --open

# Your own model: any OpenAI-compatible API, or a local one (see Enrichment below)
npm run explore -- ~/code/some-repo -p openai -m llama3.1 --base-url http://localhost:11434/v1 --open

# A graph to share: structure and descriptions only, no source code
npm run explore -- ~/code/some-repo --no-source -o some-repo.graph.json

# Open the latest graph again (or a given one) without re-running anything
npm run codelens -- view
npm run codelens -- view some-repo.graph.json

# A specific commit or branch instead of the files on disk
npm run explore -- ~/code/some-repo --ref v2.1.0 --open

# What have I explored, and what is in the store?
npm run codelens -- history
```

It opens on the **guide**, a landing page for the package:
- **What it is**: a few sentences on what the package does, and **how it's organized**. These come from the README and the code (with `-p claude-code` or `-p claude`, one request per explore, kept in the store), or offline from the README's opening paragraph and the part summaries.
- **Start here**: a suggested reading order, each step with why to start there. Click one to open the map centered on it.
- **The parts**: systems, modules, or files with their summaries.
- **Also on the page**: key functions, ways in, external effects, and what changed since your last look.

Switch between **Guide** and **Map** in the header (`g` / `m`). Links with `?fn=…` or `?view=map` open straight on the map.

The map opens on the **overview**: the package's systems or modules, connected by call volume, with the databases, network, queues and filesystems they touch. Use **Group by** to switch between System, Module, and File; double-click a part to open it in place, or a function to center on it. **Tests** toggles test code. The side panel lists:
- **Start reading here**: entry points (mains, routes, CLI commands, jobs, public API). `←` / `→` steps through them.
- **Hotspots**: the functions that hold the package together. They are ranked by callers, callees, how many modules they connect, and how much of the code reaches them.
- **Talks to**: external effects.
- **New or changed since last look**, when you have explored this scope before.

Press `/` to search functions, files, and modules, and `o` to return to the overview.

**Cards** caps how many cards any view draws: 25 by default, or 40, 80, or All, remembered per browser. In the overview, the least important parts fold into one "+N more files in src/lang" card per parent. Importance comes from the selection, entry points, hotspots, recent change, size, and connectivity. Folded cards keep their connections, so the map still shows where the hidden code is and what it talks to. Double-click one to show its contents, or use **show all**. In the focused view, the per-column cap shrinks so all columns together stay within the limit. Parts with no calls either way are packed into a grid beside the flow instead of one tall column.

### The store

Everything CodeLens learns is kept in a store. It's one of two kinds:

- **A SQLite file** (the default, using Node's built-in `node:sqlite`, no setup) at `~/.cache/codelens/store.db`.
- **A Postgres database**, shared by a team, so descriptions are paid for once per team rather than once per person.

```bash
--store ~/somewhere/else.db                               # another SQLite file
--store postgres://user:pass@db.internal/codelens         # Postgres, schema "codelens"
--store 'postgres://user:pass@db.internal/codelens?schema=team_payments'
```

`CODELENS_STORE` sets the default, and `--no-store` bypasses it. In Postgres, each store lives in its own **schema**, so teams (or, hosted, customers) are fully separated. Keys are content hashes, so never share one schema between parties who must not learn about each other's code. Reads and writes are batched (a few round trips per run), so a remote database is fine.

| Table | Keyed by | Holds |
|---|---|---|
| `parses` | git blob id + extractor version | the extracted functions, calls, and imports of one file's content |
| `descriptions` | hash of provider + function (or group) content | *what / why* text |
| `snapshots` | repo + scope, with commit id and tree hash | what was explored, when, at which commit |
| `snapshot_fns` | snapshot + function id | each function's fingerprint, to compute "new / changed since" |

Because everything is keyed by **content**, the store works across branches, rebases, and uncommitted edits. A file that is unchanged since any earlier run is never read or parsed again, and an unchanged function is never described again. The commit id on each snapshot is what "since your last look (abc1234)" refers to. The extractor version is a hash of the parser code itself, so upgrading CodeLens automatically re-parses with the new rules. Old JSON description caches are imported on first use.

## Review pull requests

```bash
# Review the current branch the way a pull request would be (against the fork point of origin's default branch)
npm run codelens -- review

# Against a specific base, with Claude, writing the map too
npm run codelens -- review . --base origin/develop -p claude-code -o review.md -g review.graph.json
npm run codelens -- view review.graph.json

# In CI: fail when the overall risk is high
npm run codelens -- review --fail-on high
```

The summary is Markdown written for a PR comment:
- the overall risk;
- functions in the order to review them, each linked to its lines on GitHub;
- breaking contract changes as signature diffs;
- invariants at risk;
- which routes, CLIs, and jobs reach the change;
- which external systems (databases, APIs, queues) it touches.

`--json` or `--json-out` give the same facts as data for other tools.

### Open a pull request in CodeLens

```bash
npm run pr -- 123                                              # a PR in the repo you're in
npm run pr -- https://github.com/expressjs/express/pull/7574   # any PR, cloned or not
npm run pr -- expressjs/express#7574 -p claude-code            # with Claude's analysis
```

The command:
1. looks up the PR (title, author, description, branches);
2. fetches its code, using your clone when you're in one, else a code-only clone kept in `~/.cache/codelens/repos/`;
3. reviews it against the same fork point GitHub's diff uses;
4. opens the canvas with the PR in the header and side panel, including **Open on GitHub** and **Files changed**.

It also writes the Markdown review next to the graph. Fork PRs work, because GitHub publishes every PR's head on the base repository.

**The PR's discussion comes along.** Line comments are grouped into threads, and each thread is attached to the function it's about. That holds even for *outdated* comments made on an earlier push: CodeLens reads the file as it was at that commit and finds which function held the line.

What you see in the canvas:
- Cards show 💬 counts.
- A function's panel shows its threads (Markdown rendered, suggested changes included), with **Reply** and **Comment on this function**.
- The PR panel shows each reviewer's current verdict, general comments, and a review box with **Comment**, **Approve**, and **Request changes**.

Posting goes through the local `codelens view` server as your `gh` login (or `GITHUB_TOKEN`). A comment lands on the function's first changed line, or on the PR conversation (linked to the function) when the function isn't part of the diff. While the page is open, the discussion refreshes from GitHub every minute, and the graph file is updated so the next open starts current.

Any website can send requests to `localhost`, so the server guards itself:
- writes need a per-session token embedded only in the CodeLens page;
- every API call must name the server as its host, which blocks DNS rebinding;
- other origins are refused.

GitHub Enterprise: set `CODELENS_GITHUB_API=https://github.example.com/api/v3` when not using `gh`.

Auth: it uses your `gh` login when you're signed in (private repos and GitHub Enterprise), else `GITHUB_TOKEN`; public repos need neither.

### GitHub Action

```yaml
# .github/workflows/codelens.yml
on: pull_request
permissions: { contents: read, pull-requests: write }
jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: blong8334/codeLens@main
        with:
          provider: heuristic          # or claude + anthropic-api-key, or openai + openai-api-key / openai-base-url
          # fail-on: high
```

On each pull request, the Action:
- posts the review as a comment and updates the same comment on every push;
- adds it to the run's summary page;
- attaches the map as an artifact (`codelens-map`, viewed with `codelens view`);
- caches the store between runs, so each function is analyzed once rather than once per PR.

Inputs: `provider`, `model`, `anthropic-api-key`, `openai-api-key`, `openai-base-url`, `base`, `fail-on`, `comment`, `descriptions`, `include-source`. Output: `risk`.

## Review your own diffs

```bash
# Uncommitted changes vs HEAD (default)
npm run codelens -- inspect ~/code/my-repo --enrich -o packages/web/public/codelens.graph.json

# A commit range, enriched by Claude through your Claude Code subscription (no API key)
npm run codelens -- inspect ~/code/my-repo -b main -H feature-branch -o graph.json
npm run codelens -- enrich graph.json --provider claude-code

# Same, through the Claude API (for CI; needs API credits)
ANTHROPIC_API_KEY=... npm run codelens -- enrich graph.json --provider claude

# View any graph file
CODELENS_GRAPH=graph.json npm run dev
```

You can also drop a graph JSON onto the page, or deep-link with `?fn=<node id>&lod=0..3&layer=1..3`.

## Systems, entry points, and sinks

CodeLens groups code automatically:
- **file**
- **module**: the directory
- **system**: a nested package (any `package.json`, `pyproject.toml`, `go.mod`, or `Cargo.toml`), otherwise the first meaningful directory (skipping `src`, `lib`, `app`, …)

It also flags **entry points**: routes, CLI commands, jobs (including Celery and cron decorators), tests, and exported functions with no callers. It detects **sinks** (external effects) from unresolved calls to known clients and packages: `pg`, `prisma`, `redis`, `fetch`, `axios`, `requests`, `fs`, `child_process`, S3, queues, and similar.

Override any of it with an optional `.codelens.json` at the repo root:

```json
{
  "systems":     { "Payments": ["src/services/payments.ts", "src/lib/money.ts"] },
  "modules":     { "Checkout flow": ["src/services/orders.ts", "src/services/inventory.ts"] },
  "entryPoints": ["src/api/**", "worker/reconcile.py#reconcile"],
  "sinks":       { "network": ["gateway"], "billing": ["stripe"] },
  "ignore":      ["**/generated/**"]
}
```

Patterns are globs (`*`, `**`, `?`). `path#name` matches a function by qualified name.

| `inspect` option | Meaning |
|---|---|
| `-b, --base <ref>` | Base revision (default `HEAD`) |
| `-H, --head <ref>` | Head revision, or `WORKING` for the uncommitted tree (default) |
| `-d, --depth <n>` | Caller hops to keep around changes (default 4) |
| `--full` | Emit the whole repo graph instead of the impacted subgraph |
| `--enrich [provider]` | Run enrichment inline (`heuristic`, `claude-code`, or `claude`) |

## Languages

TypeScript, TSX, JavaScript, Python, Java, Kotlin, Scala, C#, Go, Rust, C, C++, Swift, Ruby, and PHP. Run `npm run codelens -- languages` to see which file extensions each one claims.

For every language, CodeLens extracts:
- functions, methods, and constructors, with qualified names (`Billing.Service.run`)
- parameters, return types, `async`/`suspend`, and visibility
- doc comments and docstrings
- decorators, annotations, and attributes
- calls with their receivers, imports, and throw/raise/panic sites

Each language plugin also knows its ecosystem:
- how imports map to files (relative paths, Java packages, Go modules, Rust `crate::` paths, C `#include`)
- which code is visible without an import (same package or directory)
- test-file conventions
- route, test, and job annotations
- which packages count as databases, HTTP clients, queues, and other sinks

### Adding a language

Each language is one self-contained file in `packages/cli/src/lang/`, registered in `lang/index.ts`. A plugin is a `LanguageSpec` (`lang/spec.ts`) made of:

1. **A Tree-sitter query** that tags definitions and references with a small set of captures: `@fn` / `@fn.name`, `@scope` / `@scope.name` (classes), `@namespace`, `@call` / `@call.name` / `@call.receiver`, `@import` / `@import.source` / `@import.name`, and `@throw`. The language-agnostic engine (`lang/engine.ts`) does the rest. Calls are attributed to their innermost named function, so calls inside anonymous callbacks still count.
2. **Optional hooks** for things grammars disagree on, such as parameters, visibility, return types, or docstrings. Generic defaults cover most grammars.
3. **Ecosystem knowledge**: `resolveImport`, `selfNames`, `implicitThis`, `sameDirectoryVisible`, `testFile`, `sinks` (effectful packages), and `sinkCalls` (effectful calls that have no telltale import, like C's `fopen`).

The workflow:

```bash
# see the syntax tree (node types and field names) your query needs to match
node --liftoff-only packages/cli/scripts/ast.mjs <grammar> path/to/sample.ext
# add a fixture in packages/cli/test/fixtures/<lang>/ and a CASES entry in test/languages.test.ts
npm test
```

The test suite fails if a registered language has no fixture case. Any grammar bundled in `tree-sitter-wasms` can be used, including Dart, Elixir, Lua, OCaml, Zig, Solidity, Bash, and others.

## How it works

**Parsing** (`packages/cli/src/parse.ts`, `src/lang/`): Tree-sitter (WASM, via `web-tree-sitter@0.22` + `tree-sitter-wasms`) runs each language plugin's query over the file. Some grammars (Swift, Kotlin, C#) exhaust V8's optimizing WebAssembly compiler, so the CLI always runs Node with `--liftoff-only`. It relaunches itself with the flag if needed, and parsing is no slower.

**Graph** (`packages/cli/src/graph.ts`, `resolve.ts`): each changed file is parsed at both revisions, and functions are matched by qualified name to classify them as added, modified, or deleted. Calls are resolved by name, without type information, in this order:
1. the caller's own class (`this` / `self` / a Go receiver, or implicit `this` in Java, C#, and similar)
2. the same file
3. the same package
4. imported modules, packages, or classes, including `Class.staticMethod()` and `new Foo().bar()`
5. fields named after their class (`payments.charge()` → `Payments.charge`)
6. a globally unique name, as a last resort. This step never applies to method names every standard library has (`get`, `push`, `close`, …), because `map.get()` is far likelier than your one `get` method.

**TypeScript and JavaScript get type information on top.** The TypeScript compiler's checker resolves each call before name matching runs:
- **a function in the repo** → an exact edge (`typed`), even across `tsconfig` path aliases, `new Foo()` constructors, and dynamic `import()`;
- **a library or the standard library** (`map.get()`, `fs.readFile()`) → no edge, but the call still feeds effect detection;
- **unknown** (`any`, untyped JavaScript, an interface with several implementations) → falls back to the name-based rules above.

Reviews type-check the reviewed commit, not your working tree. On CodeLens itself, the checker resolves about 93% of calls: 930 into the repo and 3,193 to libraries, out of 4,452. It takes under a second. `--no-types` turns it off. Calls from tests and example apps don't count against a function being public API.

Calls outside any named function belong to a per-file **top level** pseudo-function. Examples are CLI wiring, `app.post('/x', …)` route registration, `test(...)` blocks, and `if __name__ == "__main__"`. In scripts, servers, and `bin/` files it counts as an entry point.

Low-confidence matches are marked as such. Calls to a function deleted in the diff become **dangling** edges. Graphology runs a reverse BFS outward from each change to compute caller depth and the transitive caller count.

**Enrichment** (`packages/cli/src/enrich.ts`, `claude.ts`):
- `heuristic` runs offline and is deterministic. It diffs signatures to find contract breaks (required params added or removed, type changes, sync↔async), flags protective constructs the diff removed as invariants at risk (null guards, validation calls, bounds checks, try/catch, locks), and scores blast radius from reach, exported surface, breaking changes, and dangling callers.
- `claude-code` runs `claude -p` with a JSON schema for each changed function. It uses your signed-in Claude Code subscription, so it needs no API key. Defaults to `--model opus`.
- `claude` sends each changed function to Claude Opus 5.5 (`claude-opus-5-5`), together with its callers, callees, and the heuristic findings. It uses structured outputs (Zod), server-side refusal fallback, and per-node fallback to the heuristic result on error. Pick another model with `--model`.
- `openai` talks to **any OpenAI-compatible API**: OpenAI, Azure OpenAI, OpenRouter, Together, Groq, or a local server (Ollama, LM Studio, llama.cpp, vLLM). It uses strict structured outputs where supported, and tolerates models that wrap JSON in prose. It retries rate limits and server errors. Requires `--model` (or `CODELENS_MODEL`), reads `OPENAI_API_KEY` and `OPENAI_BASE_URL`, or takes `--base-url`:
  ```bash
  OPENAI_API_KEY=sk-… npm run explore -- . -p openai -m gpt-4.1-mini
  npm run explore -- . -p openai -m llama3.1 --base-url http://localhost:11434/v1   # Ollama: nothing leaves your machine
  ```

**Descriptions** (`packages/cli/src/purpose.ts`): every function gets a *what / why*, written in batches of 10 per request. Files, modules, and systems are then summarized bottom-up from their members; a group with one child reuses that child's summary. Results are kept in the store by content hash, so re-runs only pay for new or edited code. Pass `--no-purpose` to skip this step. Without an LLM, descriptions fall back to doc comments and call context.

Providers implement the small `EnrichmentProvider` interface, so you can add OpenAI, local models, or anything else without touching the pipeline.

## Layout

```
packages/cli/src/lang   one plugin per language + the query engine
packages/cli/src        graph builders (graph.ts review, explore.ts explore, build.ts shared), call resolution,
                        snapshots (source.ts), the store (store.ts), enrichers, CLI (tsx, no build step)
packages/cli/test       per-language fixtures and end-to-end repo tests (npm test)
packages/web            Vite + React + @xyflow/react + dagre canvas
scripts/                demo repo generator
```

## Known limits (MVP)

- Call resolution is type-aware for TypeScript and JavaScript, and name-based for other languages. Dynamic dispatch, interfaces with many implementations, and same-named methods across classes can be missed there; these show as dotted "inferred" edges or are omitted. The next step is language servers for the other languages.
- Visibility for C#, Swift, and Kotlin is approximated by directory, since namespaces and modules can span directories.
- Renamed functions appear as one deletion plus one addition.
- Member calls (`obj.method()`) only resolve to methods, or to functions reached through a namespace import, so the tool never guesses across unrelated objects. Unresolved member calls feed sink detection instead.
- The impact map shows edges between adjacent hops only; the panel lists every caller and callee.
- The per-change risk analysis (`enrichNode`) is not cached yet; parses and descriptions are.
- A function's *why* is cached with its own source, so it can go stale when only its callers change.
- Large graphs (thousands of nodes) need the planned PixiJS renderer. React Flow is comfortable up to a few hundred.
