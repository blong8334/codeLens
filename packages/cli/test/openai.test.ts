// The OpenAI-compatible provider against a fake chat-completions server: request shape, strict
// schemas, retries, lenient JSON parsing, and a full explore + describe + guide run through it.
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import * as z from 'zod/v4';
import { openaiProvider, parseJson, strictJsonSchema } from '../src/openai.ts';
import { describeGraph, heuristicDescriber } from '../src/purpose.ts';
import { buildGuide } from '../src/guide.ts';
import type { CodeGraph, FnNode } from '../src/types.ts';

interface Seen {
  auth?: string;
  body: { model: string; messages: { role: string; content: string }[]; response_format?: { json_schema: { name: string; schema: Record<string, unknown>; strict: boolean } } };
}
const seen: Seen[] = [];
let failNext = 0;
let fence = false;
let baseURL = '';

const read = (req: IncomingMessage) => new Promise<string>((r) => {
  let s = '';
  req.on('data', (d) => (s += d));
  req.on('end', () => r(s));
});

/** Answers like a model would: one item per bracketed id in the prompt. */
function answer(body: Seen['body']): unknown {
  const prompt = body.messages.at(-1)!.content;
  const ids = [...prompt.matchAll(/\[([a-z]\d+)\]/g)].map((m) => m[1]);
  switch (body.response_format?.json_schema.name) {
    case 'function_purposes':
      return { items: ids.map((id) => ({ id, what: `what ${id}`, why: `why ${id}` })) };
    case 'group_summaries':
      return { items: ids.map((id) => ({ id, summary: `group ${id}` })) };
    case 'package_guide':
      return { summary: 'A tiny shop.', architecture: ['orders and pricing'], startHere: [{ id: ids[0], reason: 'start' }] };
    default:
      return 'plain text';
  }
}

const server = createServer(async (req, res) => {
  const body = JSON.parse(await read(req)) as Seen['body'];
  seen.push({ auth: req.headers.authorization, body });
  if (failNext > 0) {
    failNext--;
    res.writeHead(429).end('slow down');
    return;
  }
  const json = JSON.stringify(answer(body));
  const content = fence ? `Here you go:\n\`\`\`json\n${json}\n\`\`\`` : json;
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { content } }] }));
});
before(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});
after(() => server.close());

function graph(): CodeGraph {
  const node = (name: string, file: string, entry?: FnNode['entry']): FnNode => ({
    id: `${file}#${name}`, name, qualifiedName: name, file, language: 'typescript', kind: 'function', exported: true,
    range: { startLine: 1, endLine: 3 }, signature: { params: [], async: false, text: `${name}()` }, status: 'unchanged',
    depth: null, downDepth: null, transitiveCallers: 0, source: `function ${name}() {}`, throws: [],
    groups: { file: `file:${file}`, module: 'module:shop::orders', system: 'system:shop' }, effects: [], entry,
  });
  const nodes = [node('placeOrder', 'orders/place.ts', { kind: 'route', reason: 'test' }), node('price', 'orders/price.ts'), node('save', 'orders/save.ts')];
  const files = nodes.map((n) => ({ id: n.groups.file, kind: 'file' as const, label: n.file.split('/')[1], path: n.file, parent: 'module:shop::orders', fnIds: [n.id], changed: 0, auto: true }));
  return {
    version: 2,
    meta: { mode: 'explore', repo: '/tmp/shop', base: 'abc', head: 'WORKING', generatedAt: '', stats: { filesParsed: 3, functions: 3, changedFunctions: 0, impactedFunctions: 0 } },
    nodes,
    edges: [{ id: 'e1', source: nodes[0].id, target: nodes[1].id, count: 1, confidence: 'high' }, { id: 'e2', source: nodes[0].id, target: nodes[2].id, count: 1, confidence: 'high' }],
    groups: [...files, { id: 'module:shop::orders', kind: 'module', label: 'orders', parent: 'system:shop', fnIds: nodes.map((n) => n.id), changed: 0, auto: true }, { id: 'system:shop', kind: 'system', label: 'shop', fnIds: nodes.map((n) => n.id), changed: 0, auto: true }],
    sinks: [],
    explore: { entries: [nodes[0].id], hotspots: [{ id: nodes[0].id, score: 5, fanIn: 0, fanOut: 2, modules: 1, reach: 0 }], snapshot: { commit: null, dirty: false } },
  };
}

test('openai: describes functions, groups and the guide through strict structured outputs', async () => {
  seen.length = 0;
  const provider = openaiProvider({ model: 'test-model', baseURL, apiKey: 'sk-test' });
  const g = graph();
  await describeGraph(g, provider, heuristicDescriber, { concurrency: 2, log: () => {} });
  assert.equal(g.nodes[0].purpose?.what, 'what f1');
  assert.equal(g.nodes[0].purpose?.source, 'llm');
  assert.match(g.groups.find((x) => x.kind === 'module')!.summary ?? '', /^group g\d$/);
  const guide = await buildGuide(g, provider, { log: () => {} });
  assert.equal(guide.source, 'llm');
  assert.equal(guide.summary, 'A tiny shop.');
  assert.equal(guide.startHere[0]?.id, g.nodes[0].id);

  const req = seen[0];
  assert.equal(req.auth, 'Bearer sk-test');
  assert.equal(req.body.model, 'test-model');
  assert.equal(req.body.messages[0].role, 'system');
  const fmt = req.body.response_format!.json_schema;
  assert.equal(fmt.strict, true);
  const item = ((fmt.schema.properties as Record<string, { items: Record<string, unknown> }>).items).items;
  assert.equal(item.additionalProperties, false);
  assert.deepEqual(item.required, ['id', 'what', 'why']);
});

test('openai: retries rate limits, tolerates fenced JSON, and needs no key for local servers', async () => {
  seen.length = 0;
  failNext = 2;
  fence = true;
  try {
    const provider = openaiProvider({ model: 'llama3.1', baseURL });
    const g = graph();
    const out = await provider.describeFunctions([{ key: 'f1', node: g.nodes[0], callers: [], callees: [] }]);
    assert.deepEqual(out.get('f1'), { what: 'what f1', why: 'why f1' });
    assert.equal(seen.length, 3, 'two 429s, then success');
    assert.equal(seen[0].auth, undefined);
  } finally {
    failNext = 0;
    fence = false;
  }
});

test('openai: clear errors for missing configuration', () => {
  const env = { ...process.env };
  delete process.env.CODELENS_MODEL;
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_BASE_URL;
  try {
    assert.throws(() => openaiProvider({}), /needs a model/);
    assert.throws(() => openaiProvider({ model: 'gpt-x' }), /OPENAI_API_KEY/);
    assert.doesNotThrow(() => openaiProvider({ model: 'llama3.1', baseURL: 'http://localhost:11434/v1' }));
  } finally {
    process.env = env;
  }
});

test('openai: helpers', () => {
  const s = strictJsonSchema(z.object({ a: z.string(), b: z.object({ c: z.number().optional() }) }));
  assert.equal(s.$schema, undefined);
  assert.deepEqual((s as { required: string[] }).required, ['a', 'b']);
  assert.deepEqual(((s.properties as Record<string, { required: string[] }>).b).required, ['c']);
  assert.deepEqual(parseJson('{"x":1}'), { x: 1 });
  assert.deepEqual(parseJson('Sure!\n```json\n{"x":2}\n```'), { x: 2 });
  assert.deepEqual(parseJson('The answer is {"x":3}. Hope that helps.'), { x: 3 });
});
