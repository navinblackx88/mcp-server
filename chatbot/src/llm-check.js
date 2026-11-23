#!/usr/bin/env node
// Live check of the configured LLM: one real tool-calling round trip, no MCP server needed.
//   GEMINI_API_KEY=... npm run llm:check            (or ANTHROPIC_API_KEY / OPENAI_API_KEY)
// Passes when the model (1) calls the tool, (2) reads its result, (3) answers with it.
import { config } from './config.js';
import { createProvider } from './llm/index.js';

const SECRET = `blue-${Math.floor(1000 + Math.random() * 9000)}`;
const tools = [{
  name: 'get_secret_word',
  description: 'Returns the secret word of the day. Always call this to learn the secret word.',
  inputSchema: { $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', properties: { reason: { type: 'string', description: 'Why you need it' } } },
}];
const system = 'You are a test harness. Use the tool to find the secret word, then reply with exactly: The secret word is <word>.';

const ok = (s) => console.log(`  \x1b[32m✓\x1b[0m ${s}`);
const fail = (s) => { console.log(`  \x1b[31m✗\x1b[0m ${s}`); process.exitCode = 1; };

let provider;
try {
  provider = createProvider(config);
} catch (e) {
  console.log(`LLM check: ${config.provider}`);
  fail(e.message);
  process.exit(1);
}
console.log(`LLM check: ${provider.name} · model ${provider.model}${config.baseURL ? ` · ${config.baseURL}` : ''}`);
if (provider.name === 'rules') {
  fail('No LLM configured. Set GEMINI_API_KEY (or ANTHROPIC_API_KEY / OPENAI_API_KEY), or LLM_PROVIDER.');
  process.exit(1);
}

const messages = [provider.userMessage('What is the secret word of the day?')];
const t0 = Date.now();
try {
  const first = await provider.step({ system, messages, tools });
  messages.push(first.assistantMessage);
  const call = first.toolCalls.find((c) => c.name === 'get_secret_word');
  if (!call) {
    fail(`Model did not call the tool. It said: ${JSON.stringify(first.text).slice(0, 200)}`);
    process.exit(1);
  }
  ok(`Round 1: model called ${call.name}(${JSON.stringify(call.args)}) in ${Date.now() - t0} ms`);

  messages.push(...provider.toolResultMessages([{ id: call.id, name: call.name, ok: true, text: SECRET }]));
  const t1 = Date.now();
  const second = await provider.step({ system, messages, tools });
  if (second.toolCalls.length) fail(`Round 2: model called a tool again instead of answering (${second.toolCalls.map((c) => c.name)})`);
  else if (second.text.includes(SECRET)) ok(`Round 2: model used the tool result in ${Date.now() - t1} ms → "${second.text}"`);
  else fail(`Round 2: answer did not contain the tool result. It said: ${JSON.stringify(second.text).slice(0, 200)}`);

  const u = second.usage;
  if (u) console.log(`  tokens (last call): ${JSON.stringify(u)}`);
  console.log(process.exitCode ? '\nLLM check FAILED' : '\nLLM check passed: tool calling works end to end.');
} catch (e) {
  fail(`${e.status ? `HTTP ${e.status}: ` : ''}${e.message}`);
  console.log('\nLLM check FAILED');
  process.exit(1);
}
