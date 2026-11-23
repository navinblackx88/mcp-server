// Agent loop: user text -> LLM -> (tool calls via MCP -> results -> LLM)* -> answer.
// Keeps one conversation history per session id.
import { SYSTEM_PROMPT } from './config.js';

export class Agent {
  constructor({ provider, mcp, maxToolRounds = 8, maxHistoryMessages = 40 }) {
    Object.assign(this, { provider, mcp, maxToolRounds, maxHistoryMessages });
    this.sessions = new Map(); // id -> { messages, queue }
  }

  session(id) {
    if (!this.sessions.has(id)) this.sessions.set(id, { messages: [], queue: Promise.resolve(), updated: Date.now() });
    return this.sessions.get(id);
  }

  reset(id) { this.sessions.delete(id); }

  // Drop the oldest turns, always cutting at a user turn so tool calls/results stay paired.
  trim(messages) {
    if (messages.length <= this.maxHistoryMessages) return;
    let cut = messages.length - this.maxHistoryMessages;
    while (cut < messages.length && !this.provider.isTurnStart(messages[cut])) cut++;
    if (cut < messages.length) messages.splice(0, cut);
  }

  /**
   * Handle one user message. onEvent receives progress events:
   *   { type: 'tool_call', id, name, args }
   *   { type: 'tool_result', id, name, ok, preview }
   *   { type: 'answer', text, rounds }
   * Messages in the same session run one at a time.
   */
  chat(sessionId, userText, onEvent = () => {}) {
    const s = this.session(sessionId);
    const run = s.queue.then(() => this.#run(s, userText, onEvent));
    s.queue = run.catch(() => {});
    return run;
  }

  async #run(s, userText, onEvent) {
    s.updated = Date.now();
    const checkpoint = s.messages.length;
    s.messages.push(this.provider.userMessage(userText));
    try {
      for (let round = 0; round <= this.maxToolRounds; round++) {
        const lastRound = round === this.maxToolRounds;
        const res = await this.provider.step({
          system: SYSTEM_PROMPT + (lastRound ? '\n\nYou have used all tool calls for this message. Answer now with what you have.' : ''),
          messages: s.messages,
          tools: lastRound ? [] : this.mcp.tools,
        });
        s.messages.push(res.assistantMessage);

        if (!res.toolCalls.length || lastRound) {
          const text = res.text || '(no answer)';
          onEvent({ type: 'answer', text, rounds: round });
          this.trim(s.messages);
          return text;
        }

        // Run this round's tool calls in parallel.
        const results = await Promise.all(res.toolCalls.map(async (tc) => {
          onEvent({ type: 'tool_call', id: tc.id, name: tc.name, args: tc.args });
          const r = await this.mcp.call(tc.name, tc.args);
          onEvent({ type: 'tool_result', id: tc.id, name: tc.name, ok: r.ok, preview: r.text.slice(0, 400) });
          return { id: tc.id, name: tc.name, ...r };
        }));
        s.messages.push(...this.provider.toolResultMessages(results));
      }
    } catch (e) {
      // Roll back the failed turn so the history stays valid for the next message.
      s.messages.length = checkpoint;
      throw e;
    }
  }

  /** Remove sessions idle for longer than maxAgeMs. */
  prune(maxAgeMs = 6 * 60 * 60 * 1000) {
    const now = Date.now();
    for (const [id, s] of this.sessions) if (now - s.updated > maxAgeMs) this.sessions.delete(id);
  }
}
