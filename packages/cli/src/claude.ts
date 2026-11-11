import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import type * as z from 'zod/v4';
import type { EnrichmentProvider, NodeContext } from './enrich.ts';
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
  GUIDE_SYSTEM,
  guidePrompt,
  GuideSchema,
  toGuide,
  BRIEF_SYSTEM,
  briefPrompt,
  BriefSchema,
  toBrief,
} from './prompts.ts';
import type { NodeEnrichment } from './types.ts';

export function claudeProvider(opts: { model?: string; effort?: 'low' | 'medium' | 'high' } = {}): EnrichmentProvider {
  const client = new Anthropic();
  const model = opts.model ?? 'claude-opus-5-5';
  const effort = opts.effort ?? 'medium';

  async function structured<S extends z.ZodType>(schema: S, system: string, content: string, level = effort): Promise<z.infer<S>> {
    const response = await client.beta.messages.parse({
      model,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: level, format: betaZodOutputFormat(schema) },
      system,
      messages: [{ role: 'user', content }],
    });
    if (response.stop_reason === 'refusal') throw new Error(`refused (${response.stop_details?.category ?? 'unknown'})`);
    if (!response.parsed_output) throw new Error(`no structured output (stop_reason=${response.stop_reason})`);
    return response.parsed_output as z.infer<S>;
  }

  return {
    name: `claude:${model}`,

    async enrichNode(ctx: NodeContext): Promise<NodeEnrichment> {
      return toEnrichment(ctx, await structured(NodeSchema, SYSTEM, renderContext(ctx)));
    },

    async summarize(graph, ranked) {
      const response = await client.beta.messages.create({
        model,
        max_tokens: 4000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort: 'low' },
        system: SUMMARY_SYSTEM,
        messages: [{ role: 'user', content: summaryPrompt(graph, ranked) }],
      });
      return response.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('').trim();
    },

    // Descriptions are short and high-volume: low effort keeps them fast and cheap.
    async describeFunctions(items) {
      return toPurposeMap(await structured(PurposeSchema, PURPOSE_SYSTEM, purposePrompt(items), 'low'));
    },

    async describeGroups(items) {
      return toGroupMap(await structured(GroupSchema, GROUP_SYSTEM, groupPrompt(items), 'low'));
    },

    async describeBrief(input) {
      return toBrief(await structured(BriefSchema, BRIEF_SYSTEM, briefPrompt(input)));
    },

    async describeGuide(input) {
      return toGuide(await structured(GuideSchema, GUIDE_SYSTEM, guidePrompt(input)));
    },

    async chat(req) {
      const response = await client.beta.messages.create({
        model,
        max_tokens: 8000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort: 'medium' },
        system: req.system,
        messages: req.messages,
      });
      return { text: response.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('').trim() };
    },
  };
}
