# CodeLens

Visual-first progressive code review. Instead of a line-by-line unified diff, CodeLens turns a git diff into an interactive review:

1. **Impact map**: one changed function at the center, upstream callers to the left, downstream callees and external effects (database, network, filesystem, …) to the right. A **Detail** control zooms out from Function → File → Module → System. Detail falls off with distance, so near neighbors stay specific and far ones fold into their file, module, or system.
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
| `−` / `+` | zoom detail out / in |
| `←` / `→` | previous / next change in review order |
| `1`–`3`, `Esc`, `Backspace` | switch tab, clear selection, go back |

## Analyze your own repo

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

## How it works

**Parsing** (`packages/cli/src/parse.ts`): Tree-sitter (WASM, via `web-tree-sitter@0.22` + `tree-sitter-wasms`) extracts functions, methods, and arrow functions, along with their signatures, call sites, `throw`/`raise` statements, and imports. Supported: TypeScript, TSX, JavaScript, Python.

**Graph** (`packages/cli/src/graph.ts`): each changed file is parsed at both revisions, and functions are matched by qualified name to classify them as added, modified, or deleted. Calls are resolved by name, preferring same class, then same file, then imported files, then a globally unique match. Low-confidence matches are marked as such. Calls to a function deleted in the diff become **dangling** edges. Graphology runs a reverse BFS outward from each change to compute caller depth and the transitive caller count.

**Enrichment** (`packages/cli/src/enrich.ts`, `claude.ts`):
- `heuristic` runs offline and is deterministic. It diffs signatures to find contract breaks (required params added or removed, type changes, sync↔async), flags protective constructs the diff removed as invariants at risk (null guards, validation calls, bounds checks, try/catch, locks), and scores blast radius from reach, exported surface, breaking changes, and dangling callers.
- `claude-code` runs `claude -p` with a JSON schema for each changed function. It uses your signed-in Claude Code subscription, so it needs no API key. Defaults to `--model opus`.
- `claude` sends each changed function to Claude Opus 5.5 (`claude-opus-5-5`), together with its callers, callees, and the heuristic findings. It uses structured outputs (Zod), server-side refusal fallback, and per-node fallback to the heuristic result on error. Pick another model with `--model`.

**Descriptions** (`packages/cli/src/purpose.ts`): every function gets a *what / why*, written in batches of 10 per request. Files, modules, and systems are then summarized bottom-up from their members; a group with one child reuses that child's summary. Results are cached by content hash in `~/.cache/codelens/`, so re-runs only pay for new or edited code. Pass `--no-purpose` to skip this step or `--cache <file>` to move the cache. Without an LLM, descriptions fall back to doc comments and call context.

Providers implement the small `EnrichmentProvider` interface, so you can add OpenAI, local models, or anything else without touching the pipeline.

## Layout

```
packages/cli   parser, graph builder, enrichers, CLI (tsx, no build step)
packages/web   Vite + React + @xyflow/react + dagre canvas
scripts/       demo repo generator
```

## Known limits (MVP)

- Call resolution is name-based, not type-based. Dynamic dispatch and same-named methods across classes can be missed; these show as dotted "inferred" edges or are omitted.
- Renamed functions appear as one deletion plus one addition.
- Member calls (`obj.method()`) only resolve to methods, or to functions reached through a namespace import, so the tool never guesses across unrelated objects. Unresolved member calls feed sink detection instead.
- The impact map shows edges between adjacent hops only; the panel lists every caller and callee.
- The per-change risk analysis (`enrichNode`) is not cached yet; descriptions are.
- Large graphs (thousands of nodes) need the planned PixiJS renderer. React Flow is comfortable up to a few hundred.
