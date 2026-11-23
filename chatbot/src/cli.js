#!/usr/bin/env node
// Terminal chat. Type questions in plain English; /reset clears the conversation, /exit quits.
import readline from 'node:readline';
import { Agent } from './agent.js';
import { config } from './config.js';
import { createProviderSafe } from './llm/index.js';
import { connectMcp } from './mcp.js';

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = paint(2), cyan = paint(36), red = paint(31), bold = paint(1);

const { provider, warning: providerWarning } = createProviderSafe(config);
if (providerWarning) console.warn(providerWarning);
const mcp = await connectMcp();
const agent = new Agent({ provider, mcp, maxToolRounds: config.maxToolRounds, maxHistoryMessages: config.maxHistoryMessages });
const SESSION = 'cli';

console.log(bold('File chatbot') + dim(`  ·  ${provider.name} (${provider.model})  ·  /reset  /exit`));
if (provider.name === 'rules') console.log(dim('Offline rules mode: set ANTHROPIC_API_KEY, OPENAI_API_KEY or LLM_PROVIDER=ollama for a real LLM.'));

const rl = readline.createInterface({ input: process.stdin, terminal: process.stdin.isTTY });
const prompt = () => process.stdout.write(cyan('\nyou › '));
prompt();
for await (const line of rl) {
  const text = line.trim();
  if (!process.stdin.isTTY) process.stdout.write(text + '\n');
  if (!text) { prompt(); continue; }
  if (text === '/exit' || text === '/quit') break;
  if (text === '/reset') { agent.reset(SESSION); console.log(dim('Conversation cleared.')); prompt(); continue; }
  try {
    await agent.chat(SESSION, text, (e) => {
      if (e.type === 'tool_call') console.log(dim(`  ⚙ ${e.name}(${JSON.stringify(e.args)})`));
      if (e.type === 'tool_result' && !e.ok) console.log(red(`  ✗ ${e.preview.split('\n')[0]}`));
      if (e.type === 'answer') console.log('\n' + bold('bot › ') + e.text);
    });
  } catch (err) {
    console.log(red(`Error: ${err.message}`));
  }
  prompt();
}
rl.close();
await mcp.close().catch(() => {});
process.exit(0);
