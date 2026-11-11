import { spawn } from 'node:child_process';
import * as z from 'zod/v4';
import {
  GROUP_SYSTEM,
  groupPrompt,
  GroupSchema,
  GUIDE_SYSTEM,
  guidePrompt,
  GuideSchema,
  toGuide,
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
  BRIEF_SYSTEM,
  briefPrompt,
  BriefSchema,
  toBrief,
} from './prompts.ts';
import type { EnrichmentProvider } from './enrich.ts';
import type { ChatRequest } from './chat.ts';

/** Read-only file tools for chat: look around the codebase, change nothing, run nothing. */
const READ_TOOLS = 'Read,Grep,Glob';

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
  const guideSchema = jsonSchema(GuideSchema);
  const briefSchema = jsonSchema(BriefSchema);

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

    async describeBrief(input) {
      const result = await runClaude({ model, system: BRIEF_SYSTEM, prompt: briefPrompt(input), jsonSchema: briefSchema });
      return toBrief(BriefSchema.parse(result.structured_output));
    },

    async describeGuide(input) {
      const result = await runClaude({ model, system: GUIDE_SYSTEM, prompt: guidePrompt(input), jsonSchema: guideSchema });
      return toGuide(GuideSchema.parse(result.structured_output));
    },

    async chat(req: ChatRequest) {
      const last = req.messages[req.messages.length - 1]?.content ?? '';
      // A new conversation (or one whose session is gone) gets the transcript so far.
      const prompt = req.session || req.messages.length <= 1 ? last : req.messages.map((m) => `${m.role === 'user' ? 'Reviewer' : 'You'}: ${m.content}`).join('\n\n');
      const result = await runClaude({
        model,
        system: req.system,
        append: true,
        prompt,
        tools: req.cwd ? READ_TOOLS : '',
        cwd: req.cwd,
        resume: req.session,
        persist: true,
      });
      return { text: String(result.result ?? '').trim(), session: result.session_id };
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
  session_id?: string;
}

function runClaude(opts: {
  model: string;
  system: string;
  prompt: string;
  jsonSchema?: string;
  /** Add to Claude Code's own system prompt (keeps its tool use) instead of replacing it. */
  append?: boolean;
  /** Built-in tools to allow; '' (the default) for pure analysis, where everything is in the prompt. */
  tools?: string;
  cwd?: string;
  resume?: string;
  /** Keep the session, so a later call can resume it. */
  persist?: boolean;
}): Promise<ClaudeResult> {
  const tools = opts.tools ?? '';
  const args = [
    '-p',
    '--output-format', 'json',
    '--model', opts.model,
    opts.append ? '--append-system-prompt' : '--system-prompt', opts.system,
    '--tools', tools,
    // Only CodeLens's tools: none of the user's MCP servers.
    '--strict-mcp-config',
  ];
  if (tools) args.push('--allowedTools', tools);
  if (!opts.persist) args.push('--no-session-persistence');
  if (opts.resume) args.push('--resume', opts.resume);
  if (opts.jsonSchema) args.push('--json-schema', opts.jsonSchema);

  return new Promise((resolve, reject) => {
    const child = spawn(process.env.CLAUDE_BIN ?? 'claude', args, { cwd: opts.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
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
