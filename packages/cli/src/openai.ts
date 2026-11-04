// Any OpenAI-compatible chat completions API: OpenAI, Azure OpenAI, OpenRouter, Together, Groq,
// and local servers such as Ollama, LM Studio, llama.cpp and vLLM. Bring your own model and key.
import * as z from 'zod/v4';
import type { EnrichmentProvider } from './enrich.ts';
import {
  GROUP_SYSTEM,
  groupPrompt,
  GroupSchema,
  GUIDE_SYSTEM,
  guidePrompt,
  GuideSchema,
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
  toGuide,
  toPurposeMap,
} from './prompts.ts';

export interface OpenAIOptions {
  model?: string;
  /** Default: $OPENAI_BASE_URL, else https://api.openai.com/v1. Ollama: http://localhost:11434/v1. */
  baseURL?: string;
  /** Default: $OPENAI_API_KEY. Local servers usually need none. */
  apiKey?: string;
  /** Injected in tests. */
  fetch?: typeof fetch;
}

const RETRIES = 3;

export function openaiProvider(opts: OpenAIOptions = {}): EnrichmentProvider {
  const baseURL = (opts.baseURL ?? process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
  const apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY;
  const model = opts.model ?? process.env.CODELENS_MODEL;
  if (!model) throw new Error('the openai provider needs a model: pass --model (e.g. gpt-4.1-mini, or llama3.1 on Ollama) or set CODELENS_MODEL');
  const isOpenAI = /api\.openai\.com/.test(baseURL);
  if (isOpenAI && !apiKey) throw new Error('set OPENAI_API_KEY (or pass --base-url for a local server such as Ollama)');
  const doFetch = opts.fetch ?? fetch;

  async function complete(body: Record<string, unknown>): Promise<string> {
    let lastError: Error | undefined;
    for (let attempt = 0; attempt < RETRIES; attempt++) {
      const res = await doFetch(`${baseURL}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
        body: JSON.stringify({ model, ...body }),
      });
      if (res.ok) {
        const json = (await res.json()) as { choices?: { message?: { content?: string | null; refusal?: string | null } }[] };
        const message = json.choices?.[0]?.message;
        if (message?.refusal) throw new Error(`model refused: ${message.refusal}`);
        if (typeof message?.content !== 'string') throw new Error('response had no message content');
        return message.content;
      }
      const text = (await res.text()).slice(0, 300);
      lastError = new Error(`${baseURL} answered ${res.status}: ${text}`);
      // Rate limits and server errors are worth another try; anything else will not get better.
      if (res.status !== 429 && res.status < 500) break;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
    throw lastError!;
  }

  async function structured<S extends z.ZodType>(schema: S, name: string, system: string, content: string): Promise<z.infer<S>> {
    const text = await complete({
      messages: [
        { role: 'system', content: system },
        { role: 'user', content },
      ],
      response_format: { type: 'json_schema', json_schema: { name, schema: strictJsonSchema(schema), strict: true } },
    });
    return schema.parse(parseJson(text));
  }

  return {
    name: `openai:${model}`,
    async enrichNode(ctx) {
      return toEnrichment(ctx, await structured(NodeSchema, 'change_analysis', SYSTEM, renderContext(ctx)));
    },
    async summarize(graph, ranked) {
      const text = await complete({
        messages: [
          { role: 'system', content: SUMMARY_SYSTEM },
          { role: 'user', content: summaryPrompt(graph, ranked) },
        ],
      });
      return text.trim();
    },
    async describeFunctions(items) {
      return toPurposeMap(await structured(PurposeSchema, 'function_purposes', PURPOSE_SYSTEM, purposePrompt(items)));
    },
    async describeGroups(items) {
      return toGroupMap(await structured(GroupSchema, 'group_summaries', GROUP_SYSTEM, groupPrompt(items)));
    },
    async describeGuide(input) {
      return toGuide(await structured(GuideSchema, 'package_guide', GUIDE_SYSTEM, guidePrompt(input)));
    },
  };
}

/**
 * JSON Schema in the shape strict structured outputs require: every object closed
 * (`additionalProperties: false`) with every property listed as required.
 */
export function strictJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _, ...body } = z.toJSONSchema(schema) as Record<string, unknown>;
  const visit = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(visit);
    if (!node || typeof node !== 'object') return node;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) out[k] = visit(v);
    if (out.type === 'object' && out.properties && typeof out.properties === 'object') {
      out.additionalProperties = false;
      out.required = Object.keys(out.properties as object);
    }
    return out;
  };
  return visit(body) as Record<string, unknown>;
}

/** Models without strict JSON support sometimes wrap the object in prose or a code fence. */
export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    const candidate = fenced?.[1] ?? text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
    return JSON.parse(candidate);
  }
}
