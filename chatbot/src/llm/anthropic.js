// Claude via the Anthropic Messages API (native tool use).
import Anthropic from '@anthropic-ai/sdk';

export class AnthropicProvider {
  constructor({ apiKey, baseURL, model, maxTokens, temperature }) {
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set');
    this.client = new Anthropic({ apiKey, baseURL });
    this.name = 'anthropic';
    Object.assign(this, { model, maxTokens, temperature });
  }

  userMessage(text) {
    return { role: 'user', content: text };
  }

  // A conversation may only be trimmed at a plain user message (not a tool_result).
  isTurnStart(msg) {
    return msg.role === 'user' && typeof msg.content === 'string';
  }

  /** One model call. Returns { text, toolCalls: [{id,name,args}], assistantMessage }. */
  async step({ system, messages, tools }) {
    const res = await this.client.messages.create({
      model: this.model,
      max_tokens: this.maxTokens,
      temperature: this.temperature,
      system,
      messages,
      tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })),
    });
    const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    const toolCalls = res.content.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, args: b.input ?? {} }));
    return { text, toolCalls, assistantMessage: { role: 'assistant', content: res.content }, usage: res.usage };
  }

  /** All tool results go back in one user message. */
  toolResultMessages(results) {
    return [{
      role: 'user',
      content: results.map((r) => ({ type: 'tool_result', tool_use_id: r.id, content: r.text, is_error: !r.ok })),
    }];
  }
}
