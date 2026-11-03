import { spawn } from 'node:child_process';
import * as z from 'zod/v4';
import {
  GROUP_SYSTEM,
  groupPrompt,
  GroupSchema,
  NodeSchema,
  PURPOSE_SYSTEM,
  purposePrompt,
  PurposeSchema,
  renderContext,
  SUMMARY_SYSTEM,
  summaryPrompt,
  SYSTEM,
  toEnrichment,
  toGroupMap,
  toPurposeMap,
} from './prompts.ts';
import type { EnrichmentProvider } from './enrich.ts';

/**
 * Enrichment through the local Claude Code CLI (`claude -p`). Runs on the signed-in
 * Claude subscription, so no API key or API credits are needed. Good for local use;
 * CI should use the `claude` (API) provider.
 */
export function claudeCodeProvider(opts: { model?: string } = {}): EnrichmentProvider {
  const model = opts.model ?? 'opus';
  const nodeSchema = jsonSchema(NodeSchema);
  const purposeSchema = jsonSchema(PurposeSchema);
  const groupSchema = jsonSchema(GroupSchema);

  return {
    name: `claude-code:${model}`,

    async enrichNode(ctx) {
      const result = await runClaude({ model, system: SYSTEM, prompt: renderContext(ctx), jsonSchema: nodeSchema });
      return toEnrichment(ctx, NodeSchema.parse(result.structured_output));
    },

    async summarize(graph, ranked) {
      const result = await runClaude({ model, system: SUMMARY_SYSTEM, prompt: summaryPrompt(graph, ranked) });
      return String(result.result ?? '').trim();
    },

    async describeFunctions(items) {
      const result = await runClaude({ model, system: PURPOSE_SYSTEM, prompt: purposePrompt(items), jsonSchema: purposeSchema });
      return toPurposeMap(PurposeSchema.parse(result.structured_output));
    },

    async describeGroups(items) {
      const result = await runClaude({ model, system: GROUP_SYSTEM, prompt: groupPrompt(items), jsonSchema: groupSchema });
      return toGroupMap(GroupSchema.parse(result.structured_output));
    },
  };
}

/** Claude Code's validator rejects zod's draft-2020-12 `$schema` tag; the schema body is plain JSON Schema. */
function jsonSchema(schema: z.ZodType): string {
  const { $schema: _, ...body } = z.toJSONSchema(schema);
  return JSON.stringify(body);
}

interface ClaudeResult {
  is_error?: boolean;
  subtype?: string;
  result?: string;
  structured_output?: unknown;
}

function runClaude(opts: { model: string; system: string; prompt: string; jsonSchema?: string }): Promise<ClaudeResult> {
  const args = [
    '-p',
    '--output-format', 'json',
    '--model', opts.model,
    '--system-prompt', opts.system,
    // Pure analysis: everything the model needs is in the prompt.
    '--tools', '',
    '--no-session-persistence',
  ];
  if (opts.jsonSchema) args.push('--json-schema', opts.jsonSchema);

  return new Promise((resolve, reject) => {
    const child = spawn(process.env.CLAUDE_BIN ?? 'claude', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) =>
      reject((err as NodeJS.ErrnoException).code === 'ENOENT' ? new Error('`claude` CLI not found on PATH (install Claude Code or set CLAUDE_BIN)') : err),
    );
    child.on('close', (code) => {
      let parsed: ClaudeResult;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        return reject(new Error(`claude exited ${code}: ${(stderr || stdout).trim().slice(0, 300)}`));
      }
      if (parsed.is_error || parsed.subtype !== 'success') {
        return reject(new Error(`claude returned ${parsed.subtype ?? 'error'}: ${String(parsed.result ?? '').slice(0, 300)}`));
      }
      resolve(parsed);
    });
    child.stdin.end(opts.prompt);
  });
}
